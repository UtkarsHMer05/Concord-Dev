# Concord source provenance

Concord started from the Code With Antonio "Google Docs Clone" tutorial
(a commercial Next.js course project). The pristine source remains at
the immutable git tag `antonio-original-baseline`
(`942035cb8498a2de936b21425cba66c9ec7dc69e`); do not remove or rewrite
that tag. This document records what was retained, replaced, and
independently built, so a reviewer can verify every claim mechanically.

## What Concord independently built (100% original)

Everything below the product-shell chrome did not exist in the
baseline and is original engineering to this repository:

- **`cpp/`** — the C++20 sequence CRDT (YATA-style origin anchoring,
  tombstones, LWW attribute registers, canonical digests, snapshots,
  bounded executor), compiled native and to WebAssembly from one
  source.
- **`rust/`** — the Tokio/axum sync gateways: Clerk JWT verification
  (JWKS rotation cache, strict audience/party claims), trusted-proxy
  identity, durable PostgreSQL ingest (commit-before-ACK), NATS
  JetStream fanout, Redis ephemeral tier, snapshot/compaction/restore
  machinery, maintenance scheduler, Prometheus metrics.
- **`src/lib/crdt/`, `src/lib/collaboration/`, `src/lib/sync/`** — the
  browser local-first runtime: worker core over the WASM CRDT,
  IndexedDB durable op-log/snapshot store, outbox, resync, editor
  bridge/adapter.
- **`src/server/`** — the PostgreSQL data plane: schema, ActorContext
  authorization (deny-by-default RBAC), repositories, audit.
- **`drizzle/`, `scripts/`, `tests/`, `docs/`** — migrations, CI/
  deploy/security/backup tooling, the test suites, and the
  documentation set. The baseline had none of these.

## Machine-assisted path inventory

Run `python3 scripts/audit-provenance.py > docs/audits/provenance-
paths.tsv` (also enforced in CI by `scripts/security/provenance-
check.sh`). The [full TSV](audits/provenance-paths.tsv) carries
baseline and current git blob ids for every `src/` and `public/` path.
An identical blob proves byte identity; a changed blob does not prove
independent authorship — the per-file review below covers that.

Current state after the hardening pass (regenerate the TSV for live
counts): baseline 104 in-scope paths → **10 identical (all allowlisted
shadcn output), 36 changed, 55 new, 58 removed** (101 current paths).
The TSV intentionally scopes the carried-content review to `src/` and
`public/` (104 baseline paths); the enforcement gate scans the complete
baseline tree of 123 files, including documentation, configuration, and
tooling, and currently checks 54 overlapping shipped paths.

### Resolved categories

1. **Tutorial static assets — replaced/removed (commit `37a6832`).**
   All 13 baseline SVGs (logo, seven template thumbnails, five starter
   icons), the inherited favicon, and the unused Geist font files are
   gone. Seven thumbnails and the logo are newly authored abstract
   Concord designs; `src/constants/templates.ts` copy was rewritten
   around Concord-specific prompts.

2. **Tutorial-identical source — rewritten (commit `d228526`).** Six
   files that were byte-identical to the baseline (margins constants,
   the search hook, the editor store, the document loading page, and
   the font-size/line-height TipTap extensions) were replaced with
   original implementations preserving their public APIs. The loader
   component was renamed `DocumentLoadingIndicator`. `components.json`
   was regenerated with current shadcn schema keys.

3. **`src/components/ui/*` + `src/lib/utils.ts` — third-party, not
   tutorial authorship.** These 11 files are vendored output of the
   shadcn/ui component generator: verified 2026-09-12 byte-identical
   (up to the CLI's import-alias rewrite) against the MIT-licensed
   registry at `ui.shadcn.com/r/styles/new-york/*.json`. They are
   retained under upstream MIT with attribution in `NOTICE`, and are
   the only allowlisted paths in `scripts/security/provenance-check.sh`.

4. **Tutorial-derived editor chrome — replaced in this hardening
   pass.** The remaining baseline-derived pages (toolbar, editor
   navbar, ruler, home chrome, dialogs, search input) are rewritten as
   original code (see the `feat(web)`/`refactor(editor)` commits of
   this pass). The carried-over-line percentages that motivated the
   rewrite were measured by diff against the baseline tag (toolbar
   81%, navbar 73%, ruler 73%, search-input 84% before the pass).

5. **Third-party runtime dependencies** (Clerk, Next.js, React,
   TipTap/ProseMirror, radix, lucide, the Rust crate set) are consumed
   under their own licenses; `NOTICE` summarizes attribution and the
   SBOMs at `scripts/sbom/*.cdx.json` are the machine-readable
   inventory. Platform-specific binaries such as `sharp`/
   `@img/sharp-libvips` carry upstream LGPL notices — see NOTICE for
   the distribution-form caveat.

## Enforcement

`scripts/security/provenance-check.sh` runs in CI and fails if any
shipped file is byte-identical to the baseline without an allowlist
entry naming an upstream source, license, and verification date, or if
a known baseline binary asset reappears. This is the mechanical floor;
the per-file review is this document.

## License status

- **Original Concord code**: MIT — root `LICENSE`, copyright 2026
  Utkarsh Khajuria.
- **`src/components/ui/` + `src/lib/utils.ts`**: shadcn/ui output,
  upstream MIT, attributed in `NOTICE`.
- **Tutorial baseline material**: not in the distributable tree; the
  pristine baseline remains reachable only via the
  `antonio-original-baseline` git tag for historical transparency.
- **Rust workspace**: `license = "MIT"` (consistent with the root
  license); `rust/deny.toml` enforces the permissive third-party set.
- **npm package**: `private: true` (never published); the root LICENSE
  governs the repository.

No redistribution permission for baseline-derived material was ever
assumed: where provenance could not be established, the rule applied
throughout is replacement over risky redistribution.
