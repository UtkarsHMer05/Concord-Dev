# Signed document history

Concordpack v2 carries a document's retained CRDT operations, finalized
snapshots, saved revisions, and signed provenance. Verify the file against
independently trusted source details, then restore it as a new private
document. The source server can be offline during verification or restoration.

## Export, verify, and restore in the browser

1. Open a collaboratively synced document and wait for pending edits to save.
   Open **Review & history → Concordpack → Export signed history**. Export
   refuses local-only content, sync errors, pending edits, or a server state
   that differs from the local replica.
2. Download **verification details** separately. Deliver the trusted public
   key, source document UUID, expected saved version, and base snapshot
   boundary through an independently trusted channel. A key supplied only by
   the archive cannot establish trust.
3. On the recipient instance, open any document's **Concordpack** tab. Choose
   the history archive, then load the trusted JSON file or paste its contents.
   Click **Verify signed archive**. WebCrypto checks the signature and
   checksums; the browser WASM engine reconstructs the retained states before
   showing a read-only preview. Verification uses local computation once the
   editor's verification assets have loaded.
4. Choose a title and click **Restore as new document**. The destination
   gateway must independently authorize the source signing key. It repeats
   native verification, then creates a personal document owned by the signed-in
   user. Original source collaborators receive no automatic access.
5. Open the restored document. Its **History** tab exposes the imported saved
   revisions. **View import provenance** shows the original signed manifest,
   trusted details, and mappings to destination identities. Use **Share** to
   grant access deliberately.

![Verified archive and private restoration action](assets/concordpack/verified.png)

If the import response is lost, retry with the same file, title, and trusted
details. The UI retains the request UUID across reloads; reselecting the file
returns the original restored document. It stores only retry metadata in
`localStorage`, never the archive itself. Server idempotency is scoped to the
request UUID and actor; a different UUID represents a separate import.

## Verify without the application

Build the CLI and native worker from this checkout with Rust, C++20, CMake,
and Ninja available:

```bash
cmake -S cpp -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build/native --target concord-worker
(cd rust && cargo build --release -p sync-gateway --bins)
```

Run with the archive and a separately obtained trust record:

```bash
./rust/target/release/concordpack-verify \
  --bundle document.concordpack \
  --trust trusted-history.json \
  --worker ./build/native/worker/concord-worker
```

No database, Clerk account, gateway, or network connection is used. The CLI
prints JSON with the source document, version, digest, retained record counts,
and each revision's expected digest. Rejection exits nonzero. The two native
binaries and the two input files suffice on a compatible host.

The trust record has this shape; replace placeholders with independently
confirmed values, or use the owner's separately delivered download:

```json
{
  "publicKey": "<64 lowercase hexadecimal characters from a trusted source>",
  "documentId": "<expected source document UUID>",
  "seq": "410",
  "baseSnapshotSeq": "0",
  "revisionId": null
}
```

Sequences are canonical decimal strings. `revisionId` optionally pins a known
reconstructable revision UUID in addition to the source document, saved
version, and snapshot boundary. Keys and expected context are never learned
implicitly from the file being verified. Trusted JSON files are capped at
4 KiB.

## Configure the servers

- **Source:** configure `GATEWAY_WORKER_BINARY` and a stable
  `GATEWAY_SIGNING_KEY`, a server-only 32-byte Ed25519 seed encoded as 64
  hexadecimal characters. An ephemeral signer cannot export v2 history. Keep the seed in
  runtime secrets and retain the corresponding public key when rotating it.
- **Destination:** configure `GATEWAY_WORKER_BINARY` and
  `GATEWAY_TRUSTED_IMPORT_KEYS`, a comma-separated list of independently
  approved source public keys in 64-character lowercase hex. The destination's
  own stable public key is also accepted. Unknown keys fail before native
  reconstruction; malformed trust configuration refuses imports.
- **Recipient:** provide independently trusted verification details even when
  the destination has authorized the source signer. A server allowlist and
  the recipient's expected document/version serve different checks.

The existing `.env.example` and [configuration contract](CONFIGURATION.md)
describe these settings. No new dependency or hosted verification service is
required.

## What is preserved

