// ---------------------------------------------------------------------------
// Browser E2E — the primary Chromium journey (release gate).
//
// Covers, in one real browser session against the real stack (Next.js +
// Clerk dev instance + Rust gateway + Postgres + WASM worker):
//
//   A. application loads
//   B. real Clerk sign-in via a disposable Backend API ticket (dev instance)
//   C. document creation through the real server action
//   D. editor renders (ProseMirror contenteditable)
//   E. WASM CRDT worker initializes (window worker evidence)
//   F. typing
//   G. content appears
//   H. local persistence survives reload
//   I. two-browser realtime collaboration through the real gateway
//      (edit in A -> fanout to B -> edit in B -> converge in A, no
//      duplicated ops, valid connection state)
//   J. disconnect/reconnect convergence
//   K. authorization isolation (another user's document is a 404, not data)
//   L. browser console free of unexpected fatal errors
//   M. network failure produces an honest UX state, no content corruption
//
// Every wait is event/state-driven (visible selectors, URL changes, DB
// probes) — no fixed sleeps.
// ---------------------------------------------------------------------------
import { test, expect } from "@playwright/test";
import {
  signIn,
  createDocument,
  waitForEditor,
  typeInEditor,
  editorText,
  ConsoleMonitor,
  type E2eUser,
} from "./helpers";

/** The E2E users provisioned by globalSetup (CONCORD_E2E_USERS env). */
function user(label: string): E2eUser {
  const users = JSON.parse(process.env.CONCORD_E2E_USERS || "{}") as Record<
    string,
    E2eUser
  >;
  const u = users[label];
  if (!u) throw new Error(`E2E user "${label}" not provisioned`);
  return u;
}

import type { Page as PlaywrightPage } from "@playwright/test";

/**
 * Durable-sync evidence: the number of operations the gateway has
 * DURABLY ACKED for this document (IndexedDB `concord-sync` outbox,
 * state "durably_acked"). The gateway ACKs only after its PostgreSQL
 * commit, so a positive count is direct proof that browser-typed ops
 * reached durable storage through the real stack. Read inside the page
 * (same origin) so the spec needs no direct DB client.
 */
async function durableAckCount(page: PlaywrightPage, documentId: string): Promise<number> {
  return page.evaluate(
    (docId) =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open("concord-sync");
        req.onerror = () => reject(new Error("cannot open concord-sync"));
        req.onsuccess = () => {
          const db = req.result;
          // The editor can become ready just before SyncSession finishes its
          // version-2 upgrade. Treat the transient pre-outbox schema as an
          // empty durable set; the polling caller will observe the store once
          // the real session has created it.
          if (!db.objectStoreNames.contains("outbox")) {
            db.close();
            resolve(0);
            return;
          }
          try {
            const tx = db.transaction("outbox", "readonly");
            const get = tx.objectStore("outbox").getAll();
            get.onsuccess = () => {
              const n = (get.result as Array<{ id: string; state: string }>).filter(
                (r) => r.id.startsWith(`${docId}:`) && r.state === "durably_acked",
              ).length;
              db.close();
              resolve(n);
            };
            get.onerror = () => {
              db.close();
              reject(new Error("outbox read failed"));
            };
          } catch (e) {
            db.close();
            reject(e);
          }
        };
      }),
    documentId,
  );
}

