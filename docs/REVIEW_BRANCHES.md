# Shared review branches and selective merge

Portfolio proposal **feature #2**, implemented on 2026-09-30. See the
[verification report](audits/REVIEW_BRANCHES_REPORT.md) and the runnable
[browser acceptance driver](../scripts/e2e/review-branches.mjs).

## Using a review branch

1. Open **Review & history → History** and save a named checkpoint.
2. In **Branches**, choose that saved version, enter a proposal name, and
   create the branch. Open it to use the full collaborative rich-text editor.
3. Use **Share** to grant a collaborator **Can edit**, **Can comment**, or
   **Can view** access by verified account email. They find the invitation in
   **Shared with me**. Copy the link when you want to pass it through your
   usual channel. See [sharing](SHARING.md) for role and revocation rules.
4. Add feedback in **Comments** by selecting a passage. A branch has its own
   comments and permissions. Comparing requires access to main as well;
   its owner can grant that separately.
5. In **Branches**, compare with main. Each review change shows the original
   base, current main, and proposed branch. Include the desired changes.
   Conflicts default to **Keep main**; **Use branch** explicitly replaces
   the main content shown for that change.
6. Merge the selection. History gains a named source revision on the branch
   and a named resulting revision on main. Expand **Merge provenance** to
   inspect the linked revision IDs and committed sequence.

An existing branch can be edited offline, then reconnected and reloaded using
the normal IndexedDB outbox. Creating, sharing, comparing and merging need
the gateway connection. The branch remains editable after a merge, so further
changes can be proposed and merged separately.

Reviews use feature #1's collaborative content subset: text, headings, lists
and supported inline formatting. Tables, images and other content in **Full
document mode** use the separate whole-document save path. The editor flush
refuses a new CRDT merge in that mode; those unsupported blocks are not part
of this review comparison.

## What a branch contains

Each branch is an ordinary document with its own CRDT replica, durable
operation log and ACL. Its creator owns it. The main document's owner receives
an explicit editor grant when someone else creates the branch; other users
and organization-wide permissions are not inherited. Main's existing grants
do not automatically expose the branch, and a branch invitation does not
expose current main content.

Gateway migration **6** adds `review_branches` and `review_merges`. Branch
metadata freezes the main document, base revision ID, base sequence, digest
and canonical base content. The editor and synchronization layers remain the
existing C++/WASM CRDT, IndexedDB, Rust gateway and PostgreSQL implementation.
No second collaboration engine or runtime dependency is introduced.

## Comparison and merge semantics

Comparison is a three-way, block-level review. Unique unchanged blocks anchor
a patience diff. Consecutive list items and continuations form one review
unit, including nested lists, so selecting a child cannot detach it from its
parent. Repeated or overlapping content is grouped conservatively and shown
as a larger change. This is a selective proposal workflow; it does not infer
a word-level resolution of two edits to the same paragraph.

Independent main edits remain outside the selected ranges. A change already
present in main is labelled **Already in main** and cannot be reapplied.
Selected replacements preserve rich block attributes, text marks, Unicode
and list/task state. Unchanged main items retain their CRDT IDs and anchors.
Comments on replaced text follow the existing orphan policy; branch comments
remain on the branch rather than being copied onto new main IDs.

The native worker's internal command **10** accepts two snapshots and ordered
`[mainStart, mainEnd, sourceStart, sourceEnd]` block ranges. It constructs the
expected selected content, verifies the native target, and uses the existing
forward restore-diff generator to emit server-owned `REST` operations. This
is an internal worker command, not a browser wire-protocol change. Invalid
or overlapping ranges fail closed; generation is capped before allocating
an oversized operation batch.

The browser sends selected server-issued change IDs and explicit conflict
resolutions, together with the main and branch sequences it reviewed. It
does not submit target content or trusted block offsets. Sequences are exact
decimal strings, including values above JavaScript's safe integer limit.
Before sending a new merge, it flushes the open editor and checks its CRDT
digest against the durable comparison, preventing unsynchronized local edits
from being silently omitted.

