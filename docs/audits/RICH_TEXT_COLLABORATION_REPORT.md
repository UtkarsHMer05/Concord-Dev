# Feature #1 implementation and verification report

Date: **2026-09-30**. Starting revision: **`d25812f`**, clean `main` checkout.
Status: **implemented and locally verified**.

The requested feature is the proposal's **“Complete rich-text collaboration,
with safe client upgrades.”** Features #2–#5 were left outside the
implementation. The proposal and screenshot were evaluated as suggestions
and acceptance criteria; they were not treated as instructions to implement
every proposed feature.

## Repository analysis

The audit traced the editor → mapper → reconciliation bridge → IndexedDB
worker → WASM/native CRDT → pending outbox → Rust gateway → durable database
and fanout → second editor path. It also reviewed the adjacent application,
review tools, protocol, tests and operational documentation to identify
consumers that needed to understand the new representation.

| Area reviewed | Existing foundation and relevant finding | Action for feature #1 |
| --- | --- | --- |
| Product editor, toolbar, fallback and document sessions | TipTap already exposed several formats, but the collaborative mapper supported only paragraphs/headings. Some marks were silently dropped while reporting support | Added bounded collaborative lists/marks, toolbar access and truthful fallback/update UI |
| C++ core, native worker and WASM bindings | Sequence CRDT, tombstones, snapshots and deterministic LWW already existed; the closed vocabulary omitted rich-text attributes. JSON string escaping differed between native views and WASM stream output | Extended the existing registry and reused the shared escaping helper; kept the core wire/storage format |
| Adapter, bridge and browser persistence | Type/mark changes replaced unchanged text, destroying useful IDs. Separate worker calls and stale view indices could misdirect or overwrite an edit | Stable-ID register changes, atomic durable batches, serialized RPCs, view rebasing and guarded rendering |
| Replica ownership and account isolation | Account/document identity was shared by simultaneous tabs; both could reuse operation IDs and the same cache | Web Lock ownership plus independent tab replicas/cache/outbox namespaces |
| Gateway, protocol, auth and durability | Existing wire v1, PostgreSQL durable ACK, reconnect/catch-up, NATS fanout and Redis services were reusable; old clients had no rich-text capability gate | Capability negotiation before auth/join, fail-closed upgrade handling; existing ownership/auth rules retained |
| Snapshot resync | A server snapshot could temporarily replace local durable offline operations before outbox replay | Replay durable local operations into the replacement native instance before swapping |
| Comments, presence and selection | Position mapping assumed flat paragraph/headings; new list wrappers changed editor offsets | Recursive leaf mapping with stable IDs and UTF-16/hard-break handling |
| Checkpoints, history, restore, replay and Concordpack UI | Existing review tools consumed native visible JSON and previewed the narrower model; restore fanout could use a u64 batch ID beyond JS's safe-number range | Expanded validation/preview conversion, preserved rich restore, exact large batch ID decoding; reused existing workflows |
| Markdown, drafts and exports | Whole-document drafts already retained TipTap JSON; Markdown export was intentionally narrower | Corrected PM `strike` mapping and retained explicit loss warnings; no claim of lossless rich Markdown |
| Permissions, routes, PWA, search, CI, deployment and benchmarks | Existing systems provide the surrounding application; the proposal's other features require separate scope | Reviewed integration boundaries; no new sharing workflow, failure lab, verifier/import pipeline or benchmark campaign |

This is a repository-wide architectural and integration audit for the
requested feature. It is not a claim that every source file, deployment or
existing future proposal was exhaustively certified.

The local Next.js 16 documentation was read before editing client code.
Ponytail was used to reuse the existing CRDT, persistence, helpers and
installed dependencies; Impeccable was used for focus, status, validation
and preview usability; Playwright controlled the actual browser. No new
runtime dependencies or second collaboration engine were added.

## Implemented behavior

