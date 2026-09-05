import "server-only";

import { drizzle, type NodePgDatabase, type NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { Pool } from "pg";

import * as schema from "./schema";
import { getServerEnv } from "../env";

/**
 * Server-only PostgreSQL access.
 *
 * The pool is cached on globalThis so Next.js dev-mode module reloads reuse a
 * single pool instead of leaking one per reload. In production (single module
 * instance) the global cache is simply the same value every time.
 */

const globalForDb = globalThis as unknown as {
  __concordPgPool?: Pool;
};

export function getDbPool(): Pool {
  if (globalForDb.__concordPgPool) {
    return globalForDb.__concordPgPool;
  }
  const env = getServerEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Swallow idle-client errors quietly (they would crash the process
  // otherwise); real query errors propagate to their callers.
  pool.on("error", (error) => {
    console.error("[db] idle client error:", error.message);
  });
  globalForDb.__concordPgPool = pool;
  return pool;
}

export type Database = NodePgDatabase<typeof schema>;

/**
 * Anything that can execute queries: the root database or a transaction.
 * Repositories accept an optional executor so services can compose
 * transactional operations.
 */
export type Executor =
  | Database
  | PgTransaction<
      NodePgQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

export function getDb(): Database {
  return drizzle(getDbPool(), { schema });
}

/** Minimal connectivity/health probe. */
export async function pingDb(): Promise<{ ok: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  const pool = getDbPool();
  const result = await pool.query("SELECT 1 AS ok");
  return {
    ok: result.rows[0]?.ok === 1,
    latencyMs: Date.now() - startedAt,
  };
}