The gateway generates the candidate edit batch from those pinned snapshots,
then takes both documents' ordinary ingestion locks in a stable order. It
rechecks both ACLs, both current heads and history's compaction-floor guard.
The guard holds the same document-row locks as revision creation. Selected
operations, a named source revision, a named result revision, a merge record
and an audit event commit in **one PostgreSQL transaction**. A failure before
commit leaves none of them behind. Fanout follows commit; reconnect recovers
durable operations if live delivery fails.

## Recovering an interrupted merge

Before sending, the browser stores each merge request under its own UUID,
scoped to the account, main document and branch. Separate keys prevent two
tabs from overwriting each other's requests. Storage failure prevents the
request from being sent.

After a lost response, reopen the same branch's comparison on that device
and use **Retry saved merge**. The gateway returns the existing record for
the same actor, request UUID and exact payload. It creates no second edit
batch or revision pair. Reusing a UUID with different scope or choices is a
conflict. Access is checked again on recovery. The browser removes the saved
request only after a matching commit response, or a definitive pre-write
stale/invalid-choice rejection. Network/service failures retain it.

If main or the branch changed before the merge committed, refresh the
comparison and choose again. The service refuses stale selections, including
changes that arrive while it is generating the candidate batch.

## API and limits

| Gateway endpoint under `/api/v1/documents/{mainId}/branches` | Behavior |
| --- | --- |
| `GET` | Accessible branch list; branch documents also return their source context |
| `POST` | Create from a durable revision using a retryable branch UUID |
| `GET /{branchId}` | Three-way changes, exact head sequences and digests, merge permission and records |
| `POST /{branchId}/merge` | Validate selection, commit atomically, or return the existing request's result |

The web exposes fixed same-origin `/api/gateway/.../branches` proxies using
Clerk bearer tokens. The gateway authorizes every operation. The separate
`/api/documents/{documentId}/permissions` route uses the existing owner-only
permission and audit service. Bodies are bounded while reading, including
chunked requests; routes validate IDs, verbs and JSON before forwarding.

The review limit is **2,000 canonical blocks and 2 MiB** per compared state,
**100 branches** per main document, **128 KiB** per merge request and the
existing native **1,000,000-operation** generation cap. Review APIs share the
history API's per-user compute budget. Split larger proposals into smaller
documents. A branch may review main directly; arbitrary branch graphs,
approval-state workflows and automatic email delivery are outside this feature.

## Verification

```sh
npm run test:review-branches:browser -- --headed
# Also exercise the production web build:
CONCORD_E2E_MODE=production npm run test:review-branches:browser -- --headed
```

The driver reuses the disposable real-Clerk E2E harness and only resets
`concord_e2e`. It provisions test identities, uses the actual editor and
sharing UI, and cleans up its own users and child processes. Existing local
PostgreSQL, NATS and Redis services and built native/WASM/gateway artifacts
are prerequisites; see the [authenticated browser setup](TESTING.md#rendered-browser-e2e-and-accessibility). Screenshots and diagnostic
results go to ignored `output/playwright/review-branches/`. The optional
`--inspect` holds that fixture for manual browser inspection until the
specified finish marker is created; its private browser state is deleted
during cleanup.

## Editor presentation

Branches and Share extend the existing **Review & history** panel on the
right of the editor. They inherit the white document sheet, light fixed
chrome, Arial-based typography, neutral borders, muted helper text and
shadcn buttons and inputs. Headings and selected tabs use weight to establish
hierarchy; controls retain the existing focus rings.

An open comparison replaces branch creation and the branch list. Each change
labels **Original base** in an expandable disclosure, **Current main** and
**Proposed branch** in the previews. Independent changes have an **Include
change** checkbox; conflicts start at **Keep main** and require an explicit
**Use branch** choice. The merge button displays the selection count, while
**Back to branches** returns to the list. Branch errors and outcomes appear
above the comparison as alert/status messages and receive focus, bringing
feedback into view after a merge action. Interrupted requests expose
**Retry saved merge**, and committed results retain expandable provenance.

Share uses labelled collaboration-ID and access fields, with grant and remove
controls available to the document owner. At a 390px viewport the panel fits
the screen and comparison previews stack; wider viewports show the current
and proposed previews side by side. The panel scrolls vertically, its tab
strip scrolls horizontally, and tabs support Left/Right arrows, Home and End.
The underlying 816px document sheet keeps its existing horizontal scroll.
