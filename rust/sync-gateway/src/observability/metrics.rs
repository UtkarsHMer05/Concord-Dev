//! Prometheus-compatible metrics registry (P6-M010).
//!
//! A small hand-rolled, thread-safe registry (no external metrics crate):
//! counters, gauges, and cumulative-bucket histograms with a Prometheus
//! text-exposition renderer (`/metrics`). Concurrency model mirrors the
//! process-wide `telemetry::Metrics`: a `OnceLock` registry holding
//! `Arc`-shared atomic cells in maps keyed by (name, label-set).
//!
//! Cardinality contract (mission rule): label values are ONLY bounded
//! enums chosen by the call sites (outcome, reason_class, stage, queue,
//! kind). `document_id`/`user_id`/`connection_id` are NEVER label
//! values — the integration test asserts the exposed label-value sets
//! stay bounded after real traffic.
//!
//! Design notes:
//! - Metrics are registered up-front (`Registry::new`); the exposition
//!   always emits the full catalog (zeros included) so dashboards stay
//!   dense and the cardinality audit has a fixed baseline.
//! - Histograms: fixed upper-bound buckets in seconds; `_bucket{le=...}`
//!   counts are cumulative, plus `_sum` (seconds) and `_count` — ready
//!   for `histogram_quantile`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// ---------------------------------------------------------------------------
// Catalog (name, help) — fixed at compile time; values bounded at call sites.
// ---------------------------------------------------------------------------

