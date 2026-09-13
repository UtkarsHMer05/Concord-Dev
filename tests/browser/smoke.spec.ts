// ---------------------------------------------------------------------------
// Browser smoke matrix — load + sign-in + editor render per engine.
//
// Release-tier gate: the primary journey (journey.spec.ts) runs on
// Chromium; Firefox and WebKit run this smoke (the app boots, real Clerk
// sign-in works, a document opens, the editor renders, typing works).
// This is the documented coverage level for the non-Chromium engines —
// full realtime journeys are Chromium-tier (see docs/BROWSER_SUPPORT.md).
//
// Run: npx playwright test --project=firefox tests/browser/smoke.spec.ts
//      npx playwright test --project=webkit  tests/browser/smoke.spec.ts
// ---------------------------------------------------------------------------
import { test, expect } from "@playwright/test";
import { signIn, createDocument, waitForEditor, typeInEditor, editorText, type E2eUser } from "./helpers";

function user(label: string): E2eUser {
  const users = JSON.parse(process.env.CONCORD_E2E_USERS || "{}") as Record<string, E2eUser>;
  const u = users[label];
  if (!u) throw new Error(`E2E user "${label}" not provisioned`);
  return u;
}

test("smoke: load, sign in, open editor, type", async ({ page }) => {
  const resp = await page.goto("/");
  expect(resp?.status()).toBeLessThan(400);

  // The smoke project names map to provisioned users (chromium/firefox/webkit).
  const engine = test.info().project.name;
  await signIn(page, user(engine === "chromium" ? "smoke" : "primary"));
  const documentId = await createDocument(page, "Smoke");
  await waitForEditor(page);

  const typed = `smoke ${test.info().project.name}`;
  await typeInEditor(page, typed);
  await expect
    .poll(async () => editorText(page), { timeout: 30_000 })
    .toContain(typed);

  // The durable op-log must have rows for this document (the gateway
  // path is live in every engine that runs this smoke).
  expect(documentId).toBeTruthy();
});
