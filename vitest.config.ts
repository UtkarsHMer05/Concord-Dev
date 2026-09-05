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
    environment: "node",
    globalSetup: process.env.DATABASE_TEST_URL
      ? ["tests/db/global-setup.ts"]
      : undefined,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/db/**"],
        },
      },
      {
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          setupFiles: ["tests/db/setup-env.ts"],
          // One shared test database: test files must not run concurrently
          // or they would truncate each other's fixture data.
          fileParallelism: false,
        },
      },
    ],
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
