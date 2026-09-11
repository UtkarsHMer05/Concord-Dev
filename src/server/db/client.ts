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

/**
 * Hosted Postgres providers (Neon etc.) require TLS; the local Docker
 * Postgres does not. Sslmode in the URL is the source of truth when
 * present; a hostname heuristic covers the rest.
 */
function isRemoteDatabase(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

export function getDbPool(): Pool {
  if (globalForDb.__concordPgPool) {
    return globalForDb.__concordPgPool;
  }
  const env = getServerEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    // TLS for hosted Postgres (Neon etc.); local Docker Postgres stays
    // plain — pg defaults to sslmode=prefer in the connection string, and
    // forcing ssl:true against localhost would break local dev. Neon URLs
    // carry ?sslmode=require; this covers string-less configs too.
    ssl: isRemoteDatabase(env.DATABASE_URL),
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
