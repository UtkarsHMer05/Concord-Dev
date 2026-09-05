// Programmatic Drizzle migration runner.
//
// Usage:
//   node scripts/db/migrate.mjs                 # migrate DATABASE_URL (dev)
//   node scripts/db/migrate.mjs --test          # migrate DATABASE_TEST_URL
//   node scripts/db/migrate.mjs postgres://...  # migrate an explicit URL
//
// Exits non-zero on failure. No secrets are printed.

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// Load the local Next.js env file when present (no-op in CI/explicit envs).
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local is optional when DATABASE_URL is provided by the environment.
}

const args = process.argv.slice(2);

let url;
if (args[0] === "--test") {
  url = process.env.DATABASE_TEST_URL;
  if (!url) {
    console.error("DATABASE_TEST_URL is not set.");
    process.exit(1);
  }
} else if (args[0]) {
  url = args[0];
} else {
  url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
}

const pool = new pg.Pool({ connectionString: url });
try {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied successfully.");
} catch (error) {
  console.error("Migration failed:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
