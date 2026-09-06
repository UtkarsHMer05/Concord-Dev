//! Gateway entrypoint (P3-M008..M041). Thin by design; logic lives in the
//! library so integration tests can drive the same code.

use std::net::SocketAddr;

use sync_gateway::{config::Config, http, telemetry};

#[tokio::main]
async fn main() {
    telemetry::init("info");

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("gateway configuration error: {e}");
            std::process::exit(2);
        }
    };

    let addr: SocketAddr = format!("{}:{}", config.bind_host, config.bind_port)
        .parse()
        .expect("bind host/port are validated by Config");

    let app = http::router(config.clone());
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| {
            eprintln!("bind failed on {addr}: {e}");
            std::process::exit(1);
        });

    tracing::info!(%addr, "concord sync gateway listening");
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("server error: {e}");
        std::process::exit(1);
    }
}