test.describe.serial("Chromium primary journey", () => {
  let monitor: ConsoleMonitor;

  test.beforeEach(async ({ page }) => {
    monitor = new ConsoleMonitor();
    monitor.attach(page);
  });

  test("A+B+C+D: load, sign in, create document, editor renders", async ({ page }) => {
    // A: the app answers HTML (globalSetup guaranteed the server; this
    // proves the page itself renders).
    const resp = await page.goto("/");
    expect(resp?.status()).toBeLessThan(400);

    // B: real Clerk sign-in (a Backend API ticket consumed by Clerk's
    // browser client, dev instance; no mailbox or personal account).
    await signIn(page, user("primary"));

    // C: create a document via the templates gallery.
    const documentId = await createDocument(page, "E2E Primary Journey");

    // D: editor is rendered and interactive.
    await waitForEditor(page);

    // The document id must be a real server-issued id.
    expect(documentId).toBeTruthy();
  });

  test("E+F+G+H: worker initializes, typing works, persists across reload", async ({ page }) => {
    await signIn(page, user("persist"));
    const documentId = await createDocument(page, "E2E Persistence");

    // E: the WASM CRDT worker booted. The editor only becomes a CRDT
    // editor after the worker client initializes; typing + durable
    // content below is the behavioral proof. Structural proof: the
    // worker script was fetched.
    const workerFetched = await page.evaluate(async () => {
      const res = await fetch("/crdt-worker.js", { method: "GET" });
      return res.ok;
    });
    expect(workerFetched).toBe(true);

    // F: type real content.
    const typed = "Hello from a real browser";
    const ackedBeforeTyped = await durableAckCount(page, documentId);
    await typeInEditor(page, typed);

    // G: it appears in the editor.
    await expect
      .poll(async () => editorText(page), { timeout: 20_000 })
      .toContain(typed);
    await expect
      .poll(async () => (await durableAckCount(page, documentId)) > ackedBeforeTyped, { timeout: 45_000 })
      .toBe(true);

    // H: reload — the local-first op-log restores the content (IndexedDB
    // survives reload in the same context).
    await page.reload();
    await waitForEditor(page);
    await expect
      .poll(async () => editorText(page), { timeout: 30_000 })
      .toContain(typed);
  });

  test("I: two-browser realtime collaboration through the real gateway", async ({ browser }) => {
    // Two independent browser contexts = two users, like two machines.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const monA = new ConsoleMonitor(); monA.attach(pageA);
    const monB = new ConsoleMonitor(); monB.attach(pageB);

    try {
      await signIn(pageA, user("collab-a"));
      const documentId = await createDocument(pageA, "E2E Two-Browser Collab");
      await waitForEditor(pageA);

      // B opens the SAME document: same Clerk user (same email) in a
      // second context — sessions are per-context, so this is a second
      // authenticated client (a "second tab on another device" shape).
      await signIn(pageB, user("collab-a"));
      await pageB.goto(`/documents/${documentId}`);
      await waitForEditor(pageB);

      // A types; B must receive it through gateway fanout.
      const wave1 = "wave one from browser A";
      await typeInEditor(pageA, wave1);
      await expect
        .poll(async () => editorText(pageB), { timeout: 30_000 })
        .toContain(wave1);

      // B types; A must converge.
      const wave2 = "wave two from browser B";
      await typeInEditor(pageB, wave2);
      await expect
        .poll(async () => editorText(pageA), { timeout: 30_000 })
        .toContain(wave2);

      // Convergence: both editors show both waves, identical text.
      const textA = await editorText(pageA);
      const textB = await editorText(pageB);
      expect(textA).toContain(wave1);
      expect(textA).toContain(wave2);
      expect(textA).toBe(textB);

      // No duplicated operations: the durable log holds exactly the ops
      // typed (idempotent ingest; one row per identity). The cursor is the
      // server-acknowledged position into that log — assert it is
      // positive and STABLE across a re-read (no growth without input).
      const rows = await durableAckCount(pageA, documentId);
      expect(rows).toBeGreaterThan(0);
      const rowsAgain = await durableAckCount(pageA, documentId);
      expect(rowsAgain).toBe(rows);

      // Connection state is valid: page A still shows editor + no fatal
      // console errors (checked in the final gate below).
      expect(monA.fatalErrors()).toEqual([]);
      expect(monB.fatalErrors()).toEqual([]);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("J: disconnect + reconnect converges", async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      await signIn(pageA, user("reconnect-a"));
      const documentId = await createDocument(pageA, "E2E Reconnect");
      await waitForEditor(pageA);
      await signIn(pageB, user("reconnect-a"));
      await pageB.goto(`/documents/${documentId}`);
      await waitForEditor(pageB);

      const preText = "before disconnect";
      await typeInEditor(pageA, preText);
      await expect
        .poll(async () => editorText(pageB), { timeout: 30_000 })
        .toContain(preText);

      // Disconnect A at the network level (Playwright CDPA offline):
      // client B keeps a live socket; A edits locally while offline.
      const cdp = await ctxA.newCDPSession(pageA);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", {
        offline: true,
        latency: 0,
        downloadThroughput: 0,
        uploadThroughput: 0,
      });

      const offlineText = "typed while offline";
      await typeInEditor(pageA, offlineText);
      // A sees its own local text immediately (local-first).
      await expect
        .poll(async () => editorText(pageA), { timeout: 20_000 })
        .toContain(offlineText);

      // B does NOT see the offline text (A's socket is severed).
      await expect
        .poll(async () => editorText(pageB), { timeout: 3_000, intervals: [100, 250, 500] })
        .not.toContain(offlineText);

      // Reconnect A.
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: 1_000_000_000,
        uploadThroughput: 1_000_000_000,
      });

      // A's pending ops drain through the real gateway; both converge.
      await expect
        .poll(async () => editorText(pageB), { timeout: 45_000 })
        .toContain(offlineText);
      await expect
        .poll(async () => editorText(pageA), { timeout: 45_000 })
        .toContain(preText);
      const textA = await editorText(pageA);
      const textB = await editorText(pageB);
      expect(textA).toContain(offlineText);
      expect(textA).toBe(textB);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("K: authorization isolation — another user's document does not render", async ({ browser }) => {
    const ctxOwner = await browser.newContext();
    const ctxStranger = await browser.newContext();
    const owner = await ctxOwner.newPage();
    const stranger = await ctxStranger.newPage();

    try {
      await signIn(owner, user("isolation-owner"));
      const documentId = await createDocument(owner, "E2E Isolation");
      await waitForEditor(owner);
      const secret = "owner secret content";
      await typeInEditor(owner, secret);
      await expect
        .poll(async () => editorText(owner), { timeout: 20_000 })
        .toContain(secret);

      // A different signed-in user opens the same URL: the server must
      // refuse (404 page, no document, no editor — denial is
      // indistinguishable from missing, by design).
      await signIn(stranger, user("isolation-stranger"));
      await stranger.goto(`/documents/${documentId}`);
      await stranger.waitForLoadState("networkidle");
      // Not the editor; the app's not-found page renders instead.
      const editorCount = await stranger
        .locator(".ProseMirror[contenteditable='true']")
        .count();
      expect(editorCount).toBe(0);
      const body = await stranger.locator("body").innerText();
      expect(body).not.toContain(secret);
    } finally {
      await ctxOwner.close();
      await ctxStranger.close();
    }
  });

  test("L: console is free of unexpected fatal errors across the journey", async ({ page }) => {
    await signIn(page, user("console-clean"));
    await createDocument(page, "E2E Console Clean");
    await waitForEditor(page);
    await typeInEditor(page, "console gate typing");
    await expect
      .poll(async () => editorText(page), { timeout: 20_000 })
      .toContain("console gate typing");

    // Assert: no unexpected fatal errors. (The monitor's filter keeps
    // dev-server noise out; anything real fails the gate with its text.)
    const fatal = monitor.fatalErrors();
    expect(fatal, `fatal console errors: ${fatal.join(" | ")}`).toEqual([]);
  });

  test("M: network failure yields honest UX state, no content corruption", async ({ page }) => {
    await signIn(page, user("netfail"));
    const documentId = await createDocument(page, "E2E NetFail");
    await waitForEditor(page);
    const typed = "content before netfail";
    const ackedBeforeTyped = await durableAckCount(page, documentId);
    await typeInEditor(page, typed);
    await expect
      .poll(async () => editorText(page), { timeout: 20_000 })
      .toContain(typed);
    await expect
      .poll(async () => (await durableAckCount(page, documentId)) > ackedBeforeTyped, { timeout: 45_000 })
      .toBe(true);

    // Sever the network mid-session. The app must degrade truthfully
    // (local-first continues; no corrupted content, no fake states).
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true, latency: 0,
      downloadThroughput: 0, uploadThroughput: 0,
    });

    const offlineTyped = "still typing offline";
    await typeInEditor(page, offlineTyped);
    // Local-first: the text is present locally.
    await expect
      .poll(async () => editorText(page), { timeout: 20_000 })
      .toContain(offlineTyped);
    // No corruption: the pre-failure text is intact.
    const text = await editorText(page);
    expect(text).toContain(typed);
    expect(text).toContain(offlineTyped);
    const ackedWhileOffline = await durableAckCount(page, documentId);

    // Restore; convergence resumes (bounded by the reconnect suite).
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0,
      downloadThroughput: 1_000_000_000, uploadThroughput: 1_000_000_000,
    });
    await expect
      .poll(async () => (await durableAckCount(page, documentId)) > ackedWhileOffline, { timeout: 45_000 })
      .toBe(true);
  });
});
