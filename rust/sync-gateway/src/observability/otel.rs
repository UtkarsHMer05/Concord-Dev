//! OpenTelemetry tracing foundations (P6-M009).
//!
//! OPTIONAL at runtime: nothing initializes unless
//! `GATEWAY_OTEL_ENABLED=true`. When disabled, there is zero behavior
//! change — no provider, no layer, no exporter, no background task.
//!
//! When enabled:
//! - an OTLP gRPC (tonic) exporter ships spans to
//!   `GATEWAY_OTEL_ENDPOINT` (default `http://127.0.0.1:4317`),
//! - sampling is parent-based with a configurable ratio
//!   (`GATEWAY_OTEL_SAMPLE_RATIO`, default 1.0 — local dev keeps
//!   everything),
//! - a `tracing_opentelemetry` layer is installed alongside the fmt
//!   layer so existing `tracing` callsites become spans,
//! - the provider shuts down cleanly on gateway SIGTERM/SIGINT: `main`
//!   holds the [`OtelHandle`] and its Drop runs after the graceful-
//!   shutdown path completes (bounded flush, never wedges exit).
//!
//! For tests, `GATEWAY_OTEL_EXPORTER=memory` uses the SDK's in-memory
//! exporter — exposed through [`test_in_memory_exporter`] so the
//! integration test asserts on finished spans without a collector.
//!
//! Cardinality rules enforced at every instrumented callsite:
//! - NEVER `document_id`/`user_id`/`connection_id` as span attributes.
//! - Op identity strings only when `GATEWAY_DEBUG_OP_IDS=true` (off by
//!   default).

use std::time::Duration;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::trace::SpanExporter;
use opentelemetry_sdk::trace::{Sampler, SdkTracerProvider};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Which exporter the provider uses (`GATEWAY_OTEL_EXPORTER`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exporter {
    /// OTLP gRPC to `GATEWAY_OTEL_ENDPOINT` (default).
    Otlp { endpoint: String },
    /// Human-readable spans on stdout (debugging without a collector).
    Stdout,
    /// SDK in-memory exporter — for the integration test only.
    InMemory,
}

/// Runtime options for the OTel layer (derived from `Config`).
#[derive(Debug, Clone)]
pub struct OtelOptions {
    pub exporter: Exporter,
    /// Parent-based sampling ratio [0.0, 1.0].
    pub sample_ratio: f64,
}

/// Owns the tracer provider: `Drop` (or [`OtelHandle::shutdown`])
/// flushes and shuts the provider down cleanly. `main` holds this
/// across the serve loop so the SIGTERM path flushes buffered spans.
pub struct OtelHandle {
    provider: SdkTracerProvider,
}

impl OtelHandle {
    /// Clean shutdown (bounded flush + provider shutdown). Blocking by
    /// design: the SDK's BatchSpanProcessor shutdown joins its dedicated
    /// background thread, so callers on an async runtime should run this
    /// via `spawn_blocking` (see `shutdown_blocking`). Never wedges: the
    /// flush is bounded to 3s regardless of collector health.
    pub fn shutdown(&self) {
        let _ = self.provider.shutdown_with_timeout(Duration::from_secs(3));
    }

    /// Async-runtime-safe wrapper: runs the blocking shutdown on the
    /// blocking pool (the SDK's own docs warn current-thread runtimes
    /// can deadlock if shutdown is called from the main thread).
    pub async fn shutdown_blocking(&self) {
        let provider = self.provider.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let _ = provider.shutdown_with_timeout(Duration::from_secs(3));
        })
        .await;
    }
}

impl Drop for OtelHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Test-visible handle to the in-memory exporter (shares the same
/// exporter instance the provider's batch processor writes to).
#[derive(Clone)]
pub struct InMemoryShared {
    inner: opentelemetry_sdk::trace::InMemorySpanExporter,
}

impl InMemoryShared {
    /// Finished spans so far. The batch processor's scheduled delay (or
    /// a provider force-flush) decides when spans land here.
    pub fn finished_spans(&self) -> Vec<opentelemetry_sdk::trace::SpanData> {
        self.inner.get_finished_spans().unwrap_or_default()
    }

    /// True when the exporter's shutdown ran (clean-shutdown proof).
    pub fn is_shutdown_called(&self) -> bool {
        self.inner.is_shutdown_called()
    }
}

static IN_MEMORY_EXPORTER: std::sync::OnceLock<Option<InMemoryShared>> = std::sync::OnceLock::new();

/// Returns the shared in-memory exporter handle when the provider was
/// built with `Exporter::InMemory` (tests only; None otherwise).
pub fn test_in_memory_exporter() -> Option<InMemoryShared> {
    IN_MEMORY_EXPORTER.get().and_then(|opt| opt.clone())
}

/// Builds the exporter instance for a spec. For `InMemory` the SAME
/// instance is shared with the test handle (the SDK exporter clones
/// share state) so finished spans are visible mid-run.
enum ExporterInstance {
    Otlp(Box<opentelemetry_otlp::SpanExporter>),
    Stdout(opentelemetry_stdout::SpanExporter),
    InMemory(opentelemetry_sdk::trace::InMemorySpanExporter),
}

impl std::fmt::Debug for ExporterInstance {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExporterInstance::Otlp(_) => f.write_str("Otlp"),
            ExporterInstance::Stdout(_) => f.write_str("Stdout"),
            ExporterInstance::InMemory(_) => f.write_str("InMemory"),
        }
    }
}

