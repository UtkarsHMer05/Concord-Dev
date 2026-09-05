/**
 * Vitest global setup for PostgreSQL integration tests.
 *
 * Requires DATABASE_TEST_URL (the isolated concord_test database). Recreates
 * the public schema and applies every migration from an empty database on
 * each run — proving empty-DB replay on every test execution.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export async function setup() {
  const url = process.env.DATABASE_TEST_URL;
  if (!url) {
    throw new Error(
      "DATABASE_TEST_URL is not set — integration tests refuse to run against an unverified database.",
    );
  }
  if (!url.includes("concord_test")) {
    throw new Error(
      "DATABASE_TEST_URL must point at the isolated test database (concord_test), never the dev database.",
    );
  }

  const pool = new pg.Pool({ connectionString: url });
  try {
    // Deterministic clean state: reset both the application schema and the
    // drizzle migration journal schema, then replay every migration from an
    // empty database.
    await pool.query(
      `DROP SCHEMA public CASCADE;
       DROP SCHEMA IF EXISTS drizzle CASCADE;
       CREATE SCHEMA public;
       GRANT ALL ON SCHEMA public TO current_user;
       GRANT ALL ON SCHEMA public TO public;`,
    );
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }
}
