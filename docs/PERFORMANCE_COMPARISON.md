# Reproducible editor performance comparison

Run the complete browser campaign with:

```bash
npm run bench:compare
```

The command builds the native recovery worker and Rust release gateway,
bundles the stock browser worker, starts the existing isolated production
browser stack, measures Concord and Yjs in Chromium, and writes raw results,
a CSV summary, a standalone SVG chart, and an interactive HTML report. It
then measures the actual authenticated Concord application separately.

The default is **three measured runs and one excluded warmup per engine and
workload**. Engine order alternates between cells and rounds. Every cell uses
fresh browser contexts, and every timing run must pass correctness checks.
No result is discarded because it is slower than expected.

See the [recorded acceptance report](audits/PERFORMANCE_COMPARISON_REPORT.md)
for the complete published campaign and its costs. The
[interactive report](assets/performance/report.html) and
[raw results](assets/performance/raw.json) can be downloaded together with
their companion files and opened locally.

## Prerequisites

- Node 24, `npm ci`, and Chromium (`npx playwright install chromium`). On a
  Linux host, `npx playwright install --with-deps chromium` also installs its
  operating-system dependencies.
- Docker Compose's local PostgreSQL, NATS, and Redis services:
  `docker compose up -d db nats redis`.
- CMake, Ninja, a C++20 compiler, and the Rust toolchain. Public WASM assets
  are checked in; Emscripten is needed only to rebuild those assets after a
  native engine change.
- Development Clerk settings in `.env.local` for the production-app lane:
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. The existing
  [authenticated browser harness](TESTING.md) provisions disposable test
  users. It uses real Clerk tickets and gateway HTTPS JWKS verification.

On macOS with Command Line Tools installed separately from Xcode, use:

```bash
DEVELOPER_DIR=/Library/Developer/CommandLineTools npm run bench:compare
```

The authenticated harness recreates **only `concord_e2e`**, as its existing
browser tests do. The comparison creates a random `bench_*` schema inside
that database and removes it at completion. Test identities and spawned
servers are cleaned up by the harness. An interrupted run retains partial
raw evidence; its result remains `incomplete`.

## What is compared

The controlled comparison uses the same TipTap/ProseMirror editor schema,
viewport, user edits, transport, and PostgreSQL instance for both engines:

The paired editor viewport is 1,280 × 900; the actual-app viewport is
1,440 × 1,000. Chromium runs headless and unthrottled by default. `--headed`
changes the mode and records it in the environment.

| Part | Concord | Yjs |
|---|---|---|
| Editor binding | Production `CrdtEditorBridge` | Official `ySyncPlugin` from `y-prosemirror` |
| Engine | Production C++/WASM in the stock dedicated worker | Yjs `Y.Doc` with `Y.XmlFragment` |
| Local persistence | Stock worker IndexedDB operation log | IndexedDB binary-update log |
| Retry outbox | Shared benchmark IndexedDB outbox | The same outbox |
| Server persistence | Binary batches in the shared PostgreSQL sink | The same sink |
| ACK | After transaction commit with `synchronous_commit=on` | The same commit boundary |
| Peer integration | Stock bridge's remote-apply/render path | Official binding's remote integration |
| History retention | All binary batches retained | All binary batches retained |

The shared server uses a per-document PostgreSQL advisory lock **before
sequence assignment**, so concurrent commit order cannot make catch-up skip
an earlier transaction. Batch UUIDs are retry identities; a retry with
different document, engine, or payload fails. Peer polling is fixed at 50 ms
for both engines. There is no compaction in this controlled comparison.

This is an **editor/engine comparison under a common persistence contract**.
It is not a comparison between the complete Concord deployment and a Yjs
deployment. The separate production lane includes Concord's Next.js app,
Clerk, Rust gateway, native recovery worker, PostgreSQL, NATS, and Redis.
Its results are presented separately and are not used to rank Yjs.

The production lane retains the gateway's default **2,000 canonical
operations per connection per minute** write policy. A large paste generates
many Concord operations and can meet that limit. The actual-app raw results
record these `rate_limited` responses; reconnect/retry costs remain in its
timings. The final ACK triggers a silent durable catch-up, so retained ACK
records and a prior sync error clear only after cursor coverage is persisted.

