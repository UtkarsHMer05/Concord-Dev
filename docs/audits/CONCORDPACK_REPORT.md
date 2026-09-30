# Feature 4: independently verifiable document history

Verified locally on 2026-10-01 on macOS arm64 with Node 24 and production
Chromium. Acceptance exercised base revision
`52c1e6b09efb30fac9539b40462a51d3a46fb8a7` plus this feature's working changes.
Exact browser run times, archive checksum, environment, and results are in
[report.json](../assets/concordpack/report.json). The standalone verifier's
result is preserved in [offline.json](../assets/concordpack/offline.json).

## Implemented behavior

Concordpack v2 exports signed retained operations, finalized snapshots, saved
revisions, and original author provenance. Verification pins an independently
supplied public key, source document UUID, saved version, base snapshot
boundary, and optional known revision UUID. The same native verifier serves
the standalone CLI and durable importer; browser verification uses WebCrypto
and the existing WASM CRDT engine.

The editor's **Concordpack** tab offers export, a separate trusted-details
download, archive/trust-file selection, local verification and content preview,
private restoration, safe retry, and import provenance. The README explains
the feature through the working UI and links the
[workflow and configuration guide](../CONCORDPACK.md).

Import creates a fresh personal document owned by the importing actor. One
transaction commits raw operation bytes, snapshot wrappers, saved revisions,
historical replica quarantine, original archive, signed provenance, identity
mappings, and audit. Source grants and organization membership are not copied.
Original operation/item/replica identities stay unchanged; database cursors,
snapshot UUIDs, and revision UUIDs receive ordered destination mappings.
Original authors remain provenance rather than destination principals.

The gateway requires an independently configured source signer policy before
import. It rejects an unknown signer before reading/reconstructing the archive.
The proxy uses fixed authenticated paths, bounded binary bodies, and no-store
responses. Existing history compute limits also cover the new endpoints.

## Correctness fixes needed by restoration

- **Compacted durable head:** the shared cursor query includes the compaction
  floor when all raw operation rows have been removed. History and branch
  consumers use this same durable-head contract.
- **Protected historical states:** exact finalized snapshots remain valid
  checkpoint/restore bases at or below the floor. Missing prefixes fail closed
  instead of producing a preview from incomplete history.
- **Historical replica ownership:** native inspection includes applied item
  identities, pending writers, and missing references. Verification inspects
  retained snapshots and the reconstructed head, so tail-only references are
  quarantined too.
- **Import recovery:** an exact request retry returns the already committed
  document. Changing its title/trust/archive conflicts; another actor cannot
  reuse the request identity. The UI keeps retry metadata across reloads.
- **Accessible provenance:** the scrolling provenance region can receive
  keyboard focus. The form fits the tested mobile viewport.

The snapshot-only native scenario is separate from the full round-trip test
to avoid nesting large debug async polling frames on the test thread's small
stack. Both run with the default test stack; no increased stack setting or
dependency skip is required by the new tests.

## Browser and offline acceptance

All six stages passed using real Clerk development tokens, a disposable
PostgreSQL database, rebuilt Rust release gateway, native C++ worker, and
production Next.js servers:

| Stage | Observed result |
|---|---|
| Signed export | Task-list content, two named revisions, and two finalized snapshots exported through the editor UI. |
| Source shutdown + offline verification | Source web/gateway stopped; copied CLI and native worker verified the archive with all service environment variables cleared. |
| Rejection | Modified payload and independently supplied wrong key rejected by both CLI and browser; browser restoration remained disabled. |
| Fresh restoration | A newly provisioned destination restored all 210 retained operation payloads/identities, both snapshots, and both historical revision digests. |
| Lost response + reload | The first import committed, then its response was replaced with 503. Reselecting inputs after reload reused the UUID and left exactly one document, import record, and audit event. |
| Continued use | Fresh-replica editing survived reload; owner history restore appended new operations and recovered the earlier content. An unrelated account received 404 for provenance. Original signed provenance remained unchanged. |

Axe WCAG 2 A/AA and 2.1 AA found **0 violations** on the archive/provenance
surface. The 390 × 844 viewport had **no page-level horizontal overflow**.
The harness recorded no unexpected browser errors and cleaned up its
disposable users, organizations, and source/destination processes.

![Restored retained revision and matching preview](../assets/concordpack/history.png)

## Local checks

| Check | Result |
|---|---|
| Web unit tests | **314 passed**, 2 intentional opt-in/driver skips |
| TypeScript + ESLint | Passed |
| Production Next.js builds | Passed for source and destination |
| Native CTest | **3 suites passed**: core, property smoke, and worker |
| Rust unit tests | **104 passed**, 1 intentionally ignored fixture generator |
| Signed-history integration | **2 passed**, using real PostgreSQL and native worker; missing prerequisites fail this test rather than report success |
| History / migrations | **11 + 4 passed** |
| Selected gateway / recovery integration | **68 passed** across the suites below |
| Rust formatting + clippy | Passed, all targets, warnings denied |

The signed-history integration additionally checks source read authorization,
every independent trust field, signed invalid digests, truncation, transaction
rollback injected after content inserts, retry conflicts and cross-actor
denial, unchanged operation bytes, snapshot-only compaction, retained and
genuinely pruned revisions, pending snapshot/tail reference quarantine, and
provenance preservation on re-export.

Commands used (the macOS run selected the installed Command Line Tools with
`DEVELOPER_DIR=/Library/Developer/CommandLineTools` for native builds):

```bash
npm run typecheck
npm run lint
npm test
cmake --build build/native
ctest --test-dir build/native --output-on-failure

cd rust
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test -p sync-gateway --test concordpack --test phase5_history \
  --test phase5_migrations -- --test-threads=1
cargo test -p sync-gateway --lib --test db_integration --test proofs_api \
  --test phase5_snapshots --test phase5_pipeline --test phase5_recovery \
  --test phase5_compaction --test phase5_restore_concurrency \
  --test phase5_retention --test phase5_security --test ws_integration \
  --test phase5_resync -- --test-threads=1
cargo build --release -p sync-gateway --bins
cd ..
CONCORD_E2E_MODE=production npm run test:concordpack:browser
```

The Phase 5 CI workflow now runs the native/PostgreSQL signed-history
integration gate. Authenticated browser acceptance remains local and requires
the development Clerk configuration described in the guide.

## Boundaries

The archive preserves **retained CRDT document history**. Previously pruned
states stay unavailable; source ACLs, comments, suggestions, organization
memberships, and shared-branch relationships are outside this format.
Local-only whole-document fallback content cannot be exported as signed CRDT
history. The destination is a private personal document; sharing is deliberate.

The explicit limits are 64 MiB total, 16 MiB manifest, 1,000,000 operations,
500 finalized snapshots, and 200 revisions. Oversized exports reject rather
than silently dropping records. V1 content bundles remain compatible.

A trusted signature authenticates the server's statement. It does not prove
physical persistence or establish a person's real-world identity from an
actor UUID. This report covers local infrastructure and browser acceptance;
hosted deployment was not exercised. Performance comparisons from feature 5
were not added, and the README's historical benchmark results remain unchanged.
