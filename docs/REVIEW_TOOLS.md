# Review and recovery tools

Status: Working local prototype  
Last updated: 2026-09-25

The editor's **Review & history** panel groups five post-v1 collaboration
tools. They use the existing document ACL, CRDT worker, IndexedDB replica,
and Rust durable gateway; they do not add a second collaboration engine.

## History and restore

The browser uses the same-origin `/api/gateway/documents/{documentId}/revisions`
route. The Next.js handler forwards only these fixed history paths to the
configured gateway, and the Rust service validates the Clerk bearer token and
document role. The web route is not an authorization boundary by itself.

- OWNER, EDITOR, COMMENTER, and VIEWER can list and preview history.
- OWNER and EDITOR can create named checkpoints; only OWNER can restore.
- A preview contains read-only canonical content reconstructed by the native
  worker from a finalized snapshot and operation tail.
- Restore appends operations through the durable operation path and records a
  restore event. The UI reports success only after the gateway returns after
  that commit. Existing revisions and operations remain available.

The route returns `503` when the history worker is unavailable and `404` for
both missing revisions and inaccessible documents. The UI offers a retry for
transient failures. Each authenticated user can make at most 30 history API
requests per minute in the configured scope. Redis shares the counter across
gateways; local fallback applies the limit per gateway.

## CRDT-anchored comments

A comment stores its selected start/end as decimal `replicaId:counter` CRDT
item IDs plus a `before` or `after` affinity. Resolution maps those IDs into
the current TipTap document and stream. Insertions before the first anchored
item keep the range with the original text. If either boundary item has been
deleted or is no longer resolvable, the discussion remains visible as an
orphan; it is never attached to an approximate offset.

The local comment outbox is scoped by document and Clerk user in browser
storage, capped at 100 pending threads/replies, and written before a network
attempt. Stable thread/message UUIDs make retries idempotent. The UI separates
pending, saved, delivery-error, and orphaned states. Reads require document
access; OWNER, EDITOR, and COMMENTER can comment; OWNER and EDITOR can resolve
a thread. Comment changes and audit events share a database transaction.
The UI loads the latest 200 threads and 2,000 replies and displays a notice
when either bound is exceeded; older records remain stored but need pagination
to inspect in this prototype.

## Reconnect briefing

After durable catch-up advances a cursor, the editor can show the cursor range,
operation count, origin replica IDs, and local unacknowledged count. An
unreadable local outbox is reported as unknown. Replica IDs are not person
identities, and the prototype does not infer intent, authorship, or overlapping
passages. The briefing is emitted only when the durable cursor advances and
can be dismissed.

## Parallel drafts

Drafts are private to a browser profile, document, and signed-in user; they
are not server-synced. Storage is capped at 20 drafts and 2 MiB per document
and account. A draft records its base TipTap document and merges
selected top-level block changes into the current document. Unique unchanged
blocks anchor the diff; duplicate or ambiguous areas are presented as
conflicts. Apply writes through the live editor and CRDT bridge, so accepted
changes become normal durable edits. The editor in this prototype permits
direct draft editing for plain paragraphs and headings; richer blocks/marks
remain preserved in the base but are not directly editable in the draft
surface.

## `.concordpack`

Version 1 is a bounded binary file containing a canonical JSON manifest, a
snapshot, the retained operation bytes, a SHA-256 payload checksum, and the
expected canonical CRDT state digest. Verification reconstructs a temporary
WASM CRDT engine and compares its digest before showing the preview. The file
limit is 64 MiB; the checksum detects corruption, while the CRDT digest checks
reconstructed state. Neither proves who exported the file.

The UI can apply supported visible content into the open document as new CRDT
edits, keeping its existing history. This does not transplant the bundle's
operation identities or history into a live shared document. Application is
limited to the collaborative paragraph/heading subset and supported marks;
other verified content can still be inspected but is not offered for lossy
application. A true operation-preserving import into a newly created shared
document needs a dedicated durable replica-import transaction and is not part
of this prototype.

## Verification

- Unit and WASM-backed tests: `tests/crdt/comments-anchors.test.ts`,
  `tests/crdt/comments-outbox.test.ts`, `tests/crdt/concordpack.test.ts`,
  `tests/drafts.test.ts`, `tests/sync/catchup-briefing.test.ts`, and
  `tests/gateway-history-proxy.test.ts`; PostgreSQL role, retry, and cross-user
  coverage is in `tests/db/comments.test.ts`.
- PostgreSQL authorization, idempotency, and audit behavior: the database
  document/comment suites under `tests/db/` (run with the isolated test DB
  configured).
- Gateway history reconstruction and route behavior: Rust `sync-gateway`
  tests, including worker response and history authorization coverage.

Rendered browser verification on 2026-09-25 also passed against the disposable
PostgreSQL database, real Clerk development instance, rebuilt Rust release
gateway, native worker, and browser WASM worker:

- `npm run test:browser`: 14/14 Chromium tests, including template seeding,
  two-browser sync, reconnect, offline persistence, authorization isolation,
  accessibility, and this complete review-tools flow.
- `CONCORD_E2E_MODE=production ... tests/browser/review-tools.spec.ts`: 1/1
  against the generated standalone Next.js server.
- `npm run test:browser:smoke:firefox` and
  `npm run test:browser:smoke:webkit`: 1/1 each.

The release gateway must be rebuilt after Rust changes (`cd rust && cargo
build --release`) because the browser harness intentionally executes the
release binary. Hosted deployment and remote authenticated CI remain outside
this local evidence.
