import { test, expect } from "@playwright/test";

import {
  createDocument,
  editorText,
  signIn,
  type E2eUser,
  typeInEditor,
  waitForEditor,
} from "./helpers";

function user(label: string): E2eUser {
  const users = JSON.parse(process.env.CONCORD_E2E_USERS || "{}") as Record<string, E2eUser>;
  const value = users[label];
  if (!value) throw new Error(`E2E user "${label}" not provisioned`);
  return value;
}

test("review tools: history, comments, drafts, and Concordpack work in the browser", async ({ page }) => {
  await signIn(page, user("primary"));
  const documentId = await createDocument(page, "Review tools browser gate");
  await waitForEditor(page);

  const editor = page.locator(".ProseMirror[contenteditable='true']").first();
  await typeInEditor(page, "Review this phrase");
  await expect.poll(async () => editorText(page), { timeout: 20_000 }).toContain("Review this phrase");

  await page.getByRole("button", { name: "Open review, history, and draft tools" }).click();
  await expect(page.getByRole("heading", { name: "Review and document history" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "History" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Comments" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Drafts" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Concordpack" })).toBeVisible();

  await page.getByPlaceholder("Checkpoint name").fill("Browser checkpoint");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "checkpoint" })).toBeVisible({ timeout: 20_000 });

  // Preview the named revision, then restore it through the owner-only
  // durable path. The extra text makes the restore assertion prove that the
  // gateway appended forward operations rather than merely returning 200.
  await page.getByRole("button", { name: /Browser checkpoint/ }).click();
  await expect(page.getByRole("heading", { name: "Read-only preview" })).toBeVisible();
  await expect(page.getByRole("tabpanel").getByText("Review this phrase", { exact: true })).toBeVisible();
  await typeInEditor(page, " after checkpoint");
  await expect.poll(async () => editorText(page), { timeout: 20_000 }).toContain("after checkpoint");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Restore version" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Restore committed" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => editorText(page), { timeout: 30_000 }).not.toContain("after checkpoint");

  await editor.selectText();
  await page.getByRole("tab", { name: "Comments" }).click();
  await page.locator("#new-comment").fill("Please review this phrase");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Please review this phrase")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("tab", { name: "Drafts" }).click();
  await page.getByRole("textbox", { name: "New draft name" }).fill("Alternative wording");
  await page.getByRole("button", { name: "New draft" }).click();
  await expect(page.getByText("Alternative wording")).toBeVisible();
  await page.locator("#draft-block-0").fill("Draft phrase");
  await page.locator("#draft-block-0").blur();
  const change = page.getByText(/Draft change/).first();
  await expect(change).toBeVisible();
  await change.locator("xpath=..//input[@type='checkbox']").check();
  await page.getByRole("button", { name: "Apply selected to editor" }).click();
  await expect.poll(async () => editorText(page), { timeout: 20_000 }).toContain("Draft phrase");

  await page.getByRole("tab", { name: "Concordpack" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export verified bundle" }).click();
  const download = await downloadPromise;
  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  await page.locator('input[type="file"][aria-label="Choose a Concord document bundle"]').setInputFiles(filePath!);
  await expect(page.getByRole("status").filter({ hasText: "passed checksum" })).toBeVisible({ timeout: 20_000 });

  // Feature 5: the gateway's Merkle + Ed25519 state receipt verifies against
  // this replica's own digest (client fully synced at this point).
  await page.getByRole("button", { name: "Verify server receipt" }).click();
  await expect(page.getByText(/Server receipt verified/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/matches this replica: yes/)).toBeVisible({ timeout: 20_000 });

  // Time-travel replay: fold the durable local op log. The latest position
  // mirrors the live document; scrubbing to the start empties it; both are
  // reconstructed entirely client-side from exportOps().
  await page.getByRole("tab", { name: "Replay" }).click();
  await expect(page.getByRole("heading", { name: "Time-travel replay" })).toBeVisible();
  const replaySlider = page.getByRole("slider", { name: "Replay position" });
  await expect(replaySlider).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("tabpanel").getByText("Draft phrase")).toBeVisible({ timeout: 20_000 });
  await replaySlider.focus();
  await page.keyboard.press("Home");
  await expect(page.getByRole("tabpanel").getByText("Draft phrase")).toHaveCount(0, { timeout: 20_000 });
  await page.keyboard.press("End");
  await expect(page.getByRole("tabpanel").getByText("Draft phrase")).toBeVisible({ timeout: 20_000 });

  // Markdown: export the live document, then import it back through the
  // editor bridge — the same content arrives as new CRDT edits.
  await page.getByRole("tab", { name: "Markdown" }).click();
  await page.getByRole("button", { name: "Export markdown" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Exported" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Import as new edits" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Imported as new editor edits" })).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => editorText(page), { timeout: 20_000 }).toContain("Draft phrase");

  // Suggestions (Feature 4): propose a replacement for the whole document,
  // then accept it — the change applies as normal durable CRDT edits.
  const suggestionEditor = page.locator(".ProseMirror[contenteditable='true']").first();
  await suggestionEditor.selectText();
  await page.getByRole("tab", { name: "Suggestions" }).click();
  await page.getByLabel("Proposed replacement text").fill("Replaced by suggestion");
  await page.getByRole("button", { name: "Propose change" }).click();
  await expect(page.getByText("Replaced by suggestion").first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Accept & apply" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Suggestion applied" })).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => editorText(page), { timeout: 20_000 }).toContain("Replaced by suggestion");

  await expect(page).toHaveURL(new RegExp(`/documents/${documentId}$`));
});
