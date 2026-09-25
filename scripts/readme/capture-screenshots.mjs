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

// Stack + browser are per-attempt (created inside runCapturesWithStack) so a
// retried attempt gets a fresh provisioned stack and a live browser instance.

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

  // Clerk activation can replace the document mid-navigation (same race the
  // test helpers retry): navigate fresh up to 3 times, accepting an
  // "Execution context was destroyed" from the activation itself.
  try {
    await page.evaluate(async () => {
      // no-op: keep the context alive until the next navigation
    });
  } catch {
    // context already navigating — fine
  }
  let navigated = false;
  let lastNavigationError;
  for (let attempt = 0; attempt < 3 && !navigated; attempt += 1) {
    try {
      await page.goto(process.env.CONCORD_E2E_BASE_URL, { waitUntil: "domcontentloaded" });
      navigated = true;
    } catch (error) {
      lastNavigationError = error;
      const transient = /NS_BINDING_ABORTED|frame was detached|Execution context was destroyed|interrupted by another navigation/i.test(String(error));
      if (!transient || attempt === 2) throw error;
      try {
        await page.locator('[aria-label="Concord home"]').waitFor({ state: "visible", timeout: 10_000 });
        navigated = true;
        break;
      } catch {
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    }
  }
  if (!navigated) throw lastNavigationError ?? new Error("post-sign-in navigation failed");
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

async function createBlankDocument(page) {
  await page.getByRole("button", { name: "Blank document" }).first().click();
  await page.waitForURL(/\/documents\/[a-zA-Z0-9-]+/, { timeout: 60_000 });
  return new URL(page.url()).pathname.split("/").pop();
}

async function typeInEditor(page, text) {
  const editor = page.locator('.ProseMirror[contenteditable="true"]').first();
  await editor.click();
  await editor.pressSequentially(text);
}

async function waitForTextIn(page, text, timeout = 60_000) {
  await page.waitForFunction(
    (expected) => document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent?.includes(expected),
    text,
    { timeout },
  );
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

async function waitForConnected(page) {
  await page.getByText("Collaborative · Connected", { exact: true }).waitFor({
    state: "visible",
    timeout: 60_000,
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

// Fatal console-error gate (mirrors tests/browser/helpers.ts ConsoleMonitor):
// the tour doubles as a live bug hunt — any real page error fails the run.
class ConsoleMonitor {
  constructor() { this.errors = []; }
  attach(page) {
    page.on("console", (msg) => { if (msg.type() === "error") this.errors.push(msg.text()); });
    page.on("pageerror", (err) => this.errors.push(`pageerror: ${err.message}`));
  }
  fatalErrors() {
    return this.errors.filter((e) => {
      if (e.includes("Download the React DevTools")) return false;
      if (/^clerk:\s*development mode is enabled/i.test(e)) return false;
      if (/^clerk:\s*telemetry is (disabled|not enabled)/i.test(e)) return false;
      if (/^clerk:\s*devtools are (disabled|not enabled)/i.test(e)) return false;
      if (e.includes("third-party cookie")) return false;
      if (/\(404\)/.test(e) && /favicon|\.png|\.svg/.test(e)) return false;
      if (e.includes("[Fast Refresh]") || e.includes("turbopack")) return false;
      return true;
    });
  }
}

const monitor = new ConsoleMonitor();

function openReviewPanel(page) {
  return page.getByRole("button", { name: "Open review, history, and draft tools" }).click();
}

async function featureTour(browser, baseURL, user) {
  // One signed-in context drives the six review-panel features in sequence.
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(90_000);
  monitor.attach(page);
  await signIn(page, user);
  const documentId = await createBlankDocument(page);
  await waitForEditor(page);
  await typeInEditor(page, "Feature tour: replay, proofs, markdown, and suggestions. ");
  await waitForConnected(page);

  // ---- History: named checkpoint + read-only preview ----
  await openReviewPanel(page);
  await page.getByPlaceholder("Checkpoint name").fill("Feature tour checkpoint");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "checkpoint" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: /Feature tour checkpoint/ }).click();
  await page.getByRole("heading", { name: "Read-only preview" }).waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, "feature-history.png");
  console.log("[readme] feature tour: history OK");

  // ---- Comments: anchored comment on a selection ----
  // selectText() is the proven cross-platform selection path (the browser
  // E2E suite uses it; raw Control+Home/Shift+End shortcuts do not move the
  // caret on macOS Chromium).
  const editor = page.locator('.ProseMirror[contenteditable="true"]').first();
  await editor.selectText();
  await page.getByRole("tab", { name: "Comments" }).click();
  await page.locator("#new-comment").fill("Tour comment: anchored to CRDT item IDs.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByText("Tour comment: anchored to CRDT item IDs.").waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, "feature-comments.png");
  console.log("[readme] feature tour: comments OK");

  // ---- Suggestions: propose from selection, accept & apply ----
  await editor.selectText();
  await page.getByRole("tab", { name: "Suggestions" }).click();
  await page.getByLabel("Proposed replacement text").fill("Replaced by an accepted suggestion.");
  await page.getByRole("button", { name: "Propose change" }).click();
  await page.getByText("Replaced by an accepted suggestion.").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "Accept & apply" }).click();
  await page.getByRole("status").filter({ hasText: "Suggestion applied" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent?.includes("Replaced by an accepted suggestion."),
    null,
    { timeout: 30_000 },
  );
  await capture(page, "feature-suggestions.png");
  console.log("[readme] feature tour: suggestions OK");

  // ---- Concordpack: export, verify bundle, verify server receipt ----
  await page.getByRole("tab", { name: "Concordpack" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export verified bundle" }).click();
  const download = await downloadPromise;
  const filePath = await download.path();
  await page.locator('input[type="file"][aria-label="Choose a Concord document bundle"]').setInputFiles(filePath);
  await page.getByRole("status").filter({ hasText: "passed checksum" }).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("button", { name: "Verify server receipt" }).click();
  await page.getByText(/Server receipt verified/).waitFor({ state: "visible", timeout: 30_000 });
  await page.getByText(/matches this replica: yes/).waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, "feature-concordpack.png");
  console.log("[readme] feature tour: concordpack + server receipt OK");

  // ---- Replay: scrub mid-history with the digest visible ----
  await page.getByRole("tab", { name: "Replay" }).click();
  await page.getByRole("heading", { name: "Time-travel replay" }).waitFor({ state: "visible" });
  const slider = page.getByRole("slider", { name: "Replay position" });
  await slider.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('.ProseMirror') === null,
    null,
    { timeout: 1_000 },
  ).catch(() => undefined);
  // Scrub: latest → start → mid-history state. fill() drives the range
  // input's React onChange deterministically (raw arrow keys proved flaky
  // under panel re-renders).
  const totalOps = Number(await slider.getAttribute("max"));
  await slider.fill("0");
  await page.waitForFunction(
    () => !document.querySelector("#document-tool-panel")?.textContent?.includes("Feature tour"),
    null,
    { timeout: 30_000 },
  );
  await slider.fill(String(Math.max(1, Math.floor(totalOps * 0.6))));
  await page.waitForFunction(
    () => Boolean(document.querySelector("#document-tool-panel")?.textContent?.includes("Feature tour")),
    null,
    { timeout: 30_000 },
  );
  await capture(page, "feature-replay.png");
  console.log("[readme] feature tour: replay OK");

  // ---- Markdown: export the live document ----
  await page.getByRole("tab", { name: "Markdown" }).click();
  await page.getByRole("button", { name: "Export markdown" }).click();
  await page.getByRole("status").filter({ hasText: "Exported" }).waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, "feature-markdown.png");
  console.log("[readme] feature tour: markdown OK");

  await context.close();
  return documentId;
}

async function capturePresence(browser, baseURL, user) {
  // Two contexts on the SAME document; each renders the other's CRDT-anchored
  // caret with a color label (presence relays through the real gateway).
  const ctxA = await browser.newContext(contextOptions);
  const ctxB = await browser.newContext(contextOptions);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.setDefaultTimeout(90_000);
  pageB.setDefaultTimeout(90_000);
  monitor.attach(pageA);
  monitor.attach(pageB);

  await signIn(pageA, user);
  // A BLANK document (the exact shape the journey I2 presence test proves):
  // plain paragraphs keep every caret CRDT-anchorable, which is the property
  // being showcased here.
  await pageA.getByRole("button", { name: "Blank document" }).first().click();
  await pageA.waitForURL(/\/documents\/[a-zA-Z0-9-]+/, { timeout: 60_000 });
  const documentId = new URL(pageA.url()).pathname.split("/").pop();
  await waitForEditor(pageA);
  await signIn(pageB, user);
  await pageB.goto(`${baseURL}/documents/${documentId}`, { waitUntil: "domcontentloaded" });
  await waitForEditor(pageB);
  await typeInEditor(pageA, "Presence: carets anchored to CRDT item IDs stay glued while peers type. ");
  await waitForTextIn(pageB, "Presence: carets anchored");
  // Nudge both carets (the exact sequence the journey I2 test proves) so
  // fresh presence frames reach the live room; the 4s idle heartbeat is the
  // backstop that makes a peer that joined late appear.
  const editorA = pageA.locator('.ProseMirror[contenteditable="true"]').first();
  const editorB = pageB.locator('.ProseMirror[contenteditable="true"]').first();
  await editorA.click();
  await pageA.keyboard.press("Home");
  await pageA.keyboard.press("ArrowRight");
  await pageA.waitForTimeout(400);
  await editorB.click();
  await pageB.keyboard.press("End");
  await pageB.waitForTimeout(400);
  // The later joiner sees A's caret first (A's heartbeat), then A sees B's.
  try {
    await pageB.locator('[data-testid="presence-caret"]').first().waitFor({ state: "visible", timeout: 45_000 });
  } catch (error) {
    const dump = await pageB.evaluate(() => ({
      carets: document.querySelectorAll('[data-testid="presence-caret"]').length,
      overlayHtml: document.querySelector('div[aria-hidden="true"]')?.outerHTML?.slice(0, 400) ?? "NO OVERLAY",
      editorText: document.querySelector('.ProseMirror')?.textContent?.slice(0, 80) ?? "",
    }));
    console.error("[readme] B caret dump:", JSON.stringify(dump));
    throw error;
  }
  await pageA.locator('[data-testid="presence-caret"]').first().waitFor({ state: "visible", timeout: 45_000 });
  await pageA.waitForTimeout(500);
  await capture(pageA, "feature-presence.png");
  console.log("[readme] feature tour: presence OK (both sides render the peer caret)");
  await ctxA.close();
  await ctxB.close();
}

const contextOptions = { viewport: VIEWPORT, deviceScaleFactor: 1 };

async function runCaptures(browser) {
  const users = e2eUsers();
  const baseURL = process.env.CONCORD_E2E_BASE_URL;

  const dashboardContext = await browser.newContext(contextOptions);
  const dashboard = await dashboardContext.newPage();
  dashboard.setDefaultTimeout(90_000);
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
  pageA.setDefaultTimeout(90_000);
  pageB.setDefaultTimeout(90_000);

  await signIn(pageA, users["collab-a"]);
  // The EXACT shape the journey I realtime test proves: blank document,
  // journey-style typing and polling.
  const documentId = await createBlankDocument(pageA);
  await waitForEditor(pageA);

  await signIn(pageB, users["collab-a"]);
  await pageB.goto(`${baseURL}/documents/${documentId}`, { waitUntil: "domcontentloaded" });
  await waitForEditor(pageB);

  await waitForConnected(pageA);
  await waitForConnected(pageB);
  await typeInEditor(pageA, "Replica A: durable local edit. ");
  await waitForTextIn(pageB, "Replica A: durable local edit.");
  await typeInEditor(pageB, "Replica B: converged remote edit.");
  await waitForTextIn(pageA, "Replica B: converged remote edit.");

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

  // Feature tour (part 1): presence needs the two-context room that is
  // already live — capture the peer caret here, BEFORE closing A/B.
  await capturePresence(browser, baseURL, users["collab-a"]);

  await contextA.close();
  await contextB.close();

  // Feature tour (part 2): the six review-panel features on one document.
  await featureTour(browser, baseURL, users.primary);

  console.log("[readme] captured dashboard, editor, collaboration, offline, presence, and the feature tour");

  const fatal = monitor.fatalErrors();
  if (fatal.length > 0) {
    throw new Error(`fatal browser console errors during the capture tour:\n${fatal.join("\n")}`);
  }
}

// The E2E stack provisions fresh Clerk users per run; the cloud dev
// instance throttles under repeated churn, so a transient first-step
// failure retries with a fresh stack rather than failing the capture.
let lastError;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    // A retry needs a fresh browser: the previous attempt's instance is
    // closed in its finally below on failure paths that reach it.
    await runCapturesWithStack();
    lastError = null;
    break;
  } catch (error) {
    lastError = error;
    console.error(`[readme] capture attempt ${attempt} failed:`, String(error).slice(0, 300));
    if (attempt < 3) {
      console.error("[readme] cooling down 45s before a fresh-stack retry…");
      await new Promise((resolve) => setTimeout(resolve, 45_000));
    }
  }
}
if (lastError) throw lastError;

async function runCapturesWithStack() {
  monitor.errors.length = 0;
  // A dev server killed by a previous failed run leaves a corrupt .next
  // cache that dies before readiness; start every attempt clean.
  await fs.rm(path.join(ROOT, ".next"), { recursive: true, force: true });
  const cleanup = await globalSetup();
  const browser = await chromium.launch({ headless: true });
  try {
    await runCaptures(browser);
  } finally {
    await browser.close().catch(() => undefined);
    await cleanup();
  }
}