1. **Collaborative nested lists.** Bullet, numbered and task lists round-trip
   through TipTap, native/WASM JSON, operations and snapshots. Mixed nesting,
   ordered starts, continuation paragraphs, indent/outdent and checkbox
   changes are represented on delimiters. Depth is bounded to 0–8.
2. **Formatting without text replacement.** Bold, italic, underline, strike,
   inline code, links, text color/font family/font size/highlight and hard
   breaks are preserved. A formatting-only edit emits attribute operations
   on the existing text IDs, allowing overlapping independent marks to compose.
3. **Specified concurrent structure.** Same-register conflicts use existing
   `(Lamport, ReplicaId)` LWW ordering. Surviving children with missing parents
   are promoted deterministically; their text is retained. Structural changes
   do not normalize registers by emitting extra local operations.
4. **Durable and race-safe editor integration.** Reconciliation uses one
   IndexedDB batch, worker requests execute serially, and the bridge rebases
   stale positions onto IDs. Atomic view reads and render retries prevent a
   local keystroke from being replaced by an older worker response. A scoped
   regression deliberately types during a paused remote read.
5. **Offline resync and tab safety.** Snapshot replacement preserves the local
   operation log and allocation state. A second/duplicated tab obtains its own
   live writer identity and cache/outbox; reload reclaims its offline state.
6. **Safe client upgrades.** `rich-text-v2` is required in hello/ack before
   authentication. Old JS workers and WASM fail before editing; the user sees
   an explicit reload action and preserved-offline-data message. A blocked
   worker shows **Waiting for update** rather than a misleading saved state.
7. **Existing review-tool compatibility.** Rich preview, checkpoint restore,
   replay and bundle content validation understand the new representation.
   The history panel stacks its list and preview to fit its fixed sidebar.
   Large restore batch IDs now round-trip exactly as u64 decimal strings.

The complete semantics, value limits and coordinated deployment procedure
are in [RICH_TEXT_COLLABORATION.md](../RICH_TEXT_COLLABORATION.md). Protocol
and decision documentation were updated; the earlier list investigation and
historical release evidence were preserved with an explicit superseding link.

## Real browser acceptance demonstration

The standalone [driver](../../scripts/e2e/rich-text.mjs) ran with headed
Chromium against real Clerk development sign-in, the Rust release gateway,
the native worker, local PostgreSQL, NATS and Redis, and the compiled WASM
and IndexedDB browser replica. It performed edits through keyboard, toolbar,
menus, links, checkboxes and review-tool controls.

The final run passed **all six stages**, with **304 CRDT operations persisted
in PostgreSQL** and identical rendered content in the two authenticated
editors. The driver asserted no fatal console errors in those two normal
editor sessions. This operation count is acceptance evidence, not a
performance benchmark.

| Stage | Directly verified |
| --- | --- |
| 1. Two users | Nested bullets, two numbered items, tasks, link and inline code appear identically in the second user session |
| 2. Both offline, then reconnect | Alice makes bold/outdent changes while Bob applies italic to the same text and toggles a task; both converge with overlapping bold+italic and the checked task |
| 3. Native checkpoint and restore | Rich preview shows list/link/code/task state; owner restores a checkpoint through the native gateway; both users converge to the checkpoint content |
| 4. Reload | Both editor sessions reload with the same text, formatting and task state |
| 5. Duplicated tab | Cloned sessionStorage receives a different replica; concurrent edits from the same-account tabs both reach the other user and converge |
| 6. Stale worker | An intentionally old initialization response shows Reload Concord, Waiting for update and a noneditable surface |

Selected evidence from this successful run:

- [Machine-readable result](../assets/rich-text/report.json)
- [Nested lists before the offline edit](../assets/rich-text/nested.png)
- [Alice's final content](../assets/rich-text/alice.png) and [Bob's matching content](../assets/rich-text/bob.png)
- [Offline editing state](../assets/rich-text/offline.png)
- [Rich checkpoint preview](../assets/rich-text/history.png)
- [Explicit stale-worker upgrade screen](../assets/rich-text/upgrade.png)
- [390px mobile viewport](../assets/rich-text/mobile.png)