impl SpanExporter for ExporterInstance {
    async fn export(
        &self,
        batch: Vec<opentelemetry_sdk::trace::SpanData>,
    ) -> opentelemetry_sdk::error::OTelSdkResult {
        match self {
            ExporterInstance::Otlp(e) => e.export(batch).await,
            ExporterInstance::Stdout(e) => e.export(batch).await,
            ExporterInstance::InMemory(e) => e.export(batch).await,
        }
    }

    /// Forwards shutdown to the wrapped exporter (the default trait impl
    /// is a no-op — without this the batch worker's shutdown never
    /// reaches the real exporter, breaking the flush-on-SIGTERM contract).
    fn shutdown_with_timeout(&self, timeout: Duration) -> opentelemetry_sdk::error::OTelSdkResult {
        match self {
            ExporterInstance::Otlp(e) => e.shutdown_with_timeout(timeout),
            ExporterInstance::Stdout(e) => e.shutdown_with_timeout(timeout),
            ExporterInstance::InMemory(e) => e.shutdown_with_timeout(timeout),
        }
    }
}

/// Initializes the global tracing subscriber: fmt layer PLUS the
/// OpenTelemetry layer when `opts` is `Some`. Returns the handle the
/// caller must keep alive, or `None` when OTel is disabled (exactly the
/// pre-M009 subscriber).
///
/// Errors are logged-and-degraded, never fatal: observability must not
/// take the gateway down (mirrors the broker/redis fail-soft posture).
pub fn init_with_otel(default_filter: &str, opts: Option<&OtelOptions>) -> Option<OtelHandle> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default_filter));

    let Some(opts) = opts else {
        // Disabled: exactly the pre-M009 behavior.
        let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
        return None;
    };

    let exporter = match build_exporter(&opts.exporter) {
        Ok(e) => e,
        Err(e) => {
            // Degrade to fmt-only rather than failing startup.
            eprintln!("otel exporter init failed (running without otel): {e}");
            let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
            return None;
        }
    };

    // Parent-based sampling with the configured ratio (default 1.0).
    let sampler = Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(
        opts.sample_ratio.clamp(0.0, 1.0),
    )));

    let processor = opentelemetry_sdk::trace::BatchSpanProcessor::builder(exporter)
        .with_batch_config(
            opentelemetry_sdk::trace::BatchConfigBuilder::default()
                .with_scheduled_delay(Duration::from_millis(500))
                .with_max_queue_size(4096)
                .build(),
        )
        .build();

    let resource = opentelemetry_sdk::Resource::builder()
        .with_service_name("concord-sync-gateway")
        .build();

    let provider = SdkTracerProvider::builder()
        .with_span_processor(processor)
        .with_sampler(sampler)
        .with_resource(resource)
        .build();

    let tracer = provider.tracer("concord-sync-gateway");

    // fmt + otel layers on the registry. A second init in the same
    // process (tests) fails try_init — degrade to fmt behavior, the
    // spans then land in the existing subscriber.
    let result = tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer())
        .with(tracing_opentelemetry::layer().with_tracer(tracer))
        .try_init();
    if result.is_err() {
        eprintln!("otel layer not installed (global subscriber already set)");
    }

    let handle = OtelHandle { provider };
    Some(handle)
}

fn build_exporter(
    spec: &Exporter,
) -> Result<ExporterInstance, Box<dyn std::error::Error + Send + Sync>> {
    match spec {
        Exporter::Otlp { endpoint } => {
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_tonic()
                .with_endpoint(endpoint.clone())
                .with_timeout(Duration::from_secs(5))
                .build()?;
            Ok(ExporterInstance::Otlp(Box::new(exporter)))
        }
        Exporter::Stdout => Ok(ExporterInstance::Stdout(
            opentelemetry_stdout::SpanExporter::default(),
        )),
        Exporter::InMemory => {
            let inner = opentelemetry_sdk::trace::InMemorySpanExporterBuilder::new().build();
            // Share state with the test-facing handle BEFORE the
            // processor takes its clone.
            IN_MEMORY_EXPORTER
                .set(Some(InMemoryShared {
                    inner: inner.clone(),
                }))
                .ok();
            Ok(ExporterInstance::InMemory(inner))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_shape_is_configurable() {
        // Options shape only — the full subscriber init runs in the
        // integration test (a global subscriber can only init once
        // per process).
        let opts = OtelOptions {
            exporter: Exporter::Otlp {
                endpoint: "http://127.0.0.1:4317".into(),
            },
            sample_ratio: 1.0,
        };
        assert_eq!(opts.sample_ratio, 1.0);
        assert_eq!(
            opts.exporter,
            Exporter::Otlp {
                endpoint: "http://127.0.0.1:4317".into()
            }
        );
    }
}