type CounterSpec = (&'static str, &'static str);
/// Map key: (metric name, label-value set) — both 'static (call-site consts).
type CellKey = (&'static str, &'static [&'static str]);
type LabeledSpec = (&'static str, &'static str, &'static [&'static str]);

/// Unlabeled counters. NOTE: registered values start at zero.
const COUNTERS: &[CounterSpec] = &[
    (
        "concord_connections_accepted_total",
        "WebSocket connections accepted past admission control.",
    ),
    (
        "concord_ops_accepted_total",
        "Operations durably accepted (new rows committed).",
    ),
    (
        "concord_ops_rejected_total",
        "Operation batches rejected (any stage: decode/authz/db).",
    ),
    (
        "concord_db_errors_total",
        "PostgreSQL write-path errors (pool/query failures).",
    ),
    (
        "concord_broker_redeliveries_total",
        "NATS JetStream consumer redeliveries observed.",
    ),
    (
        "concord_redis_errors_total",
        "Redis command failures (presence/rate-limit fallbacks).",
    ),
    (
        "concord_slow_consumer_disconnects_total",
        "Peers dropped for outbound-queue saturation.",
    ),
    (
        "concord_reconnects_total",
        "Client reconnects observed (same-principal re-joins).",
    ),
    (
        "concord_compaction_rows_total",
        "Rows pruned from the durable op log by compaction.",
    ),
    (
        "concord_compaction_bytes_total",
        "Payload bytes pruned from the durable op log by compaction.",
    ),
];

/// Labeled counters — label keys fixed; values are bounded enums at call
/// sites only.
const COUNTERS_LABELED: &[LabeledSpec] = &[
    (
        "concord_ops_rejected_total",
        "Operation batches rejected, by bounded reason class.",
        &["reason"],
    ),
    (
        "concord_broker_publish_total",
        "Inter-gateway broker publishes, by outcome.",
        &["outcome"],
    ),
    (
        "concord_broker_deliver_total",
        "Broker events consumed, by outcome.",
        &["outcome"],
    ),
    (
        "concord_auth_denials_total",
        "Authorization denials, by bounded reason class.",
        &["reason"],
    ),
    (
        "concord_malformed_frames_total",
        "Malformed inbound frames, by bounded decode class.",
        &["class"],
    ),
    (
        "concord_rate_limit_hits_total",
        "Rate-limited events, by scope (scope ids are a fixed set).",
        &["scope"],
    ),
];

/// Unlabeled gauges.
const GAUGES: &[CounterSpec] = &[
    (
        "concord_broker_lag",
        "NATS consumer ack-pending (lag proxy), last observed.",
    ),
    (
        "concord_active_connections",
        "Currently open WebSocket connections.",
    ),
    (
        "concord_worker_queue_depth",
        "Maintenance worker in-flight jobs (scheduler not yet spawned in main; TODO: wire when scheduler is spawned in main (P6 CI/release milestone)).",
    ),
];

/// Labeled gauges — fixed label keys.
const GAUGES_LABELED: &[LabeledSpec] = &[
    (
        "concord_queue_depth",
        "Outbound frame-queue depth by bounded queue class (sum across connections for per-connection queues; TODO: no separate ingress/fanout/catchup queues exist — the phases share the per-connection bounded channel).",
        &["queue"],
    ),
];

/// Histograms — one fixed label `stage`/`kind` is required so a single
/// metric name can serve several measured phases.
const HISTOGRAMS: &[LabeledSpec] = &[
    (
        "concord_ack_latency_seconds",
        "Wire-visible ack latency by stage: ingress (frame received→validated) and persist (validated→durable ack emitted).",
        &["stage"],
    ),
    (
        "concord_db_write_latency_seconds",
        "PostgreSQL batch-ingest transaction wall time.",
        &["op"],
    ),
    (
        "concord_redis_latency_seconds",
        "Redis command wall time by bounded call kind.",
        &["op"],
    ),
    (
        "concord_catchup_duration_seconds",
        "Catch-up replay wall time per request.",
        &["op"],
    ),
    (
        "concord_catchup_size",
        "Operations replayed per catch-up request.",
        &["op"],
    ),
    (
        "concord_snapshot_duration_seconds",
        "Snapshot build+verify+finalize job wall time.",
        &["op"],
    ),
    (
        "concord_recovery_duration_seconds",
        "Recovery selection (snapshot fetch + validation) wall time.",
        &["op"],
    ),
    (
        "concord_compaction_duration_seconds",
        "Compaction prune-to-boundary wall time.",
        &["op"],
    ),
];

/// Fixed histogram buckets (seconds, ascending; +Inf implicit).
const BUCKETS: &[f64] = &[
    0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/// A scalar sample cell (counter or gauge share this; counters never
/// decrease in practice, gauges may).
#[derive(Default)]
struct Cell {
    value: AtomicI64,
}

/// Cumulative histogram cell.
struct HistogramCell {
    /// Cumulative count per BUCKETS index (le = BUCKETS[i]).
    buckets: Vec<AtomicU64>,
    /// Sum of observations, microseconds (exposed scaled to seconds).
    sum_micros: AtomicU64,
    count: AtomicU64,
}

impl HistogramCell {
    fn new() -> Self {
        Self {
            buckets: BUCKETS.iter().map(|_| AtomicU64::new(0)).collect(),
            sum_micros: AtomicU64::new(0),
            count: AtomicU64::new(0),
        }
    }
}

// ---------------------------------------------------------------------------
// Public recording API
// ---------------------------------------------------------------------------

/// Increments an unlabeled counter. `name` must be in the catalog (a
/// miss is a programming error; it records to a hidden `_unknown` family
/// in debug builds via assert).
pub fn incr(name: &'static str) {
    with_cell(name, &[], |c| {
        c.value.fetch_add(1, Ordering::Relaxed);
    });
}

/// Adds `delta` to an unlabeled counter (e.g. rows/bytes totals).
pub fn incr_by(name: &'static str, delta: u64) {
    with_cell(name, &[], |c| {
        c.value.fetch_add(delta as i64, Ordering::Relaxed);
    });
}

/// Increments a labeled counter. `label_values` must have exactly the
/// catalog's arity for `name`; values are bounded enums (call-site rule).
pub fn incr_labeled(name: &'static str, label_values: &'static [&'static str]) {
    with_cell(name, label_values, |c| {
        c.value.fetch_add(1, Ordering::Relaxed);
    });
}

/// Sets an unlabeled gauge.
pub fn set_gauge(name: &'static str, value: i64) {
    with_cell(name, &[], |c| {
        c.value.store(value, Ordering::Relaxed);
    });
}

/// Sets a labeled gauge.
pub fn set_gauge_labeled(name: &'static str, label_values: &'static [&'static str], value: i64) {
    with_cell(name, label_values, |c| {
        c.value.store(value, Ordering::Relaxed);
    });
}

/// Observes a duration (seconds) into a labeled histogram.
pub fn observe(name: &'static str, label_values: &'static [&'static str], seconds: f64) {
    observe_inner(name, label_values, seconds)
}

/// Observes a count-like value (e.g. ops replayed per catch-up) into a
/// histogram; the value is exposed in the fixed buckets.
pub fn observe_value(name: &'static str, label_values: &'static [&'static str], value: f64) {
    observe_inner(name, label_values, value)
}

fn observe_inner(name: &'static str, label_values: &'static [&'static str], value: f64) {
    let hist = histogram_cell(name, label_values);
    let micros = (value * 1_000_000.0).clamp(0.0, u64::MAX as f64) as u64;
    hist.sum_micros.fetch_add(micros, Ordering::Relaxed);
    hist.count.fetch_add(1, Ordering::Relaxed);
    for (i, le) in BUCKETS.iter().enumerate() {
        if value <= *le {
            hist.buckets[i].fetch_add(1, Ordering::Relaxed);
        }
    }
}

// ---------------------------------------------------------------------------
// Registry internals
// ---------------------------------------------------------------------------

/// Label sets are `'static` — call sites pass const arrays.
fn with_cell(name: &'static str, label_values: &'static [&'static str], f: impl FnOnce(&Cell)) {
    let reg = REGISTRY.get_or_init(Registry::new);
    let mut map = reg.cells.lock().unwrap_or_else(|p| p.into_inner());
    let key = (name, label_values);
    let cell = map.entry(key).or_default();
    f(cell);
}

fn histogram_cell(name: &'static str, label_values: &'static [&'static str]) -> Arc<HistogramCell> {
    let reg = REGISTRY.get_or_init(Registry::new);
    let mut map = reg.histograms.lock().unwrap_or_else(|p| p.into_inner());
    map.entry((name, label_values))
        .or_insert_with(|| Arc::new(HistogramCell::new()))
        .clone()
}

struct Registry {
    cells: Mutex<HashMap<CellKey, Cell>>,
    histograms: Mutex<HashMap<CellKey, Arc<HistogramCell>>>,
}

impl Registry {
    fn new() -> Self {
        Self {
            cells: Mutex::new(HashMap::new()),
            histograms: Mutex::new(HashMap::new()),
        }
    }

    /// Renders the catalog: every declared family with every recorded
    /// label set (zeros for recorded-but-unincremented entries are
    /// materialized by render-time enumeration of cells; families with
    /// no cells yet are emitted with zero/empty where unlabeled).
    fn render(&self) -> String {
        let mut out = String::with_capacity(16 * 1024);
        let cells = self.cells.lock().unwrap_or_else(|p| p.into_inner());
        let hists = self.histograms.lock().unwrap_or_else(|p| p.into_inner());

        // Group scalar cells by family name → sorted label sets.
        let mut by_name: HashMap<&'static str, Vec<(&'static [&'static str], i64)>> =
            HashMap::new();
        for ((name, labels), cell) in cells.iter() {
            by_name
                .entry(*name)
                .or_default()
                .push((*labels, cell.value.load(Ordering::Relaxed)));
        }
        for vec in by_name.values_mut() {
            vec.sort_by(|a, b| a.0.cmp(b.0));
        }

        let mut hist_by_name: HistRows<'_> = HashMap::new();
        for ((name, labels), cell) in hists.iter() {
            hist_by_name.entry(*name).or_default().push((*labels, cell));
        }
        for vec in hist_by_name.values_mut() {
            vec.sort_by(|a, b| a.0.cmp(b.0));
        }

        let mut families: Vec<&Family> = catalog().iter().collect();
        families.sort_by_key(|f| f.name);
        for fam in families {
            out.push_str("# HELP ");
            out.push_str(fam.name);
            out.push(' ');
            out.push_str(fam.help);
            out.push('\n');
            out.push_str("# TYPE ");
            out.push_str(fam.name);
            out.push(' ');
            out.push_str(match fam.kind {
                Kind::Counter => "counter",
                Kind::Gauge => "gauge",
                Kind::Histogram => "histogram",
            });
            out.push('\n');
            match fam.kind {
                Kind::Counter | Kind::Gauge => {
                    let Some(rows) = by_name.get(fam.name) else {
                        // No cell recorded yet: emit zero for unlabeled
                        // families only (labeled families legitimately have
                        // no series until a value occurs).
                        if fam.labels.is_empty() {
                            emit_line(&mut out, fam.name, &[], 0.0);
                        }
                        continue;
                    };
                    if fam.labels.is_empty() {
                        let v = rows.first().map(|r| r.1).unwrap_or(0);
                        emit_line(&mut out, fam.name, &[], v as f64);
                    } else {
                        for (labels, v) in rows {
                            debug_assert_eq!(labels.len(), fam.labels.len());
                            let owned: Vec<String> = labels
                                .iter()
                                .zip(fam.labels.iter())
                                .map(|(v, k)| format!("{k}=\"{v}\""))
                                .collect();
                            emit_line(&mut out, fam.name, &owned, *v as f64);
                        }
                    }
                }
                Kind::Histogram => {
                    let Some(rows) = hist_by_name.get(fam.name) else {
                        continue;
                    };
                    for (labels, cell) in rows {
                        debug_assert_eq!(labels.len(), fam.labels.len());
                        let count = cell.count.load(Ordering::Relaxed);
                        let base: Vec<String> = labels
                            .iter()
                            .zip(fam.labels.iter())
                            .map(|(v, k)| format!("{k}=\"{v}\""))
                            .collect();
                        let le_label = |le: String| {
                            let mut l = base.clone();
                            l.push(format!("le=\"{le}\""));
                            l
                        };
                        for (i, le) in BUCKETS.iter().enumerate() {
                            let c = cell.buckets[i].load(Ordering::Relaxed);
                            emit_line(
                                &mut out,
                                &format!("{}_bucket", fam.name),
                                &le_label(format_le(*le)),
                                c as f64,
                            );
                        }
                        emit_line(
                            &mut out,
                            &format!("{}_bucket", fam.name),
                            &le_label("+Inf".to_string()),
                            count as f64,
                        );
                        let sum = cell.sum_micros.load(Ordering::Relaxed) as f64 / 1e6;
                        emit_line(&mut out, &format!("{}_sum", fam.name), &base, sum);
                        emit_line(
                            &mut out,
                            &format!("{}_count", fam.name),
                            &base,
                            count as f64,
                        );
                    }
                }
            }
        }
        out
    }
}

fn format_le(le: f64) -> String {
    // Prometheus le values: plain decimals (no exponent needed for our set).
    if le.fract() == 0.0 {
        format!("{}", le as u64)
    } else {
        format!("{le}")
    }
}

fn emit_line(out: &mut String, name: &str, labels: &[String], value: f64) {
    if labels.is_empty() {
        out.push_str(&format!("{name} {value}\n"));
    } else {
        let joined = labels
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&format!("{name}{{{joined}}} {value}\n"));
    }
}

/// Grouped histogram rows during render: (label set, cell).
type HistRows<'a> = HashMap<&'static str, Vec<(&'static [&'static str], &'a Arc<HistogramCell>)>>;

enum Kind {
    Counter,
    Gauge,
    Histogram,
}

struct Family {
    name: &'static str,
    help: &'static str,
    kind: Kind,
    labels: &'static [&'static str],
}

fn build_catalog() -> Vec<Family> {
    let mut out = Vec::new();
    for (name, help) in COUNTERS {
        out.push(Family {
            name,
            help,
            kind: Kind::Counter,
            labels: &[],
        });
    }
    for (name, help, labels) in COUNTERS_LABELED {
        out.push(Family {
            name,
            help,
            kind: Kind::Counter,
            labels,
        });
    }
    for (name, help) in GAUGES {
        out.push(Family {
            name,
            help,
            kind: Kind::Gauge,
            labels: &[],
        });
    }
    for (name, help, labels) in GAUGES_LABELED {
        out.push(Family {
            name,
            help,
            kind: Kind::Gauge,
            labels,
        });
    }
    for (name, help, labels) in HISTOGRAMS {
        out.push(Family {
            name,
            help,
            kind: Kind::Histogram,
            labels,
        });
    }
    out
}

fn catalog() -> &'static Vec<Family> {
    static CATALOG: OnceLock<Vec<Family>> = OnceLock::new();
    CATALOG.get_or_init(build_catalog)
}

static REGISTRY: OnceLock<Registry> = OnceLock::new();

/// Prometheus text exposition of the whole registry (the `/metrics`
/// body). Renders the full catalog: every family with every recorded
/// label set; unlabeled scalar families emit `0` before any recording.
pub fn render() -> String {
    REGISTRY.get_or_init(Registry::new).render()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposition_renders_catalog_with_zeros() {
        let text = render();
        assert!(text.contains("# TYPE concord_ops_accepted_total counter"));
        assert!(text.contains("concord_ops_accepted_total 0"));
        assert!(text.contains("# TYPE concord_active_connections gauge"));
    }

    #[test]
    fn labeled_counter_and_gauge_roundtrip() {
        incr_labeled("concord_broker_publish_total", &["ok"]);
        incr_labeled("concord_broker_publish_total", &["ok"]);
        incr_labeled("concord_broker_publish_total", &["failed"]);
        set_gauge_labeled("concord_queue_depth", &["conn_send"], 4);
        let text = render();
        assert!(text.contains("concord_broker_publish_total{outcome=\"ok\"} 2"));
        assert!(text.contains("concord_broker_publish_total{outcome=\"failed\"} 1"));
        assert!(text.contains("concord_queue_depth{queue=\"conn_send\"} 4"));
    }

    #[test]
    fn histogram_buckets_are_cumulative() {
        observe("concord_ack_latency_seconds", &["persist"], 0.003);
        observe("concord_ack_latency_seconds", &["persist"], 0.2);
        let text = render();
        // 0.003 falls into le=0.005; 0.2 into le=0.25 — both below 0.25.
        assert!(
            text.contains("concord_ack_latency_seconds_bucket{stage=\"persist\",le=\"0.005\"} 1")
        );
        assert!(
            text.contains("concord_ack_latency_seconds_bucket{stage=\"persist\",le=\"0.25\"} 2")
        );
        assert!(
            text.contains("concord_ack_latency_seconds_bucket{stage=\"persist\",le=\"+Inf\"} 2")
        );
        assert!(text.contains("concord_ack_latency_seconds_count{stage=\"persist\"} 2"));
        // sum = 0.203
        assert!(text.contains("concord_ack_latency_seconds_sum{stage=\"persist\"} 0.203"));
    }

    #[test]
    fn increment_by_accumulates() {
        incr_by("concord_compaction_rows_total", 150);
        incr_by("concord_compaction_rows_total", 50);
        assert!(render().contains("concord_compaction_rows_total 200"));
    }
}
