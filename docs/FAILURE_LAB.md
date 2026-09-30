# Reproducible collaboration failure lab

Feature 3 turns Concord's existing correctness tools into a developer demo.
One command records deterministic session scenarios, runs live recovery
checks, and writes an interactive report with downloadable operation traces.
No additional service or package is required.

```bash
npm run failure-lab -- --headed
```

Open `output/playwright/failure-lab/latest/index.html` in a browser. The report
is a standalone HTML file: the scenario selector, timeline, replica state,
protocol deliveries and trace download work without a server. It contains
recorded evidence; moving the timeline does not execute the engine again.

## Run and replay

```bash
# Full simulation, native/PostgreSQL, realtime and authenticated browser run
npm run failure-lab

# Explicitly request only the real-session/WASM model scenarios
npm run failure-lab -- --sim-only

# Execute exported actions and compare generated operation identities/bytes
npm run failure-lab -- replay docs/assets/failure-lab/fixed.trace.json

# Reproduce an intentionally retained historical identity-allocation failure
# Expected exit: 1, with replica_identity_collision in the report
npm run failure-lab -- replay docs/assets/failure-lab/known-failure.trace.json

# Find a smaller schedule that preserves the same invariant failure
npm run failure-lab -- minimize docs/assets/failure-lab/known-failure.trace.json

# Replay the recorded cursor regression through the fixed SyncSession
npm run failure-lab -- replay docs/assets/failure-lab/cursor-regression.trace.json
```

Use `--out output/playwright/failure-lab/my-run` to keep a run separately;
the default `latest` directory is overwritten. `--headed` opens the real
Chromium acceptance flows. Replay and minimization always use the simulation
boundary and require no Clerk account or database.

| Exit | Meaning |
|---|---|
| `0` | All requested checks passed; a successful minimization retained the expected failure |
| `1` | A check or invariant failed, or the trace could not execute |
| `2` | Required coverage is incomplete because dependencies or checks are missing/skipped |

An explicitly requested simulation-only run may pass with exit 0. Its report
still says **simulation only; live checks not requested**. A default full run
cannot turn a skipped live lane into a successful result.

## Prerequisites and isolation

Simulation needs the repository's Node/npm toolchain, `npm ci`, and
`npm run wasm:build`. The build imports `wasm/dist/concord-crdt.wasm` and
records its SHA-256; a missing module produces an incomplete report.

Live checks reuse the existing local test infrastructure documented in
[TESTING.md](TESTING.md):

- The isolated `concord_test` PostgreSQL database on loopback port 5433,
  prepared and migrated using `npm run db:test:prepare` and the existing
  gateway migration procedure. `DATABASE_TEST_URL` may supply credentials,
  but the lab refuses another host, database or port for these legacy suites.
- `build/native/worker/concord-worker`,
  `rust/target/release/sync-gateway`, Cargo and a working native SDK.
- Disposable JWKS/key fixtures from
  `node scripts/ci/generate-e2e-keys.mjs`.
- The existing local NATS and Redis services on ports 4222 and 6379.
- `public/crdt-worker.js` from `npm run worker:bundle`, installed Playwright
  Chromium, and dedicated Clerk **test** keys supplied through `.env.local`
  or the environment. Browser setup creates and cleans up its own namespaced
  Clerk test users and rebuilds the isolated `concord_e2e` database.

The lab probes these dependencies; it does not install packages, start/stop
shared Docker services, or deploy the application. The browser harness owns
its temporary Next.js and gateway processes. Browser acceptance runs use
production builds. On macOS, if the selected Xcode SDK cannot build, the lab
may use an already installed Command Line Tools SDK through process-local
`DEVELOPER_DIR`, without changing system settings.

Runs are sequential because the inherited suites share test databases and
browser build outputs. The checkout lock is
`.agent/scratch/failure-lab.lock`. After an interrupted run, check that its
recorded process has stopped before removing that one lock. Do not run a
database-resetting test suite or another authenticated browser harness at
the same time.

## What the lab checks

