# Concord Observability (Phase 6 — P6-M008..M013)

How to see what the sync gateway is doing: structured logs with
end-to-end operation correlation, Prometheus metrics, optional
OpenTelemetry tracing, and provisioned Grafana dashboards.

## Starting everything

```bash
# 1. Infra (Postgres 5433, NATS 4222, Redis 6379)
docker compose up -d db nats redis

# 2. Observability stack (Prometheus 9090, Grafana 3000)
docker compose up -d prometheus grafana

# 3. Gateways on the host (release binary; scrape ports 8791/8792/8793)
cargo build --release -p sync-gateway          # from rust/
./scripts/gateway-cluster.sh start             # or see below for one gateway

# Single-gateway minimum (the one Prometheus needs):
env \
  GATEWAY_DATABASE_URL=postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test \
  GATEWAY_CLERK_ISSUER=https://fun-blowfish-5798.clerk.accounts.dev \
  GATEWAY_NATS_URL=nats://127.0.0.1:4222 \
  GATEWAY_REDIS_URL=redis://127.0.0.1:6379 \
  GATEWAY_ID=1 GATEWAY_BIND_PORT=8791 \
  ./rust/target/release/sync-gateway
```

- **Prometheus UI**: http://127.0.0.1:9090 (scrapes the 3 gateway ports
  + itself every 5s; config: `scripts/observability/prometheus.yml`)
- **Grafana**: http://127.0.0.1:3000 (anonymous Admin — LOCAL ONLY, the
  port is loopback-bound; never enable anonymous admin on shared hosts)
- **Gateway metrics**: `GET http://127.0.0.1:8791/metrics` (Prometheus
  text exposition), plus the legacy plain-text
  `GET /api/v1/metrics`

## Trace mental model (one operation, end to end)

```
browser ──WS──▶ gateway (ingress span, correlation id)
                  │ authz recheck (inside the ingest transaction)
                  │ PostgreSQL COMMIT (persist)
                  ├─ durable_ack ──▶ client            [p95 target < 25ms]
                  ├─ NATS publish (after commit, best-effort)
                  │      └─▶ peer gateway receive ──▶ local fanout ──▶
                  │           peer clients                          [p95 target < 100ms]
                  └─ local fanout to same-gateway peers
```

One client batch carries ONE correlation id the whole way:
`gw-<gateway_id>-batch-<batch_id>` — derived purely from protocol fields
(the client's `batch_id` and the serving gateway's numeric id). The peer
gateways reconstruct the SAME string from the broker event
(`origin_gateway` + `event_id == batch_id`), so a single log grep
follows one operation across every hop:

```bash
grep 'gw-1-batch-4242' /tmp/concord-gw*.log
```

What you will see (levels vary with RUST_LOG):

- `ws.ingress` span + `operation batch durably committed; ack emitted`
  (ingress + persist + ack milestones)
- `publishing committed batch to inter-gateway bus` (NATS publish)
- `broker event consumed` / `broker event fanned out to local room`
  (peer receive/fanout)
- `slow consumer disconnect`, `ingest denied by write-role recheck`,
  etc. (outcomes)

**Security rules baked into the pipeline**: correlation fields carry
ONLY ids, latencies, and outcome enums. Never JWTs (token fragments are
never logged — length only), never document content, never payload
bytes. Op identity strings (`replica:counter`) are safe durable keys
but stay OUT of span attributes unless `GATEWAY_DEBUG_OP_IDS=true`
(default off — keeps OTel attribute cardinality bounded).

## OpenTelemetry tracing (optional, default off)

```bash
GATEWAY_OTEL_ENABLED=true                 # zero behavior change when false
GATEWAY_OTEL_ENDPOINT=http://127.0.0.1:4317  # OTLP gRPC collector
GATEWAY_OTEL_SAMPLE_RATIO=1.0             # parent-based, ratio; 1.0 local
GATEWAY_OTEL_EXPORTER=otlp                # otlp | stdout | memory(tests)
```

When enabled, a `tracing_opentelemetry` layer ships the existing
`tracing` spans (ingress, authz, persist, ack, publish, broker
receive/fanout, catch-up replay, snapshot job, compaction, recovery
select, restore op) to the collector. The provider flushes with a
bounded timeout on gateway SIGTERM/SIGINT (after the graceful drain
completes). Spans carry bounded attributes only — never
document/user/connection ids as span attributes.

## Metric catalog

Every metric below answers a specific engineering question. Label
cardinality is audited by test (`observability_integration.rs`): label
values are ONLY the bounded enums listed; `le` is the fixed histogram
bucket axis. No metric is labeled by document/user/connection id.

### Connections
| Metric | Question it answers |
|---|---|
| `concord_active_connections` (gauge) | How many live sockets right now? |
| `concord_connections_accepted_total` | How many connections admitted past rate control? |
| `concord_reconnects_total` | How often are clients re-connecting? (churn) |

### Ingest path
| Metric | Question |
|---|---|
| `concord_ops_accepted_total` | How many ops durably committed? |
| `concord_ops_rejected_total{reason}` | Why are batches rejected? (reason ∈ malformed, invalid_state, authz, db_unavailable, draining, rate_limited) |
| `concord_ack_latency_seconds{stage=ingress\|persist}` (histogram) | Wire-to-ack latency: how slow is our ack promise? |
| `concord_db_write_latency_seconds{op=ingest_batch}` (histogram) | Is PostgreSQL the bottleneck? |
| `concord_db_errors_total` | Are writes failing at the DB layer? |
| `concord_auth_denials_total{reason}` | Who is being denied, and where in the flow? (join_access, write_role, snapshot_access) |
| `concord_malformed_frames_total{class}` | Hostile or buggy clients? (control, client_ops, client_ops_state) |
| `concord_rate_limit_hits_total{scope}` | Which limiter is firing? (connect, write, malformed, fetch) |

