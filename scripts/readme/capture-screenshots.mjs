// Capture real Concord UI states for the repository README.
//
// This intentionally reuses the existing authenticated browser harness:
// scripts/browser-e2e-setup.mjs provisions disposable Clerk users, a clean
// PostgreSQL database, the real Rust gateway, and the real Next.js app. The
// screenshots contain only synthetic template content and disposable account
// chrome; no credentials or private user data are written to disk.

import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "@playwright/test";

import globalSetup from "../browser-e2e-setup.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUTPUT_DIR = path.join(ROOT, "docs/assets/readme");
const VIEWPORT = { width: 1440, height: 960 };

process.env.CONCORD_E2E_PROFILE = "full";
process.env.CONCORD_E2E_RUN_ID = `readme-${Date.now().toString(36)}`;
process.env.CONCORD_E2E_VERBOSE = "0";

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const cleanup = await globalSetup();
const browser = await chromium.launch({ headless: true });

function e2eUsers() {
  return JSON.parse(process.env.CONCORD_E2E_USERS || "{}");
}

async function mintSignInToken(user) {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("CLERK_SECRET_KEY is required by the local E2E harness");

  const response = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      user_id: user.clerkUserId,
      expires_in_seconds: "120",
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`Clerk sign-in ticket request failed (${response.status})`);
  }

  return (await response.json()).token;
}

async function signIn(page, user) {
  await page.goto(process.env.CONCORD_E2E_BASE_URL, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="identifier"], input[type="email"]').first().waitFor({
    state: "visible",
    timeout: 45_000,
  });
  await page.waitForFunction(() => Boolean(window.Clerk?.loaded), null, { timeout: 45_000 });

  const ticket = await mintSignInToken(user);
  const result = await page.evaluate(async (token) => {
    const clerk = window.Clerk;
    if (!clerk) throw new Error("Clerk frontend did not load");
    const signInResult = await clerk.client.signIn.create({ strategy: "ticket", ticket: token });
    if (signInResult.status !== "complete" || !signInResult.createdSessionId) {
      throw new Error("Clerk ticket sign-in did not complete");
    }
    await clerk.setActive({ session: signInResult.createdSessionId });
    return signInResult.status;
  }, ticket);

  if (result !== "complete") throw new Error("Clerk ticket sign-in was incomplete");
  await page.goto(process.env.CONCORD_E2E_BASE_URL, { waitUntil: "domcontentloaded" });
  await page.locator('[aria-label="Concord home"]').waitFor({ state: "visible", timeout: 60_000 });
}

async function createProjectBrief(page) {
  const card = page.getByRole("button", {
    name: "Create a new document from the Project brief template",
  });
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await card.click();
  await page.waitForURL(/\/documents\/[a-zA-Z0-9-]+/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split("/").pop();
}

async function waitForEditor(page) {
  await page.locator('.ProseMirror[contenteditable="true"]').waitFor({
    state: "visible",
    timeout: 60_000,
  });
  await page.locator('[data-concord-editor-ready="true"]').waitFor({
    state: "visible",
    timeout: 60_000,
  });
}

async function typeAtEnd(page, text) {
  const editor = page.locator('.ProseMirror[contenteditable="true"]').first();
  await editor.click();
  await editor.press("Control+End");
  await editor.pressSequentially(text);
}

async function waitForText(page, text) {
  await page.waitForFunction(
    (expected) => document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent?.includes(expected),
    text,
    { timeout: 30_000 },
  );
}

async function waitForConnected(page) {
  await page.getByText("Collaborative · Connected", { exact: true }).waitFor({
    state: "visible",
    timeout: 30_000,
  });
}

async function hideDevChrome(page) {
  await page.addStyleTag({
    content: `
      nextjs-portal,
      [data-next-badge-root],
      [data-nextjs-toast] { display: none !important; }
    `,
  });
}

async function capture(page, name, options = {}) {
  await hideDevChrome(page);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, name),
    fullPage: false,
    ...options,
  });
}

try {
  const users = e2eUsers();
  const baseURL = process.env.CONCORD_E2E_BASE_URL;
  const contextOptions = { viewport: VIEWPORT, deviceScaleFactor: 1 };

  const dashboardContext = await browser.newContext(contextOptions);
  const dashboard = await dashboardContext.newPage();
  await signIn(dashboard, users.primary);
  const heroDocumentId = await createProjectBrief(dashboard);
  await dashboard.goto(baseURL, { waitUntil: "domcontentloaded" });
  await dashboard.locator('[aria-label="Concord home"]').waitFor({ state: "visible", timeout: 60_000 });
  await capture(dashboard, "dashboard.png");
  await dashboard.goto(`${baseURL}/documents/${heroDocumentId}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForEditor(dashboard);
  await typeAtEnd(
    dashboard,
    "\nConcord project brief\n\nA local-first workspace for writing, syncing, and recovering shared decisions.",
  );
  await waitForConnected(dashboard);
  await dashboard.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
  await capture(dashboard, "hero-editor.png");
  await dashboardContext.close();

  const contextA = await browser.newContext(contextOptions);
  const contextB = await browser.newContext(contextOptions);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await signIn(pageA, users["collab-a"]);
  const documentId = await createProjectBrief(pageA);
  await waitForEditor(pageA);

  await signIn(pageB, users["collab-a"]);
  await pageB.goto(`${baseURL}/documents/${documentId}`, { waitUntil: "domcontentloaded" });
  await waitForEditor(pageB);

  await typeAtEnd(pageA, "\nReplica A: durable local edit.");
  await waitForText(pageB, "Replica A: durable local edit.");
  await typeAtEnd(pageB, "\nReplica B: converged remote edit.");
  await waitForText(pageA, "Replica B: converged remote edit.");

  await pageA.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
  await pageB.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
  await capture(pageA, "collaborative-a.png");
  await capture(pageB, "collaborative-b.png");

  const cdp = await contextA.newCDPSession(pageA);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await typeAtEnd(pageA, "\nReplica A: safe while disconnected.");
  await pageA.waitForTimeout(1_000);
  await pageA.evaluate(() => window.scrollTo({ top: 0, left: 0 }));
  await capture(pageA, "offline-state.png");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  await contextA.close();
  await contextB.close();
  console.log("[readme] captured dashboard, editor, collaboration, and offline states");
} finally {
  await browser.close();
  await cleanup();
}
