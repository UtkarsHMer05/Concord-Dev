# Concord

Concord is a local-first collaborative document workspace. This repository is
being rebuilt around a self-engineered synchronization stack (CRDT core,
realtime gateway, durable update log); the current release is the verified
Phase 1 foundation: a modernized editor application on a self-owned
PostgreSQL control plane with server-side authorization and a vendor-neutral
collaboration seam.

Additional engineering documentation: [docs/PRD.md](docs/PRD.md),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DECISIONS.md](docs/DECISIONS.md),
[docs/ROADMAP.md](docs/ROADMAP.md), [docs/DATABASE.md](docs/DATABASE.md),
[docs/AUTHORIZATION.md](docs/AUTHORIZATION.md).

## Current capabilities

- Email sign-in/sign-out and organizations via Clerk; identity is delegated
  to Clerk, while all authorization decisions (OWNER / EDITOR / COMMENTER /
  VIEWER) are enforced server-side against Concord-owned data.
- Documents: create (blank or from templates), rename, delete (owner-only),
  listing with incremental loading, title search — all scoped per user and
  organization in SQL.
- Durable PostgreSQL persistence with tracked migrations; concurrent editors
  cannot silently overwrite each other (version-checked saves with an
  explicit conflict experience).
- Audit events for security-relevant mutations (create, rename, delete,
  permission changes).
- Rich-text editor (TipTap): headings, styling, color/highlight, font
  family/size, line height, alignment, lists, tasks, tables, images with
  resize, links, local undo/redo, page margins with a draggable ruler, and
  export to JSON/HTML/TXT/print.

## Intentionally deferred (not yet implemented)

Realtime multi-user collaboration, presence, comments/threads, and
notifications are intentionally unavailable while Concord's own
synchronization stack is built in later phases. The UI consumes a neutral
collaboration interface (`src/lib/collaboration/`) so these capabilities can
be added without re-coupling the product to a vendor.

## Requirements

- Node.js 24 (`.nvmrc` pins 24.20.0; `nvm use`)
- npm 11
- Docker with Docker Compose (runs the local PostgreSQL instance)

## Getting started

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Start PostgreSQL and apply migrations:

   ```bash
   docker compose up -d db   # PostgreSQL 18 on localhost:5433 (local-only credentials)
   npm run db:migrate        # apply tracked migrations (creates the schema)
   ```

3. Configure environment variables in `.env.local` (see `.env.example` for
   the full list and local examples):

   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
   - `DATABASE_URL` (defaults to `postgres://concord:concord_local_dev@localhost:5433/concord`)

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000).

## Verification

```bash
npm run typecheck   # TypeScript, strict
npm run lint        # ESLint (flat config)
npm test            # unit tests (vitest)
npm run test:db     # PostgreSQL integration tests (needs DATABASE_TEST_URL)
npm run test:all    # both suites
npm run build       # production build
npm run smoke       # HTTP smoke checks against a running server
```

Integration tests run against the isolated `concord_test` database
(`DATABASE_TEST_URL`, created automatically on first `docker compose up` via
`scripts/db/init/`) and replay all migrations from an empty schema on every
run. `npm run db:test:prepare` recreates it from scratch at any time.

## Database workflow

Schema is defined in `src/server/db/schema.ts` (Drizzle) and changed only
through tracked SQL migrations in `drizzle/`:

```bash
npm run db:generate      # generate a new migration from schema changes
npm run db:migrate       # apply pending migrations (dev database)
npm run db:migrate:test  # apply pending migrations (test database)
npm run db:studio        # browse the schema/data in Drizzle Studio
```

See [docs/DATABASE.md](docs/DATABASE.md) for the schema, invariants, and
migration policy.

## Environment variables

Variable names used by the app (values are secrets or machine-local and are
never committed):

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `DATABASE_URL`, `DATABASE_TEST_URL`

## Provenance and attribution

This project originated from the Code With Antonio "Google Docs Clone"
tutorial (Next.js/React/Clerk/Convex/Liveblocks) and is being deliberately
rebuilt into an original engineering project. The pristine tutorial baseline
is preserved at the git tag `antonio-original-baseline`. Attribution to the
tutorial is retained; upstream licensing is under review before any public
release (see `docs/DECISIONS.md`).

## License

Not yet licensed for redistribution; licensing is resolved before public
release.
