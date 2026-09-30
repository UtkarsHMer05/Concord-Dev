# Feature 3: reproducible failure lab

Verified locally on 2026-09-30, on macOS arm64 with Node 24.20.0. The
acceptance receipt records parent revision
`c8a9e8c2f9cc1820b5a6b3ae61e627402faeef38` plus the feature's working changes.
The exact start/finish times and WASM SHA-256 are retained in
[report.json](../assets/failure-lab/report.json). This report describes the
implemented developer feature and its local evidence; hosted runtime is
outside this acceptance boundary.

## Implemented behavior

`npm run failure-lab` combines existing correctness seams into one command.
It records three real-session/WASM schedules, reproduces and reduces a known
failure, runs the existing live suites sequentially, and creates a standalone
interactive HTML inspector with a machine-readable report and trace files.

The inspector provides a scenario selector, keyboard-operable timeline,
previous/next/play controls, three replica states, pending/sent/confirmed
operation counts, monotone cursors, native content/digests, protocol
deliveries, and trace download. The coverage table states the simulation,
live infrastructure and browser boundaries individually. Mobile state rows
reflow; wide coverage/protocol data scroll inside their own containers.

Trace execution uses the actual `SyncSession`, `WorkerEnginePort` and
`CrdtWorkerCore` backed by Concord's WASM build. Its gateway and persistence
are models. The trace stores ordered fault/edit actions and generated
operation identities/bytes. Replay checks those bytes rather than accepting
only matching visible text. Bounded reduction preserves the same invariant
failure and reports single-action minimality.

The implementation extracts the already existing real-engine test adapters
into `tests/sync/engine-harness.ts`, removing duplicated helpers from the
session simulator and engine-port suite. It adds no npm dependency, service,
or production route.

## Reproduced failures and fixes

**Historical shared replica identity:** lab mode `legacy-replica-alias`
assigns replica 101 to Alice and Bob. Their independent edits produce
different bytes for `101:1`. The standard run reduces five scheduled actions
to two in seven candidates; neither edit can be removed while retaining the
collision. The fixed replay keeps the same ordered actions and schedule hash
but assigns separate identities. It converges and drains all pending work.
This mode is confined to the lab, not exposed in the application.

**Cursor regression discovered during implementation:** the independent-tab
schedule delivers cursor 2 after cursor 3. Before the fix, `SyncSession`
unconditionally assigned the older cursor and invoked its callback. The
[recorded before-fix result](../assets/failure-lab/cursor-before-fix.json)
failed with `session_error: Cursor decreased`. The worker persistence layer
already kept its cursor monotone; the session itself also needed that guard.

The shared `advanceCursor` function now serves both normal catch-up and
snapshot cursor persistence, retaining the highest session cursor while
still integrating duplicate operation bytes. The exact
[regression trace](../assets/failure-lab/cursor-regression.trace.json) passes
through the fixed session and emits identical engine operation bytes. The
existing simulator now explicitly asserts monotone cursor callbacks instead
of silently clamping a decreasing callback value.

**Production browser fixtures:** the rich-text driver now waits for restored
editor focus before its next keyboard edit. Its stale-worker fixture uses a
separate context with service workers blocked because a PWA-owned response
cannot be replaced by a page route. The driver asserts that the injected
older bundle was actually served. Shared-storage tab and offline acceptance
continue to use normal service-worker behavior.
The review-branch driver also waits for editor focus and the newly created
task checkbox before typing, and for focus after choosing indentation. The
repeat run exposed that fixture's immediate keypress race; the final complete
run passes with the awaited UI state.

## Verification

| Check | Result |
|---|---|
| Full `npm run failure-lab -- --headed` | All six requested lanes passed; exit 0 |
| Recorded scenarios | Three passed; includes pending retention, duplicate delivery, lost ACK, model restart and matching final digests |
| Known-failure reduction/fixed replay | 5 to 2 actions, single-action minimal; same action hash passes under independent identity allocation |
| PostgreSQL/native convergence invariants | 2 tests passed |
| Actual stale-client snapshot compaction | 1 test passed |
| Real gateway realtime matrix | 21 tests passed |
| Authenticated production Chromium tabs/upgrade | 6 acceptance stages passed |
| Authenticated branch merge acceptance/recovery | 6 acceptance stages passed |
| Web unit suite | 312 passed; 2 intentional skips: opt-in 100k-op performance gate and CLI artifact driver |
| TypeScript/ESLint | Passed, no lint warnings |
| Dependency audit | 0 vulnerabilities |
| Trace CLI behavior | Fixed replay exit 0; known collision replay exit 1; minimization exit 0; cursor regression replay exit 0 |
| Missing dependency | Built WASM temporarily withheld: exit 2 and `incomplete`; original bytes restored with identical SHA-256 |
| Inspector browser interaction | Scenario selection, previous/next, play progression and trace download verified; downloaded JSON matches the replayed fixture |
| Responsive behavior | 390 px viewport has 390 px document width; coverage table overflow stays in its own wrapper |
| Coverage keyboard access | Named, focusable region; ArrowRight moves its horizontal scroll from 0 to 40 px |

The simulation lane's test count of one is its artifact-producing Vitest
driver, which executes all three scenarios and the failure/fix demonstration.
It does not mean that only one model scenario was checked. Browser runs build
and use the production Next.js application; their stage lists are retained
in the acceptance receipt.

Screenshots in the README are actual Chromium captures of the generated
report, with embedded origin metadata. The operation content is synthetic.
Raw diagnostic logs, Clerk credentials/storage state and browser-private
artifacts are excluded from the committed sample.

The finish reviewer scored its three requested fixes resolved: distinct run
and scenario results, keyboard access to the mobile coverage table, and
presentation documentation. Its final disposition was **ship** at the scope
of those scored fixes. The subsequent documenter recorded the shipped report
rules in the guide's Inspector presentation section.

## Practical limits

- Simulation uses memory persistence and a modeled gateway. Its exact replay
  does not reproduce live OS/database/network timing or prove browser crash
  durability. Live suite results remain separately labeled.
- The crash-at-acceptance case covers transactional **branch merge** and its
  saved idempotent retry. It does not establish atomic suggestion acceptance.
- Stale clients after actual compaction and incompatible worker capability
  negotiation are separate live checks, not simulated timing claims.
- Minimization is bounded to 60 candidates and reports single-action
  minimality, not a globally shortest schedule.
- A simulation-only success deliberately omits live coverage. A full run with
  absent prerequisites or skipped checks reports incomplete coverage.
- This is an engineering regression/demo tool, not a production fault injector
  or exhaustive concurrency/performance proof.

See [FAILURE_LAB.md](../FAILURE_LAB.md) for runnable commands, prerequisites,
trace validation bounds and artifact-sharing instructions.
