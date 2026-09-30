# Rich-text collaboration and safe upgrades

Implemented on 2026-09-30 for portfolio proposal **feature #1**. The current
verification evidence is in [the implementation report](audits/RICH_TEXT_COLLABORATION_REPORT.md).
This specification supersedes the unimplemented status in the historical
[native-list investigation](DESIGN_CRDT_NATIVE_LISTS.md).

## Supported editor content

| Content | Collaborative representation |
| --- | --- |
| Paragraphs and headings 1–6 | Existing block delimiters; alignment and fixed line-height registers |
| Bullet, numbered and task lists | `list-item` delimiter with `list`, `depth`, optional `listStart` and `checked` registers |
| Multiple paragraphs in an item | `list-continuation` delimiters, projected into the preceding compatible item |
| Nested and mixed lists | Depth-first item order; depths 0–8, where 0 is the outer list |
| Ordered-list starts | `listStart` in 1–999999; the default is 1 |
| Bold, italic, underline, strike and inline code | Independent registers on existing Unicode scalar item IDs |
| Links | `link`, `linkTarget` and `linkRel` registers |
| Text color, font family, font size and highlight | Bounded string registers on text items |
| Hard breaks and Unicode | Newline scalar projected as `hardBreak`; scalar IDs with UTF-16 editor position mapping |

The toolbar exposes bullet, ordered and task lists, indent/outdent, strike,
inline code and the existing formatting/link controls. List commands use
TipTap's installed list-item commands and return focus to the editor. A
depth guard prevents indenting beyond the supported range.

Tables, images, blockquotes, code blocks, unsupported marks/attributes and
excessive list depths use the existing explicitly labelled **Full document
mode**. This mode saves a whole document and does not provide CRDT realtime
collaboration. It remains outside feature #1's supported subset. Detection
fails closed before reconciliation; unknown content is not silently dropped
into the collaborative representation.

## Conflict rules

Structure is a deterministic projection of the existing sequence CRDT;
there is no second tree engine. Delimiters identify blocks and list items.
Changing a list kind, indent, checkbox, paragraph style or text mark writes
attributes on those IDs instead of deleting/reinserting the unchanged text.

| Concurrent edits | Result |
| --- | --- |
| Bold and italic over overlapping existing text | Both registers survive on the overlap; text IDs and character count stay unchanged |
| Two writes to the same mark, task state or depth | Existing LWW ordering chooses the maximum `(Lamport, ReplicaId)`; receipt order does not decide the winner |
| Parent item deleted while another user edits the surviving child | Only explicitly deleted IDs are tombstoned. The surviving child's text and marks remain; projection promotes a depth jump to the nearest surviving parent, or to the root |
| List kind changed while its text is edited | Kind/depth use delimiter registers; text editing uses the same scalar IDs |
| A remote insertion arrives while the editor still shows an older view | Reconciliation rebases stream indices onto that view's stable IDs; a remote shift cannot redirect the local edit to a different character |
| A worker read finishes after another local keystroke | The bridge reconciles the newer editor view and retries rendering, preserving the keystroke |

Sibling order follows the existing sequence CRDT. Adjacent compatible list
items are grouped by list kind and ordered start. Reconstruction clamps
depth jumps to the available parent stack without writing back normalized
depths. A surviving continuation without its parent becomes an item so its
text remains visible. These projection rules make intermediate inconsistent
register combinations renderable and deterministic.

