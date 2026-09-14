// Compiled-production static surface used only by the secretless fork lane.
// Do not add application routes or authenticated coverage here: Clerk's
// middleware correctly rejects a made-up instance key, and making that pass
// would either require a real credential or introduce a test-only auth bypass.
// The trusted lane owns rendered app/auth/editor coverage.
import { expect, test } from "@playwright/test";

test("secretless production server starts and serves generated client assets", async ({ page }) => {
  const icon = await page.request.get("/icon.svg");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  expect(icon.headers()["x-content-type-options"]).toBe("nosniff");

  const asset = await page.goto("/icon.svg", { waitUntil: "domcontentloaded" });
  expect(asset?.status()).toBe(200);

  const worker = await page.request.get("/crdt-worker.js");
  expect(worker.status()).toBe(200);
  expect(worker.headers()["content-type"]).toContain("javascript");
  expect(worker.headers()["x-content-type-options"]).toBe("nosniff");
});
