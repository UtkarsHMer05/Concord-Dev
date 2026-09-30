# Feature #2 implementation and verification report

Date: **2026-09-30**. Starting revision: **`5a7bb07`**, clean `main`.

Implemented the proposal's **shared review branches and selective, durable
merge**. Feature #1 remains the underlying rich-text collaboration engine.
The failure laboratory, independent Concordpack verifier/import workflow
and comparative benchmark campaign (features #3–#5) remain separate scope.

## Implementation

The repository continuation traced the existing named revisions, native
restore-diff, gateway ingestion locks and transactions, permission service,
anchored comments, offline editor outbox and review panel. The implementation
reuses those mechanisms rather than adding another editor or sync engine.

- **Shared branches:** create from a saved version; independent ordinary
  CRDT documents retain rich content, offline edits and durable synchronization.
  Their immutable base records the source revision, sequence, digest and content.
- **Invitations and feedback:** the Share tab exposes owner-managed Edit,
  Commenter and Viewer grants. Branch ACLs and anchored discussions are separate
  from main; access to main is also required to compare or merge.
- **Selective comparison:** original base, current main and proposed branch
  are shown per server-generated change. Unrelated main changes survive.
  Conflicts require an explicit Use branch choice; Keep main is the default.
- **Durable merge:** the worker verifies selected rich content and emits
  forward CRDT operations. The gateway rechecks authorization and both heads
  under its normal locks. Operations, source/result revisions, merge provenance
  and audit event commit together. The history compaction guard is reused.
- **Recovery:** each merge UUID and exact request is stored locally before
  sending. Same-request retries return the original record; concurrent retries
  commit once. Interrupted or malformed responses retain the recovery request.
- **Usability:** the active comparison takes priority over creation controls;
  errors and outcomes appear near the top, provenance expands on demand,
  tabs support keyboard navigation, and the comparison stacks on mobile.

Migration 6 adds the two gateway-owned review tables. Existing revision kinds
and browser wire/storage formats are retained. The only Cargo dependency
change enables JSON support on the already-installed PostgreSQL client;
there are no new runtime packages.

## Real browser acceptance

The [driver](../../scripts/e2e/review-branches.mjs) uses real Clerk test
authentication, the editor/WASM/IndexedDB path, Rust gateway, native worker
and local PostgreSQL. Invitations are granted through Share, not by seeding
ACL rows. Its six stages prove:

1. A named baseline becomes an independently shared rich CRDT branch, including
   checked tasks and nested list structure.
2. The author edits offline while the main owner edits the main document.
   Reconnect and reload retain both distinct documents.
3. A separately invited commenter can anchor feedback, needs a separate main
   invitation to compare, and cannot edit or merge.
4. A single selected change merges while the owner's conflicting paragraph,
   unrelated budget change and omitted rollout proposal remain unchanged.
   The test aborts the successful HTTP response after server commit and closes
   the page. A new page retries the saved request: one record, the same revision
   pair and **no extra operations**.
5. Source/result revisions appear in History; branch feedback, untouched main
   comment anchors and nested checked task state survive.
6. Explicit Use branch resolution merges the conflicting paragraph while
   retaining unrelated and unselected changes. An induced service failure
   brings the error into view on desktop and mobile and preserves the saved
   request; retry succeeds. The panel passes a responsive overflow assertion
   and an axe check with zero critical/serious findings.

Expected denied-access and deliberately aborted-response errors are retained
in private diagnostics. The driver gates uncaught page errors; it does not
claim that deliberately induced HTTP errors are absent from the console.

Browser evidence is in [the result JSON](../assets/review-branches/report.json)
and [comparison screenshot](../assets/review-branches/comparison.png).
Fixtures are synthetic engineering proposals, not production customer data.

## Verification gates

| Gate | Result |
| --- | --- |
| TypeScript / ESLint | Passed, no lint warnings |
| Web unit tests | 309 passed; one existing opt-in performance test skipped |
| Web PostgreSQL tests | 79 passed |
| Live realtime tests | 21 passed |
| Rust library | 104 passed; one intentional golden-fixture generator ignored |
| Gateway DB / history / migration / WebSocket integration | 15 / 11 / 4 / 17 passed with the live isolated DB |
| Native Release CTest | 3/3 suites passed, including all 57 worker protocol tests |
| Rust formatting / Clippy | Passed with warnings denied |
| Production Next.js build / real-auth browser acceptance | Build passed; all 6 stages passed |
| WASM smoke | 12/12 checks passed |
| npm audit | Zero vulnerabilities |
| Working-tree secret scan | Clean |

The three new live review gateway tests verify rollback at the final write,
same-request recovery after a new service instance, rejected changed-payload
retries, permission isolation, stale main/source heads, explicit conflict
choices, and concurrent duplicate requests. Five planner tests cover independent
edits, connected conflicts, repeated/inserted/deleted content, atomic list units,
and PostgreSQL JSONB key ordering. Three native merge tests verify rich nested
content, untouched item IDs, Unicode, duplicate delivery and malformed ranges.

The [feature specification](../REVIEW_BRANCHES.md) documents API, limits,
permission rules, conflict granularity and recovery. This is local acceptance
evidence; a hosted deployment or independently reproduced production incident
is not claimed. The final Git and CI state is reported in the delivery message.
