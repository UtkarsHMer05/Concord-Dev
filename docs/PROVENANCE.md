# Concord source provenance and licensing status

Status: candidate-bound provenance statement · current release status<br>
`PENDING_FRESH_EVIDENCE`
Last updated: 2026-09-14

Concord began from the Code With Antonio “Google Docs Clone” tutorial (a
commercial Next.js course project). The pristine source is preserved at the
historical git tag `antonio-original-baseline`
(`942035cb8498a2de936b21425cba66c9ec7dc69e`). The tag and prior evidence must
not be removed or rewritten.

This document separates four different questions that were previously being
collapsed into one phrase such as “100% original”:

1. Where did a path come from?
2. Is it byte-identical to the tutorial baseline?
3. Is it generated or copied from a third-party source with a known license?
4. Is the current distribution legally permitted in the intended form?

An implementation change, a changed Git blob, or a passing scanner answers
only part of those questions. This is an engineering provenance record, not a
legal opinion or a blanket grant of rights.

## Current audit disposition

The implementation candidate is
`42dcb17dd26c11a05dd20109102f37ea3fb5135a`; the canonical evidence and
documentation are separate descendants of that SHA. The historical path
inventory and hardening report remain preserved checkpoint evidence. Fresh
mechanical provenance checks for the candidate report 54 baseline-overlapping
paths, 0 unallowlisted identical paths, and 14 regression assertions. Those
checks do not establish independent authorship or legal clearance.

Current disposition: `CANDIDATE_PENDING`.

Before a new release claim, the lead must regenerate the path inventory for
one clean candidate, review every baseline overlap and third-party/generated
path, reconcile `NOTICE` and SBOM pointers, and record any permission or legal
decision in the canonical ledger at
[`docs/audits/CANONICAL_RELEASE_LEDGER.json`](audits/CANONICAL_RELEASE_LEDGER.json).

## Provenance categories

### Concord-developed implementation areas

The following areas are described as Concord engineering in the repository's
architecture and history. The wording means that the project implementation
was developed in this repository; it does not erase third-party dependencies
or substitute for a current per-path review:

- **`cpp/`** — the C++ sequence CRDT, snapshots, digests, worker, and native
  verification code;
- **`rust/`** — the Tokio/axum gateway, authentication integration, durable
  PostgreSQL ingest, NATS/Redis integration, recovery, maintenance, and
  metrics code;
- **`src/lib/crdt/`, `src/lib/collaboration/`, `src/lib/sync/`** — the
  browser local-first runtime, worker boundary, IndexedDB outbox, sync, and
  editor bridge;
- **`src/server/`** — the PostgreSQL data layer, authorization, repositories,
  and audit services; and
- **`drizzle/`, `scripts/`, `tests/`, and the Concord documentation** —
  project migrations, tooling, tests, and explanatory material, subject to
  the same history and third-party review.

These descriptions are not a claim that every line in those directories was
written without an upstream influence. The path-level inventory and review
are the authority for a release candidate.

### Tutorial-derived material

The tutorial baseline is retained only as a historical comparison point. A
historical hardening pass recorded replacement/removal of baseline artwork,
fonts, template copy, and selected source files. Those results are tied to the
named checkpoint in the historical audit; they are not fresh evidence for the
current dirty checkout.

Do not describe the tutorial material as “fully resolved” until the candidate
inventory confirms the disposition of every overlapping shipped path and any
remaining permission question has an explicit decision. A changed blob alone
does not prove independent authorship or legal clearance.

### Generated and third-party material

The historical review identified `src/components/ui/*` and
`src/lib/utils.ts` as shadcn/ui-generated output retained under the upstream
license and attribution. Runtime dependencies such as Clerk, Next.js, React,
TipTap/ProseMirror, Radix, Lucide, and the Rust crate set are third-party
software consumed under their own licenses. Platform-specific packages may
carry additional notices; see `NOTICE` and the generated SBOMs.

Generated output is not tutorial authorship merely because it has a matching
or similar implementation. It still needs a source, license, attribution,
and distribution-form review.

## Machine-assisted inventory

For a selected clean candidate, run:

```bash
python3 scripts/audit-provenance.py > docs/audits/provenance-paths.tsv
bash scripts/security/provenance-check.sh
bash scripts/security/provenance-tests.sh
```

The [TSV inventory](audits/provenance-paths.tsv) records baseline/current Git
blob identifiers and states for its recorded snapshot. An identical blob is
evidence of byte identity. A changed blob is not, by itself, evidence of
independent authorship. The enforcement script is a mechanical floor; it does
not decide copyright, permission, or whether a generated component is
properly attributed.

The existing TSV and the historical hardening report contain checkpoint
counts. They remain unchanged as historical records and must not be quoted as
current counts without regeneration. No fresh count is asserted in this
document.

## Historical checkpoint record

The prior hardening evidence reported a baseline tag of
`antonio-original-baseline` at
`942035cb8498a2de936b21425cba66c9ec7dc69e` and a provenance scan at the
`v1.0.0-hardened.10` checkpoint. The corresponding public artifacts are:

- [`docs/audits/V1_HARDENING_FINAL_REPORT.md`](audits/V1_HARDENING_FINAL_REPORT.md),
  which is a historical campaign report;
- [`docs/audits/V1_HARDENING_FINDINGS.md`](audits/V1_HARDENING_FINDINGS.md), which is
  a historical findings snapshot; and
- [`docs/audits/provenance-paths.tsv`](audits/provenance-paths.tsv), which is a
  historical path-inventory snapshot.

Their recorded results are not deleted or rewritten. They are now explicitly
scoped to their checkpoint, and the current canonical report must carry fresh
candidate-bound output before any present-tense release claim.

## License and attribution status

- **Repository license metadata:** the root `LICENSE` and Rust workspace
  metadata are repository artifacts that must be checked for agreement on the
  selected candidate.
- **Third-party/generated components:** retain their upstream license and
  attribution; `NOTICE` is the human-readable attribution index and
  `scripts/sbom/` is the machine-readable dependency inventory.
- **Tutorial baseline:** the historical tag is preserved for transparency;
  preserving a tag does not mean that baseline material is authorized for
  redistribution in the shipped tree.
- **Legal status:** no sentence in this file grants permission. If a retained
  path cannot be attributed, replaced, or shown to be permitted, it remains a
  release blocker or requires an explicit legal/owner decision.

## Wording rules for public documents

| Avoid as an unqualified current claim | Use instead |
|---|---|
| “100% original” | “Concord-developed areas are identified; baseline and third-party paths are classified in the candidate inventory.” |
| “Tutorial licensing is fully resolved” | “The historical pass recorded replacements and allowlisted generated components; current candidate clearance is pending review.” |
| “The immutable release proves provenance” | “The named tag preserves a historical checkpoint; provenance still requires candidate-bound path evidence.” |
| “Changed files prove independent authorship” | “A changed blob proves non-identity only; authorship and permission require review.” |
| “MIT covers the whole repository” | “Repository license metadata and third-party notices are reconciled per path and distribution form.” |

## Candidate closure checklist

The lead may move this document out of `PENDING_FRESH_EVIDENCE` only when the
same clean candidate has:

- a regenerated path inventory and fail-closed provenance scan;
- a reviewed disposition for every baseline overlap, generated path, and
  third-party dependency relevant to distribution;
- matching `LICENSE`, `NOTICE`, Cargo metadata, and SBOM pointers;
- a documented permission/legal decision for anything not clearly authored or
  permissively licensed;
- a machine-readable result in the canonical ledger; and
- public wording that states exactly what was proved and what was not.