| Data | Restored behavior |
|---|---|
| Retained operations | Original operation bytes, item identities, and replica identities remain unchanged. Database sequence boundaries are remapped in order to fresh destination values. |
| Finalized snapshots | Inner CRDT bytes and digests remain unchanged. Wrappers bind them to the new document UUID and mapped boundary. |
| Saved revisions | Named/automatic checkpoints and restore events retain labels, time, source links, and reconstructable states. Revision UUIDs are mapped to new UUIDs. |
| Original authorship | Known replica-owner UUIDs and revision authors remain in signed provenance. They are not destination principals; imported revision `created_by` is null. Unknown legacy authors stay explicitly unknown. |
| Earlier imports | Re-export includes the prior signed manifest, trust record, and identity mappings, preserving the retained provenance chain. |
| Access | The importing actor owns a personal document with no organization or copied ACL grants. |

Import uses one PostgreSQL transaction for document ownership, raw operations,
snapshot wrappers, revisions, historical replica quarantine, original archive
bytes, signed provenance, identity mappings, and audit. A failure rolls back
all these records. An exact retry returns the same document; changed metadata
with the same request UUID conflicts, and a different actor cannot reuse it.

Historical identities are quarantined from new client writes, including
identities in snapshots, pending operations, and missing references. A fresh
browser replica can edit normally. Owner-only history restore appends new
operations through the existing durable path.

## Guarantees and limits

- Ed25519 signs a domain-separated SHA-256 digest of the canonical manifest.
  The manifest binds source context, record identities, retained operation
  Merkle root, payload checksum, and expected state digests. The binary file
  starts with `CNCP`, version byte `2`, a little-endian manifest length,
  compact JSON, then snapshot bytes followed by operation bytes.
- Native/WASM verification reconstructs the current state and every available
  retained revision. Finalized snapshots are checked against their own digest
  and, where the retained log permits, against replay. The native verifier
  also validates operation structure and historical replica identities.
- **A signature authenticates a trusted server's statement. It does not
  independently prove that the server physically persisted data.**
- A protected exact snapshot can preserve a revision after compaction. A
  revision whose required state was genuinely pruned remains an unavailable
  record; the importer never invents the missing prefix. Boundary zero is the
  known empty initial state.
- Files are capped at **64 MiB**, including a **16 MiB manifest**; exports are
  capped at **1,000,000 operations, 500 finalized snapshots, and 200 revisions**.
  Exceeding a bound rejects the export, rather than silently truncating history.
  Finalized snapshots referenced by the retained archive are included.
- V2 archives carry CRDT-backed document history. Local-only whole-document
  content, source permissions, organization membership, comments, suggestions,
  and the shared-branch graph are outside this archive. Source revision and
  replica actor IDs are provenance, not independently established real-world
  identities.
- V1 local bundles remain compatible. They verify content integrity and apply
  supported visible content as new edits in the open document; they do not
  transplant operation history. Existing server receipts remain available.

The same-origin browser API exposes `GET /api/gateway/documents/{id}/concordpack`,
`GET /api/gateway/documents/{id}/concordpack/provenance`, and
`POST /api/gateway/concordpack/import`. The proxy forwards only fixed gateway
paths; the gateway verifies Clerk tokens and source read access. Import
requires authenticated personal ownership, separately authorized trust, and
the binary content type `application/vnd.concord.concordpack`. History rate
limits and body bounds apply; requests and responses are not cached by the
web proxy.

## Verification

With the local PostgreSQL/NATS/Redis stack running, a Clerk **development**
instance configured in `.env.local`, the release gateway and native worker
built, and Chromium installed:

```bash
CONCORD_E2E_MODE=production npm run test:concordpack:browser
```

The existing browser harness provisions disposable Clerk users and recreates
only its dedicated `concord_e2e` database. The command exports a rich-text
document with two revisions, stops the source web/gateway, verifies offline
with service environment variables cleared, rejects corruption and an
untrusted key, then restores into a freshly provisioned destination. It
checks unchanged operation bytes, matching revision digests, lost-response
retry across reload, private access, continued editing, history restore,
provenance, accessibility, and mobile overflow. Evidence is written to
`output/playwright/concordpack/`.

The [acceptance report](audits/CONCORDPACK_REPORT.md) records the checked-in
evidence and the native/database regression commands. The ordinary unit suite
includes WASM-backed trust, corruption, and revision-state checks.
