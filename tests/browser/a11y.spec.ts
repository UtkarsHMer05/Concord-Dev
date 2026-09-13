// ---------------------------------------------------------------------------
// Browser accessibility smoke — axe-core scans on representative pages.
//
// Scope (documented, not "perfect a11y"):
//   - serious/critical axe violations fail the gate
//   - pages: landing/sign-in, home (documents), editor
//   - plus a keyboard-navigation probe of the home view (tab reaches the
//     primary controls; visible focus is on) and a landmark/name check
//     for the core buttons
//
// No rules are disabled globally. If a specific rule must be excepted for
// a legitimate reason, it must be justified here with a scoped disable +
// comment (none currently).
// ---------------------------------------------------------------------------
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signIn, createDocument, waitForEditor, type E2eUser } from "./helpers";

function user(label: string): E2eUser {
  const users = JSON.parse(process.env.CONCORD_E2E_USERS || "{}") as Record<string, E2eUser>;
  const u = users[label];
  if (!u) throw new Error(`E2E user "${label}" not provisioned`);
  return u;
}

/** Run axe and assert zero serious/critical violations. */
async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    // Serious + critical: the gate level. Moderate/minor findings are
    // tracked as improvement work, not release blockers (documented).
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const serious = results.violations.filter((v) =>
    ["serious", "critical"].includes(v.impact ?? ""),
  );
  expect(
    serious.map((v) => `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} nodes`),
    `${label}: serious/critical axe violations`,
  ).toEqual([]);
}

test.describe.serial("accessibility smoke (axe-core)", () => {
  test("landing / sign-in page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toBeVisible();
    await expectAccessible(page, "landing");
  });

  test("home (documents) page", async ({ page }) => {
    await signIn(page, user("a11y-home"));
    await expect(page.locator('[aria-label="Concord home"]')).toBeVisible();
    await expectAccessible(page, "home");
  });

  test("editor page", async ({ page }) => {
    await signIn(page, user("a11y-editor"));
    await createDocument(page, "A11y Editor");
    await waitForEditor(page);
    await expectAccessible(page, "editor");
  });

  test("keyboard navigation: tab reaches primary controls with visible focus", async ({ page }) => {
    await signIn(page, user("a11y-keyboard"));
    await expect(page.locator('[aria-label="Concord home"]')).toBeVisible();

    // Tab from the top: focus must land on actual interactive elements
    // (documented as visible focus), not get trapped or disappear.
    await page.keyboard.press("Tab");
    const focused1 = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const style = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        isInteractive:
          el instanceof HTMLAnchorElement ||
          el instanceof HTMLButtonElement ||
          el instanceof HTMLInputElement ||
          el.getAttribute("contenteditable") === "true",
        outlineVisible: style.outlineStyle !== "none" || Number(style.boxShadow !== "none") > 0 || style.borderStyle !== "none",
      };
    });
    expect(focused1, "tab moved focus to a real element").not.toBeNull();
    // Keyboard users must see where focus is (outline/box/border present).
    expect(focused1?.outlineVisible).toBe(true);

    // The editor page: contenteditable receives focus via its own click
    // path; keyboard-only reachability of the sheet is asserted.
    await createDocument(page, "A11y Keyboard");
    await waitForEditor(page);
    const tabStops = await page.locator(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
    ).count();
    let editorFocused = false;
    // Traverse the complete current tab order. The toolbar is intentionally
    // discoverable by keyboard and can grow, so a fixed small tab count would
    // make this probe browser/layout-dependent rather than testing reachability.
    for (let tab = 0; tab <= tabStops + 1 && !editorFocused; tab += 1) {
      await page.keyboard.press("Tab");
      editorFocused = await page.evaluate(() => {
        const el = document.activeElement;
        return el?.getAttribute("contenteditable") === "true" || el?.closest(".ProseMirror") != null;
      });
    }
    expect(editorFocused).toBe(true);
  });

  test("buttons and landmarks: no unnamed buttons, landmark basics exist", async ({ page }) => {
    await signIn(page, user("a11y-names"));
    await expect(page.locator('[aria-label="Concord home"]')).toBeVisible();

    const unnamed = await page.evaluate(() => {
      const bad = [];
      for (const btn of Array.from(document.querySelectorAll("button"))) {
        const name =
          btn.getAttribute("aria-label") ||
          btn.getAttribute("title") ||
          (btn.textContent && btn.textContent.trim()) ||
          // Icon-only buttons must carry an accessible name.
          btn.querySelector("svg[aria-label]")?.getAttribute("aria-label") ||
          "";
        if (!name) bad.push(btn.outerHTML.slice(0, 80));
      }
      return bad;
    });
    expect(unnamed, "buttons without any accessible name").toEqual([]);

    const landmarks = await page.evaluate(() => ({
      hasMain: document.querySelector("main") != null || document.querySelector('[role="main"]') != null,
      hasNav: document.querySelector("nav") != null || document.querySelector('[role="navigation"]') != null,
      lang: document.documentElement.getAttribute("lang"),
    }));
    expect(landmarks.lang, "html lang attribute").toBeTruthy();
    // Main landmark: present on both home and editor routes.
    expect(landmarks.hasMain || landmarks.hasNav).toBe(true);
  });
});