The formatting model is **per-character LWW**. Newly inserted text carries
the inserting editor's marks. A concurrently formatted span does not
automatically extend to characters that its writer had never observed.
This is a deliberate limit; [Peritext's research](https://www.inkandswitch.com/peritext/)
describes richer span-intent semantics and is a reference, rather than an
implemented algorithm in Concord.

## Durability, selection and multiple tabs

One local editor reconciliation is generated as a batch and appended in one
IndexedDB transaction before the worker announces its operations. Worker
requests execute serially. Generation/persistence failure discards the
uncommitted native instance so the next request restores the durable log.
The bridge serializes local edits and remote application and reads JSON and
stream IDs together. Its last view includes TipTap's normalized trailing
paragraph, preventing view normalization from emitting accidental edits.

When the sync path imports a server snapshot, it replays the existing
durable local operation log into the replacement replica before swapping
instances. Local allocation counters are restored. Unsent offline edits
are therefore present during snapshot replacement, as well as subsequent
outbox replay. Existing direct import callers retain replace semantics
unless they request `preserveLocal`.

Comment, presence and caret mapping walks text leaves inside lists and
continuations and accounts for hard breaks and UTF-16 lengths. Formatting
and indentation preserve IDs, allowing anchors to stay attached. Remote
rendering resolves the previous selection by ID rather than by its old
numeric position.

A Web Lock owns each live account/document/replica writer. The first tab
keeps the existing local namespace for compatibility. Another live tab,
including one with cloned sessionStorage, obtains a distinct high-u64
replica and IndexedDB/outbox namespace. Reload reclaims the tab's stored
identity and offline log. A browser without Web Locks is explicitly blocked
from collaborative editing rather than being allowed to share a writer ID.
Web Locks require a supporting browser in a secure context (localhost or
HTTPS).

## Validation and wire compatibility

The TypeScript mapper and C++ engine share a closed attribute vocabulary.
Strings are limited to 256 UTF-8 bytes and reject controls. Links permit
HTTP(S), mailto, tel, root-relative paths other than `//`, and fragments;
script URLs are rejected. CSS values use a restricted character vocabulary;
font sizes must be 1–400px. Unknown register names remain invalid. The
existing JSON string encoder is reused for native visible JSON and WASM
stream JSON, including quotes, backslashes and controls.

Operations, snapshots and WebSocket envelopes remain **version 1**. The
additive capability is **`rich-text-v2`**, carried in hello and hello_ack.
This is a deployment gate, not permission to send new data to an old engine.

| Compatibility boundary | Behavior |
| --- | --- |
| Old client → new gateway | Missing capability rejected before authentication, join or fanout; v1-decodable `unsupported_protocol_version` error tells the user to update/reload and keep site data |
| New client → old gateway | Missing acknowledgement capability stops sync before requesting a token; visible update message and no automatic reconnect loop |
| Cached old JS worker | Worker initialization capability checked before the bridge enables editing; **Reload Concord** and **Waiting for update** shown |
| Cached old WASM | `_concord_rich_text_version() === 2` checked before creating/importing a native instance; persisted state remains intact |

The updated client can retain local edits while an incompatible gateway
prevents sync. An incompatible local worker/engine disables editing because
it cannot safely interpret the representation. Update failures do not route
through whole-document autosave or clear IndexedDB.

Large gateway batch IDs, including restore broadcasts, remain u64 on the
wire. The JS decoder uses a decimal string above `Number.MAX_SAFE_INTEGER`
instead of rounding or rejecting the frame. Ordinary small IDs stay numeric.

## Deployment sequence

1. Build the native worker, Rust gateway, WASM, JS worker and web app from
   the same revision. The committed public worker/WASM assets are included
   in this change.
2. Deploy those artifacts together. There is no rolling mixed-client mode
   allowing older engines to join rich-text documents.
3. Reload open tabs to acquire the current web, worker and engine assets.
   Keep browser site data; this carries offline work and replica ownership.
4. Confirm the connected indicator, then verify one two-user formatting
   edit and reload before treating a hosted deployment as verified.

Existing v1 snapshots and operation histories remain readable by the updated
engine. No schema migration or baseline rewrite is required. Formatting
that an older mapper already discarded cannot be reconstructed automatically.
Production deployment was not performed as part of this local implementation.

## Reproduce the checks

Use Node 24 and the repository's installed dependencies. The native/WASM
toolchain, local PostgreSQL/NATS/Redis and Clerk development credentials are
the same prerequisites as [the existing test guide](TESTING.md). Do not run
separate database-reset or broker-fault suites concurrently against shared
test services.

```sh
# Build current native and gateway artifacts.
cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release -DCONCORD_BUILD_TESTS=ON
cmake --build build/native
cargo build --manifest-path rust/Cargo.toml -p sync-gateway --release

# Build and verify browser engine artifacts.
npm run wasm:build
npm run worker:bundle
npm run wasm:smoke
ctest --test-dir build/native --output-on-failure

# Unit, live transport, database and existing browser regressions.
npm test
npm run test:realtime
npm run test:db
npm run test:browser

# Feature-specific real browser demonstration (headed or omit --headed).
npm run test:rich-text:browser -- --headed

# Release compilation and source checks.
npm run build
npm run typecheck
npm run lint
```

On this Mac, native commands used the scoped
`DEVELOPER_DIR=/Library/Developer/CommandLineTools` because the selected
Xcode installation had an unaccepted licence. No global developer setting
or licence was changed. Emscripten must be available for the WASM build.

The standalone demonstration reuses `scripts/browser-e2e-setup.mjs`, the
installed Playwright and existing sign-in/editor helpers. It creates an
isolated `concord_e2e` database, disposable Clerk users/organizations and
loopback app/gateway processes. Teardown removes those auth fixtures and
processes. It does not reset the development database. Its local screenshots
and machine-readable result go to `output/playwright/rich-text/`, which is
ignored by Git. The selected successful evidence is copied into
`docs/assets/rich-text/` for review.
