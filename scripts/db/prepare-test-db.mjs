// Recreates the isolated test database (concord_test) from scratch and
// applies all migrations. Development helper — integration tests also
// self-prepare via their vitest global setup.
//
// Usage: npm run db:test:prepare

import pg from "pg";

// Load the local Next.js env file when present (no-op in CI/explicit envs).
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local is optional when DATABASE_TEST_URL is provided by the env.
}

const url =
  process.env.DATABASE_TEST_URL ??
  "postgres://concord:concord_local_dev@localhost:5433/concord_test";

// Connect to the maintenance database to drop/recreate the test database.
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";

const pool = new pg.Pool({ connectionString: adminUrl.toString() });
try {
  const target = decodeURIComponent(new URL(url).pathname.slice(1));
  await pool.query(
    `DROP DATABASE IF EXISTS ${quoteIdent(target)} WITH (FORCE)`,
  );
  await pool.query(`CREATE DATABASE ${quoteIdent(target)}`);
  console.log(`Test database "${target}" recreated.`);
} catch (error) {
  console.error("Failed to prepare test database:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

function quoteIdent(name) {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe database name: ${name}`);
  }
  return `"${name}"`;
}
