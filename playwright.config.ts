// ---------------------------------------------------------------------------
// Playwright browser E2E configuration.
//
// WHAT THIS IS (the honest label): real rendered-browser end-to-end tests of
// the Concord web application — Chromium loads the actual Next.js pages,
// signs in through the real Clerk dev instance (deterministic email-code
// flow, test mode), types into the real editor, boots the real WASM CRDT
// worker, and syncs through the real Rust gateway over a real WebSocket.
//
// WHAT THIS IS NOT: the Node/Vitest realtime suite (tests/realtime) drives
// the same sync modules WITHOUT a rendered browser — that suite is labeled
// "realtime transport E2E" and this one is "browser E2E". Both exist; they
// are different verification layers.
//
// Stack spawned by globalSetup (scripts/browser-e2e-setup.mjs):
//   - Next.js dev server on an isolated localhost port by default, or a
//     production `next build` + generated standalone-server pair when
//     CONCORD_E2E_MODE is production (never the developer's normal port 3000)
//   - Postgres concord_e2e database on the compose db (127.0.0.1:5433),
//     migrated by the same drizzle migrations the app uses
//   - Rust sync-gateway release binary on an isolated loopback port with:
//       GATEWAY_CLERK_ISSUER   = the real Clerk dev instance
//       (HTTPS JWKS — real tokens, real key rotation path)
//       GATEWAY_ALLOWED_ORIGINS= http://localhost:3111
//       GATEWAY_WORKER_BINARY  = the native concord-worker release build
//
// Prerequisites (documented in docs/TESTING.md §browser):
//   docker compose up -d db nats redis
//   cargo build --release            (rust/)
//   cmake --build build/native --target concord-worker
//   npm run wasm:build && npm run worker:bundle
//
// Auth: the Clerk dev instance is exercised with short-lived Backend API
// sign-in tickets consumed by the browser client — no mailbox or personal
// account is required. CI and local runs use the same disposable-instance
// mechanism.
// ---------------------------------------------------------------------------
import { defineConfig, devices } from "@playwright/test";

// Keep non-secret E2E endpoint overrides consistent between config evaluation
// and globalSetup. The setup script also loads this file before reading Clerk
// values; loading it here is what makes a local CONCORD_E2E_WEB_PORT override
// reach Playwright's already-resolved baseURL.
try {
  process.loadEnvFile(".env.local");
} catch {
  // CI supplies its environment explicitly; a missing local file is normal.
}

const setupFile = "./scripts/browser-e2e-setup.mjs";
const invocation = [process.env.npm_lifecycle_event || "", ...process.argv].join(" ");
const fullTestFile = /(?:^|[\\/])(?:journey|a11y)\.spec\.ts$/;
const smokeTestFile = /(?:^|[\\/])smoke\.spec\.ts$/;
const smokeRequested =
  /test:browser:smoke/i.test(invocation) ||
  /(?:^|[\s/])smoke\.spec\.ts(?:$|[\s])/i.test(invocation);
const fullRequested = /(?:^|[\s/])(?:journey|a11y)\.spec\.ts(?:$|[\s])/i.test(invocation);
const chromiumTestMatch =
  smokeRequested && !fullRequested
    ? smokeTestFile
    : fullRequested && !smokeRequested
      ? fullTestFile
      : smokeRequested && fullRequested
        ? /(?:^|[\\/])(?:journey|a11y|smoke)\.spec\.ts$/
        : fullTestFile;

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // One worker: the suites share one gateway + one DB; browser-level
  // parallelism happens across contexts inside the realtime spec.
  workers: 1,
  fullyParallel: false,
  // A one-shot run is useful when diagnosing a flake: it must not silently
  // turn a first failure into a second, potentially different result.
  retries: process.env.CONCORD_E2E_NO_RETRY === "1" ? 0 : process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    // globalSetup cannot change an already-resolved Playwright `use` object.
    // Keep the default in lock-step with the setup script; callers that need a
    // different port must set CONCORD_E2E_WEB_PORT (or the complete base URL)
    // before Playwright loads this config.
    baseURL:
      process.env.CONCORD_E2E_BASE_URL ||
      `http://localhost:${process.env.CONCORD_E2E_WEB_PORT || "3111"}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 15_000,
  },
  globalSetup: setupFile,
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      // The full journey uses Chromium CDP for offline/reconnect coverage.
      // Keep the project boundary enforced by the config, not only by the
      // package script's file arguments. The Chromium smoke script is a
      // deliberate exception and is selected only when its smoke file is
      // explicitly requested.
      testMatch: chromiumTestMatch,
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: smokeTestFile,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: smokeTestFile,
    },
  ],
});

// Firefox/WebKit smoke coverage runs as separate project invocations against
// tests/browser/smoke.spec.ts. Keeping the full journey Chromium-only keeps
// the primary gate fast while still exercising the auth/editor path in each
// supported engine (see docs/TESTING.md).
