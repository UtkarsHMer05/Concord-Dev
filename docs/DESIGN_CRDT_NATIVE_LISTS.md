# Design: CRDT-native lists (Feature 10 — INVESTIGATION ONLY)

Status: **design written, C++ work NOT started** (per scope: no core changes
without a fresh go-ahead). This document answers the handoff's question and
lays out the implementation path, costs, and risks.

## Investigation findings (verified against the code, 2026-09-26)

**Question: does `localInsertDelimiter(index, blockType)` already model list
blocks in the C++ core?**

Answer: the delimiter machinery is FULLY general — blocks are first-class
CRDT citizens — but the block-type REGISTRY is closed to paragraphs and
headings. Specifically:

- `Doc::local_insert_delimiter(stream_index, block_type)`
  (`cpp/crdt/src/doc.cpp:79`) stores the block type as an INITIAL ATTR on the
  delimiter item (`op.initial_attrs.push_back({"type", block_type})`) and
  validates it against `AllowedAttrs::is_allowed_value`
  (`cpp/crdt/include/concord/crdt/item.hpp:23`): `paragraph | heading-1..6`
  only. An unknown type throws `InvalidAttributeValue` — fail-closed.
- Block attributes are per-delimiter LWW registers (`AttrMap`, ordered map →
  canonical iteration), already extended to `align` and `lineHeight`. The
  same machinery carries any future block attribute.
- `VisibleBlock {type, attrs, chars}` is the canonical view; the digest folds
  it — so ANY new block type flows through digest/serialization/snapshots
  with ZERO wire-protocol changes (a block type is just an attr value string
  in the registry).
- The TypeScript adapter (`src/lib/crdt/pm-model.ts`) accepts
  paragraph/heading only; TipTap lists (bulletList/orderedList/taskList —
  nested node structures) force whole-document fallback mode
  (`collaborative-mode-indicator.tsx`). Text color is likewise outside the
  mark registry (`bold/italic/underline/strikethrough`), which is why
  "colors" appears in the fallback message too.

**Conclusion:** lists do NOT need a new op format, nesting nodes, or any
wire change. The work is (a) a registry extension in C++, (b) a
flatten/unflatten mapping in pm-model, (c) flipping the adapter's
supported-set — in ascending risk order, all client-visible behavior
preserved.

## Proposed design: flat list-item blocks with structural attributes

TipTap models lists as nested nodes (bulletList > listItem > paragraph).
The CRDT's canonical model is a FLAT block sequence. Forcing nested CRDT
nodes would be a deep, risky change; instead, map lists onto the existing
flat model the same way the adapter already flattens runs:

- **Registry extension** (`AllowedAttrs`):
  - block types add `list-item` (and optionally `task-item` later);
  - new block attr `list` — values `bullet | ordered` (absent = none);
  - new block attr `depth` — values `0..8` (fixed set, checked like
    `lineHeight`).
  A 3-level bulleted list is then: `list-item{list=bullet,depth=0}`,
  `list-item{list=bullet,depth=1}`, `list-item{list=bullet,depth=2}` …
  Task lists: `list-item{list=task}` + `checked` attr (`yes|no`) — LWW on
  the checkbox is exactly the right CRDT semantics for concurrent toggles.
- **Adapter mapping** (`pm-model.ts`):
  - pm→canonical: walk bulletList/orderedList/taskList nodes depth-first,
    emit one `list-item` block per listItem child (depth = nesting level),
    inline its paragraph content as chars.
  - canonical→pm: group CONSECUTIVE `list-item` blocks with equal
    (list, depth-class) into nested `bulletList/orderedList` structures.
    Nesting reconstruction is deterministic because depth changes are
    bounded (±1 between siblings in well-formed input) — malformed
    sequences (depth jump > 1) clamp to the previous depth, keeping the
    round trip total (never throws, never drops content).
- **Anchoring/comments/presence**: unchanged — text inside a list block is
  ordinary text items; `textItemPositions` only needs the paragraph/heading
  type check widened to `list-item` (blocks.length alignment already holds).
- **Compatibility cliff (the real design decision):** an OLD replica/wasm
  receiving a `list-item` delimiter op fails `InvalidAttributeValue` on
  apply — a durable op it can never integrate. Mitigations, in order of
  preference:
  1. Accept-unknown-block-type policy change in C++ (keep the item, expose
     it as an opaque block) — preserves convergence with old + new replicas
     mixed; the old client just renders the block in fallback styling.
  2. Or gate the feature behind the wire protocol version negotiation
     (bump WIRE_VERSION) — heavier, honest but excludes mixed fleets.
  Recommendation: (1), implemented in the same C++ change as the registry
  extension, with a digest-stability test proving unknown-type blocks do not
  change the canonical digest of EXISTING content.

## Cost estimate

- C++ registry + accept-unknown policy + tests: ~1 day (single file +
  ctest additions).
- pm-model flatten/unflatten + bridge allowlist + anchors widening + unit
  tests: ~1–2 days (the mapping fidelity for arbitrary nesting is the
  careful part).
- Fallback flip (bridge mode indicator, collaborative-mode detector) +
  browser E2E for two-browser list editing: ~1 day.
- Total: roughly 3–4 focused days. Risk: moderate, concentrated in
  pm-model mapping fidelity and the mixed-replica compatibility path.

## Explicitly NOT proposed

- Nested CRDT nodes (list containers as CRDT items) — high risk, no user
  benefit over flat blocks with depth attrs.
- Tables/images in the same pass — different mapping problems (object
  identity, sizing), keep them in fallback mode.
