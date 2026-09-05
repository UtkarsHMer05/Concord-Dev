import path from "node:path";
import { defineConfig } from "vitest/config";

// Make local env vars (DATABASE_TEST_URL etc.) available to tests. Optional —
// CI supplies explicit environment variables.
try {
  process.loadEnvFile(".env.local");
} catch {
  // .env.local absent — tests relying on env will fail with clear errors.
}

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // DB integration tests prepare the test database once per run.
    globalSetup: process.env.DATABASE_TEST_URL
      ? ["tests/db/global-setup.ts"]
      : undefined,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // "server-only" throws when imported outside a react-server context;
      // map it to the package's empty module for tests.
      "server-only": path.resolve(
        __dirname,
        "./node_modules/server-only/empty.js",
      ),
    },
  },
});