The upgrade screenshot is a deliberate simulated stale-worker failure in a
development server; the Next development issue badge reflects that injected
failure. Normal editor console checks passed. Captured auth names are
disposable test identities, not real workspace users.

## Verification results

| Gate | Result for this implementation |
| --- | --- |
| Web unit suite | **303 passed; 1 opt-in performance test skipped** |
| Database suite | **79/79 passed** |
| Live WebSocket transport suite | **21/21 passed** |
| Existing authenticated Chromium regression suite | **15/15 passed**, including accessibility, keyboard navigation, typing/reload, two-user sync, reconnect, offline, authorization isolation and review tools |
| New rich-text browser acceptance driver | **6/6 stages passed**, 304 durable operations |
| Native Release CTest | **3/3 passed** |
| WASM smoke | **12/12 passed** |
| Rust gateway library | **99 passed; 1 fixture-generation test ignored** |
| Rust WebSocket integration | **17/17 passed**, including old-client rejection before authentication |
| Rust build / format / Clippy | Release build, formatting check and all-target Clippy passed |
| Web production build / TypeScript / ESLint | Production build, TypeScript compilation and ESLint passed |
| Diff whitespace | `git diff --check` passed |

Feature regressions specifically cover real WASM list/style/snapshot round
trips, unsafe values/unknown content, formatting without ID replacement,
child survival during parent deletion, reordered concurrent task/depth writes,
old WASM rejection, cloned-tab leases, bridge read-vs-keystroke races, durable
worker batches, local operation preservation during snapshot import, recursive
anchors, old-gateway rejection and exact max-u64 batch IDs.

An additional broad Rust integration run passed the library and broker
integration groups but did not complete all groups: three broker-chaos tests
failed at their Docker pause/restart/stop command assertions because that
run's scoped PATH omitted the installed Docker CLI. The relevant library,
WebSocket and live transport gates passed separately. This report does not
claim the entire optional fault-injection matrix passed. The three local
Concord service containers were verified healthy afterwards.

## Scope and remaining limits

- **Features #2–#5 are unimplemented:** no new shared review branch/merge
  workflow, reproducible failure lab, independent Concordpack verifier/import
  transaction or comparative benchmark campaign was built.
- **Per-character formatting semantics:** unknown concurrent insertions do
  not inherit an unseen peer's formatting span. This implementation is not
  Peritext span-intent semantics.
- **Unsupported content:** tables, images, blockquotes, code blocks and
  attributes outside the closed registry remain in Full document mode.
  Markdown remains a narrower export and warns about loss.
- **Mapping ceiling:** the existing text/block diff pairs unchanged prefixes
  and suffixes and unmatched blocks positionally. It is not semantic move
  tracking for arbitrary duplicated text. ID rebasing uses a linear lookup per
  operation; the code marks the measured large-paste threshold for indexing.
- **Existing suggestion acceptance crash window:** the proposal's separate
  acceptance-then-rejection race was not part of feature #1 and was left for
  a review-workflow task. Rich-text completion does not claim that issue fixed.
- **Deployment:** the local implementation includes regenerated public JS
  worker and WASM assets. Gateway/native/web/worker/WASM need a coordinated
  deployment and old tabs need to reload. No production deploy, remote CI
  or cloud resource change was performed during implementation.
- **Historical loss:** already discarded formatting from older versions
  cannot be recreated automatically; existing local data and histories are
  retained for the updated engine to read.

No database schema change was needed. The browser harness cleaned up its
disposable Clerk identities and app/gateway processes; PostgreSQL, NATS and
Redis local service containers remain available. The implementation, tests,
documentation and selected browser evidence are included in the repository.
