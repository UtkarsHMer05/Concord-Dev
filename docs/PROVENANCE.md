# Concord source provenance and release status

Concord started from the Code With Antonio Google Docs Clone tutorial. The
pristine source remains at `antonio-original-baseline`
(`942035cb8498a2de936b21425cba66c9ec7dc69e`); do not remove or rewrite
that tag. The C++ CRDT/worker, Rust gateway/protocol, PostgreSQL durable
plane, and browser synchronization runtime were added during Concord's
engineering phases. This does **not** make every retained web component
original or automatically grant redistribution rights.

## Machine-assisted path inventory

Run `python3 scripts/audit-provenance.py > docs/audits/provenance-paths.tsv`.
The [full TSV](audits/provenance-paths.tsv) has baseline and current Git blob
IDs for every `src/` and `public/` path, including removed and new files.
It compares the actual worktree (including uncommitted changes), not only
HEAD. An identical blob proves byte identity; a changed blob **does not**
prove independent authorship or permission.

| Area | Identical baseline | Changed | Removed | New |
|---|---:|---:|---:|---:|
| `src/` | 16 | 23 | 52 | 51 |
| `public/` | 0 | 8 | 5 | 3 |

All 13 baseline `public/*.svg` files were byte-identical before this
hardening pass. Seven thumbnails and the logo now have independently
written, abstract Concord SVG designs; five unused starter icons were
removed. The tutorial template copy in `src/constants/templates.ts` was
rewritten around Concord-specific prompts. The inherited favicon and two
unused Geist font files were removed; `src/app/icon.svg` uses the new mark.
The new `public/crdt-worker.js` and `public/wasm/*` entries are generated
from project source/toolchain rather than tutorial artwork.

## Retained material requiring a decision

- **Unchanged source:** ten `src/components/ui/*.tsx` UI primitives, plus
  `src/app/documents/[documentId]/loading.tsx`, `src/constants/margins.ts`,
  two `src/extensions/*.ts` files, `src/hooks/use-search-param.ts`,
  `src/lib/utils.ts`, and `src/store/use-editor-store.ts`. Some primitives
  may derive from upstream component libraries, but each exact source and
  license still needs attribution or an independent replacement.
- **Modified tutorial shell:** 23 baseline source files changed in place,
  notably the home/gallery/navbar/editor/toolbar/ruler components and CSS.
  The backend and editor synchronization were reimplemented, but visual
  structure and portions of UI code remain linked to the baseline. Review
  each file's retained expression before asserting a clean-room shell.
- **Third parties:** lockfiles and generated SBOMs enumerate packages;
  platform-specific binaries (including `sharp`/`@img/sharp-libvips`) need
  version- and distribution-specific notices/source obligations reviewed.
  The existing SBOMs under `scripts/sbom/` predate this branch and must be
  regenerated before any release.

An independent grant from the tutorial author has not been established.
A community clone's MIT file would not establish a license for this
baseline. The [upstream course](https://www.codewithantonio.com/) and
[sharp-libvips notices](https://github.com/lovell/sharp-libvips/blob/main/THIRD-PARTY-NOTICES.md)
are reference points, not substitute permissions.

## Release decision

No root LICENSE is asserted. The unpublished Rust crate no longer declares
MIT while this source tree is unresolved; the npm package remains private.
Do not describe the current tree as clean-room or redistribution-ready.
Finish the retained-source review/replacement, verify third-party notices,
regenerate SBOMs, then choose and apply a repository license consistently
across manifests and release metadata. The asset replacement resolves one
visible portion of the blocker, not the blocker itself.
