//! Gateway entrypoint. Thin by design: config → DB (fail-fast) →
//! migrations → state → serve with graceful-shutdown supervision
//! (P3-M008/M041). All protocol logic lives in the library.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use sync_gateway::auth::{TokenVerifier, VerifierSource};
use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::GatewayRepo;
use sync_gateway::http::{self, AppState};
use sync_gateway::sessions::SessionRegistry;
use sync_gateway::ws;

#[tokio::main]
async fn main() {
    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("gateway configuration error: {e}");
            std::process::exit(2);
        }
    };
    // P6-M009: optional OTel tracing. GATEWAY_OTEL_ENABLED=false (default)
    // leaves the pre-M009 fmt subscriber untouched. The handle flushes the
    // provider on Drop — held to the end of main so the SIGTERM graceful
    // shutdown path completes first, then spans flush on exit.
    let _otel_guard = otel_init(&config);
    telemetry_init();

    // Fail-fast DB startup + migrations (never start "maybe").
    let db = match Db::connect(&config).await {
        Ok(db) => db,
        Err(e) => {
            eprintln!("database startup failed: {e}");
            std::process::exit(3);
        }
    };
    if let Err(e) = run_migrations(&db).await {
        eprintln!("migration failed: {e}");
        std::process::exit(3);
    }
    // Maintenance gets its own pool handle: the scheduler shares the
    // same PostgreSQL pool (bounded), so snapshot folds never open an
    // unbounded connection set (DEC-038 policy).
    let maintenance_db = db.clone();

    let addr: SocketAddr = format!("{}:{}", config.bind_host, config.bind_port)
        .parse()
        .expect("bind host/port are validated by Config");

    // Distributed mode (P4-M011..M014): GATEWAY_NATS_URL set ⇒ connect the
    // broker (fail-soft: local clients still served — M019) + spawn the
    // subscription manager. Absent ⇒ Phase 3 single-gateway mode.
    let gateway_id = config.gateway_id;
    let registry = SessionRegistry::new();
    let (bus, broker_handle): (
        Arc<dyn sync_gateway::bus::EventPublisher>,
        Option<Arc<sync_gateway::broker::Broker>>,
    ) = match &config.nats_url {
        Some(url) => match sync_gateway::broker::Broker::connect(
            url,
            &config.nats_subject_prefix,
            gateway_id,
        )
        .await
        {
            Ok(broker) => {
                let broker = Arc::new(broker);
                (
                    Arc::new(sync_gateway::bus::NatsPublisher::new(
                        broker.clone(),
                        gateway_id,
                    )),
                    Some(broker),
                )
            }
            Err(e) => {
                tracing::warn!(error = %e, error_class = "broker", "NATS unavailable; running local-only (cross-gateway degraded)");
                (Arc::new(sync_gateway::bus::LocalOnlyPublisher), None)
            }
        },
        None => (Arc::new(sync_gateway::bus::LocalOnlyPublisher), None),
    };

    // Ephemeral tier (P4-M021..M024): Redis-backed when configured;
    // absence degrades to local rate limiting + disabled presence.
    let redis_handle = match &config.redis_url {
        Some(url) => {
            match sync_gateway::ephemeral::RedisHandle::connect(
                &sync_gateway::ephemeral::RedisConfig {
                    url: url.clone(),
                    namespace: config.nats_subject_prefix.clone(),
                },
            )
            .await
            {
                Ok(handle) => {
                    tracing::info!("redis ephemeral tier connected");
                    Some(handle)
                }
                Err(e) => {
                    tracing::warn!(error = %e, error_class = "redis", "redis unavailable; local rate limiting + presence disabled");
                    None
                }
            }
        }
        None => None,
    };
    let mut policies = sync_gateway::ephemeral::ratelimit::default_policies();
    policies
        .get_mut(sync_gateway::ephemeral::ratelimit::SCOPE_CONNECT)
        .expect("default connect policy exists")
        .max_events = config.connect_rate_per_min;
    let rate_limiter = Arc::new(sync_gateway::ephemeral::ratelimit::RateLimiter::new(
        redis_handle.clone(),
        policies,
    ));
    let presence = redis_handle.map(|handle| {
        Arc::new(sync_gateway::ephemeral::presence::PresenceStore::new(
            handle,
        ))
    });

    let state = AppState {
        config: Arc::new(config.clone()),
        registry: registry.clone(),
        repo: Arc::new(GatewayRepo::new(db)),
        verifier: Arc::new(
            TokenVerifier::new(
                &config.clerk_issuer,
                match &config.jwks_file {
                    Some(path) => VerifierSource::File(sync_gateway::auth::FileJwks::new(path)),
                    None => VerifierSource::Http(sync_gateway::auth::HttpJwks::new(
                        &config.clerk_issuer,
                    )),
                },
            )
            .with_claims_policy(
                config.clerk_audience.as_deref(),
                config.clerk_authorized_party.as_deref(),
            ),
        ),
        draining: Arc::new(AtomicBool::new(false)),
        bus,
        gateway_id,
        rate_limiter,
        presence,
    };

    // Broker subscription task: cross-gateway events → local fanout.
    if let Some(broker) = broker_handle {
        let subscriber = sync_gateway::bus::NatsSubscriber::new(broker, registry.clone());
        tokio::spawn(async move {
            subscriber.run().await;
        });
    }

    // Maintenance scheduler (P6 lifecycle-audit F-1 fix): with
    // GATEWAY_WORKER_BINARY set, this gateway claims and executes
    // snapshot/verify jobs (bounded workers, heartbeated leases, graceful
    // drain on shutdown). Absent ⇒ maintenance stays off (the Phase 5
    // test-driven posture), which keeps dev/E2E single-process runs
    // deterministic.
    let mut maintenance_stop: Option<tokio::sync::watch::Sender<bool>> = None;
    if let Some(worker_path) = &config.worker_binary {
        use sync_gateway::maintenance::{
            BoundedRunner, JobRepo, MaintenanceLimits, Scheduler, SnapshotPipeline,
        };
        let repo = GatewayRepo::new(maintenance_db.clone());
        let snapshots = sync_gateway::db::snapshots::SnapshotRepo::new(maintenance_db.clone());
        let workers =
            sync_gateway::worker::WorkerPool::new(worker_path.clone(), Duration::from_secs(600));
        let pipeline = Arc::new(SnapshotPipeline::new(repo.clone(), snapshots, workers));
        let limits = MaintenanceLimits::default();
        let scheduler = Arc::new(Scheduler::new(
            JobRepo::new(maintenance_db.clone()),
            pipeline,
            limits.clone(),
            gateway_id as i64,
        ));
        let (stop_tx, running_rx) = tokio::sync::watch::channel(true);
        let runner = BoundedRunner::new(scheduler, &limits, running_rx);
        tokio::spawn(async move {
            let executed = runner.run_bounded(None).await;
            tracing::info!(executed, "maintenance scheduler drained and stopped");
        });
        maintenance_stop = Some(stop_tx);
        tracing::info!(worker = %worker_path, "maintenance scheduler running (snapshots/verify jobs)");
    }

    let app = http::router(state.clone());
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("bind failed on {addr}: {e}");
            std::process::exit(1);
        });

    tracing::info!(%addr, "concord sync gateway listening");
    let server = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    );

    // Graceful shutdown (P3-M041): on SIGTERM/SIGINT stop accepting,
    // mark draining, notify connections, give in-flight work a bounded
    // grace window, then exit. The maintenance scheduler stops claiming
    // first (leases lapse if death is ungraceful; the sweep requeues).
    let drain_state = state.clone();
    let shutdown = async move {
        let sig = wait_for_shutdown_signal().await;
        tracing::info!(signal = ?sig, "shutdown signal received");
        // 0. Maintenance scheduler: stop claiming new jobs (in-flight
        //    workers are kill-on-drop; leases lapse → sweep requeues).
        if let Some(stop) = maintenance_stop.as_ref() {
            let _ = stop.send(false);
        }
        // 1. Stop accepting (axum stops serving when the future completes).
        // 2. Mark draining: new connections/auth/writes rejected.
        drain_state.draining.store(true, Ordering::SeqCst);
        // 3. Notify live connections (best-effort, bounded queues).
        ws::begin_drain(&drain_state.registry, 5000).await;
        // 4. Bounded grace for in-flight persistence.
        tokio::time::sleep(Duration::from_secs(2)).await;
    };

    if let Err(e) = server.with_graceful_shutdown(shutdown).await {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
    tracing::info!("gateway drained and stopped");
    // _otel_guard Drops here (end of main): P6-M009 clean shutdown — the
    // provider flushes buffered spans with a bounded timeout after the
    // graceful path completes. The explicit exit() calls above are all
    // pre-serve fail-fast paths (config/DB/bind) where nothing was traced.
}

fn telemetry_init() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_owned());
    sync_gateway::telemetry::init(&filter);
}

/// P6-M009: builds OTel options from config. `None` when disabled.
fn otel_options(config: &Config) -> Option<sync_gateway::observability::otel::OtelOptions> {
    if !config.otel_enabled {
        return None;
    }
    let exporter = match config.otel_exporter.as_str() {
        "stdout" => sync_gateway::observability::otel::Exporter::Stdout,
        "memory" => sync_gateway::observability::otel::Exporter::InMemory,
        _ => sync_gateway::observability::otel::Exporter::Otlp {
            endpoint: config.otel_endpoint.clone(),
        },
    };
    Some(sync_gateway::observability::otel::OtelOptions {
        exporter,
        sample_ratio: config.otel_sample_ratio,
    })
}

/// Initializes tracing with the optional OTel layer (M009).
fn otel_init(config: &Config) -> Option<sync_gateway::observability::otel::OtelHandle> {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_owned());
    sync_gateway::observability::otel::init_with_otel(&filter, otel_options(config).as_ref())
}

async fn wait_for_shutdown_signal() -> &'static str {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
    tokio::select! {
        _ = term.recv() => "SIGTERM",
        _ = int.recv() => "SIGINT",
    }
}
