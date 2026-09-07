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
    telemetry_init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("gateway configuration error: {e}");
            std::process::exit(2);
        }
    };

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

    let state = AppState {
        config: Arc::new(config.clone()),
        registry: registry.clone(),
        repo: Arc::new(GatewayRepo::new(db)),
        verifier: Arc::new(TokenVerifier::new(
            &config.clerk_issuer,
            match &config.jwks_file {
                Some(path) => VerifierSource::File(sync_gateway::auth::FileJwks::new(path)),
                None => {
                    VerifierSource::Http(sync_gateway::auth::HttpJwks::new(&config.clerk_issuer))
                }
            },
        )),
        draining: Arc::new(AtomicBool::new(false)),
        bus,
        gateway_id,
    };

    // Broker subscription task: cross-gateway events → local fanout.
    if let Some(broker) = broker_handle {
        let subscriber = sync_gateway::bus::NatsSubscriber::new(broker, registry.clone());
        tokio::spawn(async move {
            subscriber.run().await;
        });
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
    // grace window, then exit.
    let drain_state = state.clone();
    let shutdown = async move {
        let sig = wait_for_shutdown_signal().await;
        tracing::info!(signal = ?sig, "shutdown signal received");
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
}

fn telemetry_init() {
    let filter = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_owned());
    sync_gateway::telemetry::init(&filter);
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
