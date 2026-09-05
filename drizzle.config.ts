import { defineConfig } from "drizzle-kit";

// drizzle-kit does not load Next.js env files automatically; pull the local
// environment (if present) without failing when it does not exist (CI).
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local is optional for drizzle-kit (e.g. CI with explicit env).
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://concord:concord_local_dev@localhost:5432/concord",
  },
  verbose: true,
  strict: true,
});
