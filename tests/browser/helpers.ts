// ---------------------------------------------------------------------------
// Browser E2E — sign-in helper (Chromium/Firefox/WebKit share this).
//
// DETERMINISTIC REAL AUTH (recipe proven against the live dev instance):
// The Clerk dev instance runs in test mode with cookieless development
// sessions. Fully-UI sign-in is not deterministic there (sign-in email
// codes are real randomized values; password sign-in triggers a
// device-attestation challenge with a real emailed code). The
// deterministic path that still exercises the REAL auth stack end to
// end:
//
//   1. globalSetup (scripts/browser-e2e-setup.mjs) creates the E2E users
//      + an organization via the Clerk Backend API (sk_test; form-encoded
//      — the API's native format). Users are email-verified on
//      creation. Test-data provisioning, same as CI provisions DBs.
//   2. The browser opens the app; Clerk's frontend JS completes the
//      dev-browser handshake (real network, real instance).
//   3. A sign-in token is minted via the Backend API (per sign-in; 120s
//      TTL) and consumed CLIENT-SIDE in the page through Clerk's public
//      client API — window.Clerk.client.signIn.create({strategy:
//      "ticket", ticket:<jwt>}) — the ticket strategy Clerk documents
//      for server-minted sign-in links. The resulting session is a REAL
//      Clerk session (real JWT, real instance keys, real expiry); the
//      gateway verifies it over HTTPS JWKS like any production session.
//   4. Reload syncs the session to the middleware via the documented
//      handshake flow; the app renders authenticated.
//
// No secrets in the repo; no mailbox; no personal accounts; fully
// deterministic. The browser still renders the real sign-in UI and Clerk
// frontend handshake; the Backend API ticket avoids a mailbox dependency.
// ---------------------------------------------------------------------------
import { expect, type Page } from "@playwright/test";

export interface E2eUser {
  clerkUserId: string;
  email: string;
}