| Boundary | Faults and evidence |
|---|---|
| Real `SyncSession`, `WorkerEnginePort` and WASM; model gateway and memory storage | Three replicas; offline edits; lost send; duplicate catch-up; durable commit with lost ACK; model transport restart; reconnect; pending/sent/confirmed counts; cursors; native document JSON and final digests |
| Historical identity regression | Deliberately assign replica 101 to Alice and Bob; observe different bytes for `101:1`; reduce five actions to two; pass those same ordered actions with distinct identities |
| Real PostgreSQL/native worker | Commit ordering and durable reconstruction; stale client recovery after actual snapshot compaction |
| Real gateway processes and transport | Existing realtime matrix, including restart, ACK interruption, resend and reconnect recovery |
| Authenticated production Chromium | Shared IndexedDB with cloned session storage and concurrent tab edits; rich formatting/offline/reload; explicit stale-worker upgrade path |
| Authenticated review-branch Chromium | Merge accepted in PostgreSQL, interrupted response, browser closure/reopen, retry of the saved request, original history/provenance retained |

The stale-worker fixture replaces an older bundle's capability response in
a separate browser context with service workers blocked. An assertion proves
the replacement was served. The real tab and offline checks retain normal
service-worker behavior and shared IndexedDB.

The acceptance crash case is **branch merge**. It does not establish atomic
suggestion acceptance. The model's memory store does not establish browser
crash durability or PostgreSQL correctness; the corresponding live checks
are reported separately. The trace repeats ordered model actions and engine
bytes, not operating-system, database or network timing from live runs.

## Trace and minimization contract

Version 1 traces contain a name, allocation mode, ordered actions and generated
operation records: action index, client index, operation identity and Base64
bytes. CLI input is bounded to 2 MiB, 200 actions, three clients and 600
operations. Replay validates the schema and checks the complete generated
operation sequence against any recorded bytes. Engine/version changes that
alter those bytes fail with `trace_bytes_mismatch`.

The schedule hash identifies the ordered actions. The fixed identity replay
changes allocation policy, so its operation identities and bytes change while
its action hash stays the same. The historical alias mode exists only in the
lab; it is not a flag in the application.

Reduction removes chunks, then individual actions, preserving the original
failing invariant. It has a 60-candidate budget. **One-action-minimal** means
no single action can be removed while retaining that failure; it does not
claim a globally shortest trace. A trace byte mismatch or invalid schedule
is not accepted as a failure suitable for minimization.

## Shareable evidence

`report.json` and `index.html` contain results, environment/source metadata,
the engine fingerprint, model operation bytes, wire events and replica states.
The generated `*.trace.json` files can be replayed or minimized independently.
They use synthetic document content. Authentication tokens are excluded from
recorded model handshakes.

Raw `*.log` files and underlying browser diagnostics remain local; they can
contain database URLs or other environment details. Share the HTML, JSON and
trace files after checking their content, rather than the entire output
directory.

The [verification report](audits/FAILURE_LAB_REPORT.md) and committed
[sample result](assets/failure-lab/report.json) record the feature's acceptance
run. The sample is evidence from that run, not a claim about current hosted
infrastructure.

## Inspector presentation

The standalone report extends Concord's existing light document identity:
Arial interface text, neutral borders, white replica rows, and monospace
digests, code and protocol data. Replica metrics use tabular figures for
comparison across steps. Native selection, range, button and disclosure
controls retain visible labels and keyboard focus rings.

Keep the reading order: run result and coverage boundary, scenario selector
and trace download, timeline, then three named replica rows. Protocol
deliveries, per-lane coverage and CLI replay/reduction instructions follow
the state being inspected.

The header says **Run: PASSED**, **Run: FAILED** or **Run: INCOMPLETE**. This
describes the entire requested acceptance run. The selected scenario has its
own result beneath the selector; a successful run can contain an expected,
reproduced historical failure without calling that scenario successful.

The timeline displays recorded observations. Playback starts on request;
changing the scenario, moving the range or stepping manually stops it.
Executing or reducing the downloaded trace remains a CLI action.

Keep the content within the report's 1160px bound. At 650px and below, the
controls reflow and replica labels and state stack vertically. The coverage
table is a named, focusable **Coverage from this run** region; keyboard users
can focus it and use arrow keys to scroll its wide columns. Horizontal
overflow remains inside that region instead of widening the document.
