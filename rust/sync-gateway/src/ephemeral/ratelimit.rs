//! Distributed rate limiting with local fallback (P4-M023/M024; DEC-033).
//!
//! Semantics: fixed-window counters per (scope, principal) with a Redis
//! INCR + EXPIRE — simple, auditable, and cross-gateway by construction.
//! Redis loss ⇒ LOCAL per-gateway window (documented fail-open choice:
//! an abuser gets N×limits across N gateways during a Redis outage, but
//! durable correctness NEVER depends on the ephemeral tier). Redis
//! recovery resets global counters to zero (re-accumulating) — safe.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{EphemeralError, RedisHandle};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RateLimitOutcome {
    /// Within budget.
    Allowed,
    /// Over the global (Redis) or local (fallback) budget.
    Limited,
}

/// Policy for one scope: max events per window.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitPolicy {
    pub max_events: u64,
    pub window: Duration,
}

/// Standard scopes (P4-M023: connects, write ops, malformed frames,
/// reconnect abuse; P5-M045: snapshot fetch — a full-payload read +
/// hash + base64 serve per frame).
pub const SCOPE_CONNECT: &str = "connect";
pub const SCOPE_WRITE_OPS: &str = "write";
pub const SCOPE_MALFORMED: &str = "malformed";
pub const SCOPE_SNAPSHOT_FETCH: &str = "fetch";

pub fn default_policies() -> Policies {
    [
        (
            // Connects: a tab may open several sockets across reconnects
            // and reloads; operators scale via GATEWAY_RATE_CONNECT_PER_MIN.
            SCOPE_CONNECT,
            RateLimitPolicy {
                max_events: 240,
                window: Duration::from_secs(60),
            },
        ),
        (
            SCOPE_WRITE_OPS,
            RateLimitPolicy {
                max_events: 2_000,
                window: Duration::from_secs(60),
            },
        ),
        (
            SCOPE_MALFORMED,
            RateLimitPolicy {
                max_events: 50,
                window: Duration::from_secs(60),
            },
        ),
        (
            // Snapshot fetches (SEC5-1 fix): each served fetch is a
            // full-payload SELECT + SHA-256 over all stored bytes +
            // base64 + a ~4/3×-payload outbound frame — a read-
            // amplification primitive if unbounded. Resync flows
            // need a handful of fetches per session (signal → fetch →
            // optional retry after a transient error), never a
            // stream; 30/min/connection is far above legitimate use
            // while capping the amplification.
            SCOPE_SNAPSHOT_FETCH,
            RateLimitPolicy {
                max_events: 30,
                window: Duration::from_secs(60),
            },
        ),
    ]
    .into_iter()
    .collect()
}

pub type Policies = HashMap<&'static str, RateLimitPolicy>;

/// Cross-gateway rate limiter with local fallback (M024).
pub struct RateLimiter {
    redis: Option<RedisHandle>,
    policies: Policies,
    /// Local fallback state per (scope, principal): (window_start, count).
    local: Mutex<HashMap<(String, String), (u64, u64)>>,
    /// Metric hook: total limited events (local + global) for /metrics.
    pub limited_total: Arc<std::sync::atomic::AtomicU64>,
}

impl RateLimiter {
    pub fn new(redis: Option<RedisHandle>, policies: Policies) -> Self {
        Self {
            redis,
            policies,
            local: Mutex::new(HashMap::new()),
            limited_total: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    fn policy(&self, scope: &str) -> Option<RateLimitPolicy> {
        self.policies.get(scope).copied()
    }

    fn window_start(policy: RateLimitPolicy) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default();
        now.as_secs() - (now.as_secs() % policy.window.as_secs())
    }

    /// Checks one event against the budget. Redis INCR(+EXPIRE) is the
    /// global counter; ANY Redis error falls back to the local window —
    /// never an error to the caller (availability over strictness).
    pub async fn check(&self, scope: &str, principal: &str) -> RateLimitOutcome {
        let Some(policy) = self.policy(scope) else {
            return RateLimitOutcome::Allowed; // no policy configured
        };
        if let Some(redis) = &self.redis {
            let key = redis.namespaced(&format!("rlim:{scope}:{principal}"));
            let mut conn = redis.manager();
            let start = Self::window_start(policy);
            let key = format!("{key}:{start}");
            let outcome = tokio::time::timeout(Duration::from_secs(1), async {
                let count: u64 = redis::cmd("INCR")
                    .arg(&key)
                    .query_async(&mut conn)
                    .await
                    .map_err(|_| EphemeralError::Operation)?;
                if count == 1 {
                    let _: () = redis::cmd("EXPIRE")
                        .arg(&key)
                        .arg(policy.window.as_secs() as i64)
                        .query_async(&mut conn)
                        .await
                        .map_err(|_| EphemeralError::Operation)?;
                }
                Ok::<u64, EphemeralError>(count)
            })
            .await;
            if let Ok(Ok(count)) = outcome {
                if count > policy.max_events {
                    self.limited_total
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    return RateLimitOutcome::Limited;
                }
                return RateLimitOutcome::Allowed;
            }
            // Redis degraded → local fallback (M024).
        }
        self.check_local(scope, principal, policy)
    }

    fn check_local(
        &self,
        scope: &str,
        principal: &str,
        policy: RateLimitPolicy,
    ) -> RateLimitOutcome {
        let start = Self::window_start(policy);
        let mut local = self.local.lock().unwrap_or_else(|p| p.into_inner());
        let entry = local
            .entry((scope.to_owned(), principal.to_owned()))
            .or_insert((start, 0));
        if entry.0 != start {
            *entry = (start, 0); // new window
        }
        entry.1 += 1;
        if entry.1 > policy.max_events {
            self.limited_total
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            RateLimitOutcome::Limited
        } else {
            RateLimitOutcome::Allowed
        }
    }
}

/// Overrides the connect budget from GATEWAY_RATE_CONNECT_PER_MIN;
/// absent or invalid keeps the default.
pub fn policies_with_env_connect(mut policies: Policies) -> Policies {
    if let Ok(raw) = std::env::var("GATEWAY_RATE_CONNECT_PER_MIN") {
        if let Ok(max) = raw.parse::<u64>() {
            if let Some(policy) = policies.get_mut(SCOPE_CONNECT) {
                policy.max_events = max;
            }
        }
    }
    policies
}