### Broker (NATS) & fanout
| Metric | Question |
|---|---|
| `concord_broker_publish_total{outcome}` | Are cross-gateway publishes succeeding? |
| `concord_broker_deliver_total{outcome}` | Are peer events consumed and fanned out? |
| `concord_broker_lag` (gauge) | Is any gateway falling behind (ack-pending)? |
| `concord_broker_redeliveries_total` | Is the consumer retrying (unhealthy consumption)? |
| `concord_slow_consumer_disconnects_total` | Which gateway has stalled outbound peers? |

### Durability & recovery
| Metric | Question |
|---|---|
| `concord_snapshot_duration_seconds{op=job}` (histogram) | How slow is the snapshot pipeline? |
| `concord_recovery_duration_seconds{op=select}` (histogram) | How fast is recovery snapshot selection? |
| `concord_compaction_duration_seconds{op=prune}` (histogram) | How long does op-log pruning take? |
| `concord_compaction_rows_total` / `concord_compaction_bytes_total` | How much history is being pruned? (both live: the batch CTE sums `octet_length(payload)` of exactly the rows each prune deletes) |
| `concord_worker_queue_depth` (gauge) | Maintenance jobs in flight (wired to scheduler claim execution — 1 while a job runs, 0 between) |
| `concord_catchup_duration_seconds{op=replay}` + `concord_catchup_size{op=replay}` | How slow/big are reconnect catch-ups? |

### Ephemeral tier (Redis)
| Metric | Question |
|---|---|
| `concord_redis_errors_total` | Is Redis degraded (rate limiting falling back)? |
| `concord_redis_latency_seconds{op=ratelimit_check}` | Is the ephemeral tier slow? |

### Queues
| Metric | Question |
|---|---|
| `concord_queue_depth{queue=conn_send}` | Outbound frame-queue pressure across live connections (sum of per-connection bounded channel depth; the protocol has ONE bounded channel per connection — there is no separate ingress/fanout/catchup queue, see known gaps) |

## Engineering test targets (NOT SLAs)

These are the Phase 6 test targets for the local 3-gateway topology —
aspirational numbers we aim to MEASURE, not service-level agreements:

| Target | Value | Status |
|---|---|---|
| Durable ack p95 (central workload) | < 25 ms | **MEASURED (Phase 6 campaign + P7 final-release rerun)**: 15.42 ms full-campaign / 13.19 ms final-release central cell — [BENCHMARKS.md](BENCHMARKS.md) §Phase 6 + §Phase 7 |
| 1→4 gateway p95 degradation | ≤ 30% | **MEASURED**: +6.9% (Phase 6 full campaign) / +15.5% absolute-~2ms band (final-release rerun, smaller base) — BENCHMARKS.md |
| Cross-gateway propagation p95 (ingress → peer client) | < 100 ms | TARGET — not measured (fanout p50 ≈ 2 ms was measured in Phase 4 as a baseline, not against this target) |
| Catch-up replay p95 @ 10k ops backlog | < 1 s | TARGET — not measured against the backlog shape (recovery-bench measured snapshot+tail 0.93 s @100k, a different shape — BENCHMARKS.md) |
| Queue depth steady-state (per connection channel) | < 50% of capacity | TARGET — not measured |
| DB write latency p95 | < 10 ms | TARGET — not measured (ingest microbench p50 2.72 ms is batch-level, not raw DB-write) |
| Broker lag steady-state | 0 (all acks immediate) | TARGET — not measured |

## Known gaps (deliberate, tracked)

- `concord_worker_queue_depth` is 0 between jobs and 1 while a claimed job
  runs: the maintenance scheduler is spawned in `main.rs` when
  `GATEWAY_WORKER_BINARY` is set (DEC-045, live-proven), and the gauge is
  wired to scheduler claim execution.
- `concord_queue_depth{queue}` only has the `conn_send` class: the
  protocol uses one bounded mpsc per connection; no separate
  ingress/fanout/catchup queues exist to measure.
- `concord_compaction_bytes_total` is live: each prune batch sums
  `octet_length(payload)` for exactly the rows it deletes (one round
  trip, in-transaction), so the counter reflects real reclaimed bytes.
- `concord_broker_lag` refreshes at most once per
  `CONSUMER_INFO_TTL` (30 s) — the per-message subscriber path reads
  the cached sample instead of issuing a JetStream metadata request
  per event; `consumer_info_fresh()` serves live probes.
- Redis latency is instrumented on the rate-limit path only (presence
  ops are fire-and-forget by design).

## Files

- `rust/sync-gateway/src/observability/` — metrics registry
  (`metrics.rs`), correlation ids (`correlation.rs`), OTel foundations
  (`otel.rs`)
- `rust/sync-gateway/src/telemetry.rs` — legacy counters + shared
  reason/outcome enums + the Prometheus mirror of DB write latency
- `scripts/observability/prometheus.yml` — scrape config (5s, 3
  gateways + self)
- `scripts/observability/grafana/` — datasource + dashboard
  provisioning and the three dashboard JSONs (Gateway Health, Durability
  & Recovery, Broker & Queues)
- `rust/sync-gateway/tests/observability_integration.rs` — correlation,
  log hygiene (no JWTs/content), OTel on/off, metrics + cardinality
  audit tests