Yjs and its binding are exact development dependencies: **Yjs 13.6.33** and
**y-prosemirror 1.3.7**. `package-lock.json` pins the full dependency tree.
The binding follows the [official Yjs editor documentation](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror)
and [maintainer's binding API](https://github.com/yjs/y-prosemirror).

## Shared edits and workloads

The shared subset is one paragraph of ASCII text with bold and italic marks.
ASCII gives both engines identical ProseMirror offsets. Lists, links, images,
tables, comments, permissions, presence, and review branches are outside the
paired workload. Their absence does not change Concord's product support.

| Workload | Full profile |
|---|---|
| Append typing | 40 actual keyboard inputs, starting with 2,048 characters |
| Middle edits | 40 single-character insertions at PM position 32 |
| Large paste | Four pastes of 4,224 characters each |
| Deletes | 40 removals of two characters |
| Formatting | 40 bold/italic toggles on specified eight-character ranges |
| Contested document | Four writers, 40 uniquely identified text insertions each, one document |
| Independent documents | Eight writers, eight documents, 40 inserts per document |
| Offline backlog | 10,000 starting characters, 250 local edits during at least 60 seconds disconnected, plus an online peer edit |

Initial text and every measured edit are saved in the raw file. The paired
offline lane also appends `[peer changed while writer was offline]` from the
online peer; the production lane appends
`[online peer changed during offline typing]`. A SHA-256 workload
checksum must match across the engines for each cell and round. The units
are **user edits**, never equivalent counts of internal CRDT operations.

Each writer waits for an edit's local durability and online acknowledgement
before sending its next edit. Offline writers wait only for local durability.
The contested and independent workloads run those writers concurrently.
These are latency measurements with one edit in flight per writer, not a
fixed-rate typing load or a maximum-throughput test.

Text and formatting must match the reference after sequential edits.
Independent documents are checked individually. Contested insert ordering
may differ between engines; that cell checks every unique inserted token
exactly once and exact peer convergence within each engine. Offline recovery
must retain the complete local text in order and the peer's insertion. Every
cell must reproduce its final rich-text state after a page reload.

## Measurement definitions

| Metric | Boundary |
|---|---|
| Typing/render latency | Actual keyboard `beforeinput` to the second `requestAnimationFrame`; other edits start immediately before the PM command |
| Local durability | Edit start through bridge/binding, engine work, and local IndexedDB writes |
| Server acknowledgement | Edit start through local durability and the shared PostgreSQL transaction's committed response |
| Reconnect | Network restored through pending uploads, peer catch-up, matching states, and rendering |
| Cold reload/recovery | Page navigation, editor/engine initialization, local log replay, catch-up, and matching state |
| Browser memory | Post-GC V8 used heap plus backing storage across the page and all its dedicated workers |
| Stored payload bytes | Exact retained PostgreSQL batch bytes and IndexedDB replica bytes; reported separately |
| State export bytes | Concord snapshot or Yjs full-state binary update |

The real-app probe observes the **unchanged stock worker's response after its
atomic IndexedDB append**. It waits until the outbox has observed the exact
last generated operation counter and has zero pending/sent operations.
This prevents a paste's first ACK from being mistaken for completion of the
whole paste. Outbox counts use IndexedDB indexes with a 5 ms polling interval;
large operation logs are read for byte accounting after the timed work.
Production reconnect and reload also require the UI's connected state.

The rendering boundary is a browser presentation opportunity, not proof of
physical display paint. Memory includes Concord's worker and WASM backing
storage; page-only heap would undercount it. It excludes browser native,
DOM, graphics, and operating-system allocations and is not peak process RSS.
Stored payload bytes exclude PostgreSQL row headers, indexes, and WAL.
Snapshots, local logs, and server logs are distinct measures.

All user-edit latency samples are retained; p50/p95 use nearest-rank
percentiles pooled across the measured runs. Recovery and byte-size metrics
have only three run samples in the default campaign. Those p95 values are
descriptive maxima of a small sample, not statistical confidence bounds.

## Outputs and shorter checks

Each run writes a fresh directory under `output/playwright/performance/`:

- `raw.json`: status, full environment, pinned package versions, toolchains,
  build mode, source/binary hashes, exact edits, warmups, individual samples,
  correctness results, actual-app results, and browser report checks.
- `samples.ndjson`: completed paired cells as they finish, including warmups.
- `summary.json` and `summary.csv`: measured distributions and sample counts.
- `charts.svg`: shareable chart with all workloads and both engines.
- `report.html`: metric/statistic controls, tables, method, raw download links,
  and the separate production-app results. Keep it beside its companion files.
- `report.png` and `production-editor.png`: browser evidence.

```bash
# Fast browser correctness check. Smaller inputs and one-second disconnections;
# explicitly labeled quick, never used as headline performance evidence.
npm run bench:compare -- --quick

# Secretless controlled comparison: no production-app lane or Clerk setup.
# Requires the isolated concord_test database; rejects other database names.
DATABASE_TEST_URL=postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test \
  npm run bench:compare -- --quick --paired-only

# Explicit run parameters and a fresh output directory.
npm run bench:compare -- --runs 5 --offline-seconds 120 --output output/playwright/performance/my-campaign

# Regenerate the report from complete raw evidence without remeasuring.
node scripts/bench/comparison-report.mjs path/to/raw.json

# Report/publication rejection checks.
npm run test:bench:compare
```

Missing dependencies, failed semantic checks, unmatched workloads, omitted
worker memory, pending writes, or an incomplete cell matrix prevent a passing
report. CI runs the secretless quick browser lane against rebuilt WASM and
PostgreSQL. Shared-runner timings are correctness smoke data; they are not
published performance evidence. The authenticated production lane remains
an explicitly provisioned local run.

This campaign establishes machine-local observations for the recorded
versions and workload. It does not prove responsive editing at all document
sizes, asymptotic complexity, maximum throughput, production network latency,
or universal superiority of either engine. The existing 100,000-operation
30-second fold / five-second import test remains a broad regression guard.
