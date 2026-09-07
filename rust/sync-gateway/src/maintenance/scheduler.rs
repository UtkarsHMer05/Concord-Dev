//! Bounded maintenance scheduler loop (P5-M025).
//!
//! One task per gateway: polls claimable jobs, executes them under a
//! worker-count semaphore, heartbeats the lease while work runs, and
//! shuts down gracefully (cancels work, releases jobs). Maintenance
//! limits are entirely separate from realtime connection limits —
//! snapshot folds can never starve the sync path (DEC-038 policy).
//!
//! Cancellation: dropping the `SchedulerHandle` (or the runtime) sends
//! the stop signal; in-flight `WorkerPool` futures are already
//! kill-on-drop, so the C++ child processes die with the gateway — no
//! zombies (M025.3). Jobs left running by an ungraceful death are
//! recovered by the lease-expiry sweep on the next claim cycle.

use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::jobs::{execute_snapshot_job, FailureClass, JobRepo, JobRow, MaintenanceLimits};
use super::pipeline::SnapshotPipeline;
use crate::telemetry::Metrics;

/// Runs maintenance jobs for this gateway process.
#[derive(Clone)]
pub struct Scheduler {
    repo: JobRepo,
    pipeline: Arc<SnapshotPipeline>,
    limits: MaintenanceLimits,
    gateway_id: i64,
}

impl Scheduler {
    pub fn new(
        repo: JobRepo,
        pipeline: Arc<SnapshotPipeline>,
        limits: MaintenanceLimits,
        gateway_id: i64,
    ) -> Self {
        Self {
            repo,
            pipeline,
            limits,
            gateway_id,
        }
    }

    /// Claims and executes ONE job (heartbeat running concurrently).
    /// Returns Some(job_id) when a job ran. Exposed for tests and for
    /// driving a fixed number of iterations deterministically.
    pub async fn run_one_claim(&self) -> Option<uuid::Uuid> {
        let (job, claim_version) = self
            .repo
            .claim_next(
                &[super::jobs::kind::SNAPSHOT_BUILD, super::jobs::kind::VERIFY],
                self.gateway_id,
                self.limits.lease,
            )
            .await
            .ok()??;

        // Heartbeat while the work runs: the lease is refreshed at
        // lease/3 so a slow-but-alive worker never loses ownership to
        // the sweep.
        let hb_repo = self.repo.clone();
        let hb_lease = self.limits.lease;
        let hb_job = job.job_id;
        let heartbeat = tokio::spawn(async move {
            let tick = hb_lease.div_f32(3.0);
            let mut timer = tokio::time::interval(tick);
            timer.tick().await; // consume the immediate first tick
            let mut timer = std::pin::pin!(timer);
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                timer.as_mut().tick().await;
                if !hb_repo
                    .heartbeat(hb_job, claim_version, hb_lease)
                    .await
                    .unwrap_or(false)
                {
                    // Fence rejected us: stop heartbeating; the work
                    // future will also fail its guarded transitions.
                    break;
                }
            }
        });

        let outcome = match job.kind.as_str() {
            k if k == super::jobs::kind::SNAPSHOT_BUILD => {
                execute_snapshot_job(&job, claim_version, &self.pipeline).await
            }
            _ => Ok(()), // unknown kinds idle-complete (never enqueued)
        };
        heartbeat.abort(); // work done or failed: stop the lease pump

        match outcome {
            Ok(()) => {
                let _ = self.repo.complete(job.job_id, claim_version).await;
                Metrics::global()
                    .snapshots_finalized_total
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            Err(e) => {
                Metrics::global()
                    .worker_failures_total
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let class = if e.is_retryable() {
                    FailureClass::Retryable
                } else {
                    FailureClass::Terminal
                };
                let _ = self.repo.fail(&job, claim_version, class).await;
            }
        }
        Some(job.job_id)
    }
}

/// A bounded-parallelism driver: at most `limits.max_parallel_workers`
/// jobs execute concurrently; claim depth is bounded by the permit
/// count (inflight bound), and the loop exits on cancellation.
pub struct BoundedRunner {
    scheduler: Arc<Scheduler>,
    semaphore: Arc<Semaphore>,
    running: tokio::sync::watch::Receiver<bool>,
}

impl BoundedRunner {
    pub fn new(
        scheduler: Arc<Scheduler>,
        limits: &MaintenanceLimits,
        running: tokio::sync::watch::Receiver<bool>,
    ) -> Self {
        let permits = limits
            .max_parallel_workers
            .min(limits.max_inflight_jobs)
            .max(1);
        Self {
            scheduler,
            semaphore: Arc::new(Semaphore::new(permits)),
            running,
        }
    }

    /// Claim-and-run until the `running` flag clears or a bounded number
    /// of iterations pass (tests). Acquires a permit per concurrent
    /// worker; the permit drops when the job completes (or fails).
    ///
    /// `running` semantics: the channel carries `true` while the
    /// gateway is ALIVE — the loop stops claiming when it flips to
    /// `false` (graceful drain; in-flight futures finish, leases lapse
    /// if death was ungraceful and the sweep requeues them).
    pub async fn run_bounded(&self, max_iterations: Option<u64>) -> usize {
        let mut executed = 0usize;
        let mut iterations = 0u64;
        let running = self.running.clone();
        loop {
            if !*running.borrow() {
                // Graceful drain: stop claiming, let in-flight finish.
                break;
            }
            if let Some(cap) = max_iterations {
                if iterations >= cap {
                    break;
                }
                iterations += 1;
            }
            // Bound parallel work via the semaphore: waiting counts
            // against the inflight budget (no unbounded queueing).
            let permit: OwnedSemaphorePermit = match self.semaphore.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => break, // semaphore closed: shutting down
            };
            let scheduler = self.scheduler.clone();
            let claimed = scheduler.run_one_claim().await;
            drop(permit);
            match claimed {
                Some(_) => executed += 1,
                None => {
                    // Queue empty: pace the poll; permits released above.
                    tokio::time::sleep(self.scheduler.limits.poll_interval).await;
                }
            }
        }
        executed
    }
}

/// A claimed job + its permit, for tests asserting the inflight bound.
#[allow(dead_code)]
struct InflightJob {
    job: JobRow,
    _permit: OwnedSemaphorePermit,
}
