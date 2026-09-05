# Convex → PostgreSQL Migration (Phase 1)

Status: Authoritative
Version: 1.0
Last updated: 2026-09-06

This document records how Concord's temporary Convex persistence (Phase 0) was
replaced by PostgreSQL (Phase 1): the data mapping, the migration procedure,
verification criteria, and the rollback boundary. It contains no user data.

Related: [DATABASE.md](DATABASE.md) (target schema),
[AUTHORIZATION.md](AUTHORIZATION.md) (new authorization model),
[DECISIONS.md](DECISIONS.md) (DEC-003, DEC-019).

---

## 1. Background

Phase 0 removed Liveblocks and used Convex as transitional persistence: a
single `documents` table (title, template `initialContent`, `ownerId` =
Clerk user subject, optional `organizationId` = Clerk organization id, and a
transitional `content` string holding the versioned TipTap envelope
`{v:1, doc}`). Access control was owner-or-same-organization at the function
level; there were no roles, ACLs, or audit records.

Phase 1 replaces this with a PostgreSQL control plane (users, organizations,
memberships, documents with versioned optimistic concurrency, explicit ACLs,
audit events) and removes Convex entirely.

## 2. Data mapping

| Convex `documents` field | PostgreSQL destination |
|---|---|
| `_id` (Convex row id) | `documents.legacy_convex_id` (nullable, UNIQUE — traceability only) |
| `title` | `documents.title` |
| `ownerId` (Clerk user subject) | `users.clerk_user_id` → `users.id` → `documents.owner_user_id` |
| `organizationId` (Clerk org id) | `organizations.clerk_organization_id` → `organizations.id` → `documents.organization_id` (org row projected if absent) |
| `initialContent` (template HTML) | `documents.initial_content` |
| `content` (envelope JSON string) | `documents.content` (JSONB object, parsed) |
| `_creationTime` (epoch ms) | `documents.created_at` (and `updated_at`) |
| `roomId` (Liveblocks leftover) | not migrated (dead since Phase 0) |

Version counters start at 1 for migrated rows (no prior concurrency state
exists to preserve). Memberships are NOT reconstructed from Convex data —
they are projected from verified Clerk session claims at request time, exactly
like all other authorization state.

Authorization-model differences applied during migration (intentional,
documented):

- Delete becomes owner-only (Phase 0 allowed any organization member to
  delete organization documents — an over-permissive bootstrap behavior).
- Rename requires EDITOR-effective role; organization membership yields
  effective EDITOR, so existing organization workflows are preserved.
- Search becomes case-insensitive substring matching (`ILIKE '%q%'` with
  escaped wildcards), a deliberate superset of Convex token-prefix search.

## 3. Procedure

1. **Inventory** — enumerate non-empty Convex tables on the local deployment
   before cutover (M005/M039). If no meaningful rows exist, the empty path is
   recorded explicitly (0 rows) and no fabricated dataset is imported.
2. **Export** — `npx convex export` against the local deployment produces a
   ZIP of JSONL table dumps. The artifact is stored under a git-ignored
   private path (`.agent/checkpoints/`) and is never committed.
3. **Import** — a one-time idempotent import script
   (`scripts/migrate-convex-to-postgres.mjs`) reads the export, projects
   principals (`clerk_user_id`, `clerk_organization_id`) with `ON CONFLICT`
   upserts, inserts documents keyed by `legacy_convex_id` (re-runs update
   rather than duplicating), and prints a mapping summary.
4. **Verify** — the script asserts, per row: title equality, organization
   scope equality, owner mapping correctness, and deep-equality of the parsed
   content envelope; then prints row-count totals which are compared against
   the export counts.
5. **Cutover** — the application switches to the PostgreSQL services
   (M032–M038); a parity checkpoint commit is made (M040) before Convex code
   removal (M041).

## 4. Verification criteria

- Row counts: `documents` imported == `documents` exported (unless the empty
  path: 0 == 0 recorded).
- Spot + exhaustive checks: every imported row matches its Convex source on
  title, owner principal, organization scope, and parsed content envelope.
- Product-level parity per the Phase 1 acceptance matrix: migrated documents
  open with their original title and content, and remain editable/searchable.
- Idempotency: running the import twice changes nothing (upsert on
  `legacy_convex_id`).

## 5. Rollback boundary

The last commit before Convex removal (M040 parity checkpoint) plus the
private export artifact together form the rollback point: reverting to that
commit restores the working Convex-backed application, and the export retains
the pre-migration data. No dual-write architecture is used; after cutover,
PostgreSQL is the single source of truth (the export is a snapshot, not a
live system).

## 6. Outcome

Recorded in the Phase 1 completion report: rows found / exported / imported,
verification method, and confirmation that no Convex runtime dependency
remains.
