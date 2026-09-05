import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "../../src/server/db/schema";

/**
 * Shared helpers for PostgreSQL integration tests (isolated concord_test DB).
 */

export function getTestPool(): pg.Pool {
  const url = process.env.DATABASE_TEST_URL;
  if (!url) {
    throw new Error("DATABASE_TEST_URL is not set");
  }
  return new pg.Pool({ connectionString: url });
}

export type TestDb = NodePgDatabase<typeof schema>;

export function getTestDb(pool: pg.Pool): TestDb {
  return drizzle(pool, { schema });
}

const TABLES = [
  "audit_events",
  "document_user_permissions",
  "documents",
  "organization_memberships",
  "organizations",
  "users",
] as const;

/** Truncates all application tables for deterministic per-test isolation. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}