/** Mint a fresh sign-in token JWT for the user via the Backend API. */
export async function mintSignInToken(user: E2eUser): Promise<string> {
  const secret = process.env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("CLERK_SECRET_KEY is required to mint E2E sign-in tokens");
  const res = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
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
  if (!res.ok) {
    throw new Error(`sign_in_tokens ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

/**
 * Sign in a browser page as the given E2E user (deterministic ticket
 * strategy; see the header comment). Returns after the authenticated
 * home view is visible.
 */
export async function signIn(page: Page, user: E2eUser): Promise<void> {
  // 1. Load the app — the visible sign-in form proves Clerk's frontend
  //    and the dev-browser handshake are live (real network).
  await page.goto("/");
  await expect(
    page.locator('input[name="identifier"], input[type="email"]').first(),
  ).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(
      async () => page.evaluate(() => Boolean(window.Clerk?.loaded)),
      { timeout: 45_000 },
    )
    .toBe(true);

  // 2. Mint + consume a real sign-in ticket through Clerk's public
  //    client API inside the page.
  const ticket = await mintSignInToken(user);
  const result = await page.evaluate(async (t: string) => {
    try {
      const clerk = window.Clerk;
      if (!clerk) throw new Error("window.Clerk unavailable (Clerk frontend not loaded)");
      const si = await clerk.client.signIn.create({
        strategy: "ticket",
        ticket: t,
      });
      return { status: si.status, createdSessionId: si.createdSessionId ?? null };
    } catch (e) {
      return { status: "error", message: String(e).slice(0, 200) };
    }
  }, ticket);
  if (result.status !== "complete") {
    throw new Error(`ticket sign-in did not complete: ${JSON.stringify(result)}`);
  }
  if (!result.createdSessionId) {
    throw new Error("ticket sign-in completed without a session id");
  }
  // Clerk may navigate while activating a session. Keep activation as a
  // separate page operation so a navigation cannot make the ticket exchange
  // itself look like an auth failure; a destroyed context here is accepted
  // only because the subsequent reload proves the session really persisted.
  try {
    await page.evaluate(async (sessionId: string) => {
      const clerk = window.Clerk;
      if (!clerk) throw new Error("window.Clerk unavailable during activation");
      await clerk.setActive({ session: sessionId });
    }, result.createdSessionId);
  } catch (error) {
    if (!String(error).includes("Execution context was destroyed")) {
      throw error;
    }
  }

  // 3. Navigate fresh (not reload — Clerk's post-sign-in task flow can
  //    replace the document mid-reload, detaching the page): the
  //    cookieless session syncs to the middleware via the documented
  //    handshake, and the app renders authenticated. Firefox can report a
  //    transient NS_BINDING_ABORTED while Clerk completes that replacement;
  //    retry only that navigation race, then prove the resulting home state.
  let navigated = false;
  let lastNavigationError: unknown;
  for (let attempt = 0; attempt < 3 && !navigated; attempt += 1) {
    try {
      await page.goto("/", { waitUntil: "domcontentloaded" });
      navigated = true;
    } catch (error) {
      lastNavigationError = error;
      const transientFrameNavigation =
        /NS_BINDING_ABORTED|frame was detached|Execution context was destroyed|interrupted by another navigation/i.test(
          String(error),
        );
      if (!transientFrameNavigation || attempt === 2) {
        throw error;
      }
      // A Clerk activation can finish by replacing the document. Let that
      // navigation settle before retrying the same deterministic destination.
      try {
        await page
          .locator('[aria-label="Concord home"]')
          .waitFor({ state: "visible", timeout: 10_000 });
        navigated = true;
        break;
      } catch {
        // The authenticated page is not visible yet; the next goto retries
        // the same destination after the in-flight replacement settles.
      }
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
  }
  if (!navigated) {
    throw lastNavigationError instanceof Error
      ? lastNavigationError
      : new Error(String(lastNavigationError));
  }
  await waitForHome(page);
}

/** Wait for the authenticated home view (documents view is the landing). */
export async function waitForHome(page: Page): Promise<void> {
  await expect(
    page.locator('[aria-label="Concord home"]'),
  ).toBeVisible({ timeout: 60_000 });
}

/** Create a document from the home view (templates gallery) and return its id. */
export async function createDocument(page: Page, title: string): Promise<string> {
  // Home: the templates gallery ("Start a new document") creates a real
  // document via the createDocumentAction server action and routes into it.
  const gallery = page.locator("h3", { hasText: "Start a new document" }).first();
  await expect(gallery).toBeVisible();
  const card = gallery.locator("xpath=following-sibling::*[1]//button").first();
  const alt = page.locator("button:has(svg)").first();
  const target = (await card.count() > 0) ? card : alt;
  await expect(target, `template card for ${title}`).toBeVisible();
  await target.click();
  await page.waitForURL(/\/documents\/[a-zA-Z0-9-]+/, { timeout: 30_000 });
  const url = new URL(page.url());
  return url.pathname.split("/").pop() as string;
}

/** Wait until the editor is interactive (ProseMirror contenteditable). */
export async function waitForEditor(page: Page): Promise<void> {
  await expect(
    page.locator(".ProseMirror[contenteditable='true']"),
  ).toBeVisible({ timeout: 60_000 });
  // Visibility alone races the async WASM/IndexedDB bridge start. The
  // readiness marker is emitted by the editor only after the CRDT seed has
  // been installed, so typing cannot lose its first transaction to startup.
  await expect(
    page.locator('[data-concord-editor-ready="true"]'),
  ).toBeVisible({ timeout: 60_000 });
}

/** Type into the editor (clicks, then keyboard input). */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  const editor = page.locator(".ProseMirror[contenteditable='true']").first();
  await waitForEditor(page);
  await expect(editor).toBeEditable();
  await editor.click();
  await expect(editor).toBeFocused();
  // The editor must receive real keyboard events, but an artificial
  // per-character delay makes this probe timing-dependent and needlessly
  // lengthens every engine's run.
  await editor.pressSequentially(text);
}

/** Read the editor's visible text content. */
export async function editorText(page: Page): Promise<string> {
  return (
    await page.locator(".ProseMirror[contenteditable='true']").first().innerText()
  ).trim();
}

/**
 * Fatal browser-console error gate: uncaught page errors and console
 * errors that indicate real product failures. Dev-server noise (React
 * devtools hints, 404s for optional assets, Clerk frontend notices) is
 * not a product defect and is filtered with stated reasons.
 */
export class ConsoleMonitor {
  private errors: string[] = [];

  // These are the only Clerk messages known to be harmless in the local
  // development/test instance. Authentication, issuer, origin, ticket, and
  // network failures intentionally remain fatal instead of being hidden by a
  // broad `/clerk/i` filter.
  private static readonly benignClerkNoise = [
    /^clerk:\s*development mode is enabled\.?$/i,
    /^clerk:\s*telemetry is (?:disabled|not enabled)\.?$/i,
    /^clerk:\s*devtools are (?:disabled|not enabled)\.?$/i,
  ];

  attach(page: Page): void {
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        this.errors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      this.errors.push(`pageerror: ${err.message}`);
    });
  }

  fatalErrors(): string[] {
    return this.errors.filter((e) => {
      if (e.includes("Download the React DevTools")) return false;
      // Clerk frontend benign notices (explicitly allowlisted above).
      if (ConsoleMonitor.benignClerkNoise.some((pattern) => pattern.test(e))) return false;
      if (e.includes("third-party cookie")) return false;
      // Optional-asset 404s during dev (favicons etc.).
      if (/\(404\)/.test(e) && /favicon|\.png|\.svg/.test(e)) return false;
      // Turbopack dev-server internal noise.
      if (e.includes("[Fast Refresh]") || e.includes("turbopack")) return false;
      return true;
    });
  }

  all(): string[] {
    return [...this.errors];
  }
}

declare global {
  interface Window {
    Clerk?: {
      loaded: boolean;
      client: {
        signIn: {
          create: (params: { strategy: string; ticket: string }) => Promise<{
            status: string;
            createdSessionId?: string;
          }>;
        };
      };
      setActive: (params: { session: string }) => Promise<void>;
    };
  }
}
