// Secretless browser check for pull requests from forks.
//
// This config exercises the compiled production server's static/client
// surface, but intentionally does not provision Clerk, the gateway, a
// database, or internal brokers. It is therefore safe to run in an untrusted
// fork context. Authenticated collaboration coverage belongs to
// playwright.config.ts and the trusted `concord-e2e` GitHub environment.
import { defineConfig, devices } from "@playwright/test";

const PORT = 3122;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "public-smoke.spec.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  // A public-fork result must reflect its first attempt. Retrying could mask
  // a transient regression without granting a trustworthy environment more
  // authority than it needs.
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
  },
  webServer: {
    // next.config.ts selects `output: "standalone"` outside Vercel. Next
    // intentionally rejects `next start` for that output, so exercise the
    // exact generated server the release image runs instead.
    command: `node scripts/e2e/prepare-standalone.mjs && HOSTNAME=0.0.0.0 PORT=${PORT} node .next/standalone/server.js`,
    // The public lane intentionally has no database, so `/api/health`
    // correctly returns 503 there. Probe a static asset to establish that
    // the compiled production server is actually listening.
    url: `${baseURL}/icon.svg`,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      // Make the secretless contract explicit even if a developer's shell
      // happens to contain authenticated E2E variables.
      CLERK_SECRET_KEY: "",
      CONCORD_E2E_NATS_URL: "",
      CONCORD_E2E_REDIS_URL: "",
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
