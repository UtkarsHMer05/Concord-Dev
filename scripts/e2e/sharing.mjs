// Disposable accounts; real production web, Clerk/JWKS, WASM, gateway, and PostgreSQL.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import setup from '../browser-e2e-setup.mjs';
import { signIn, createDocument, waitForEditor, ConsoleMonitor } from '../../tests/browser/helpers.ts';

process.env.CONCORD_E2E_PROFILE = 'full';
const output = path.resolve('output/playwright/sharing');
await fs.mkdir(output, { recursive: true });
await fs.rm(path.join(output, 'finish-live'), { force: true });
const cleanup = await setup();
const stages = []; const monitors = [];
let browser; let db;
try {
  browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
  const users = JSON.parse(process.env.CONCORD_E2E_USERS);
  const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext({ baseURL: process.env.CONCORD_E2E_BASE_URL, viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] })));
  const [owner, recipient, stranger] = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of [owner, recipient, stranger]) { const monitor = new ConsoleMonitor(); monitor.attach(page); monitors.push(monitor); }
  assert.match(process.env.CONCORD_E2E_DB, /\/concord_e2e$/);
  db = new pg.Pool({ connectionString: process.env.CONCORD_E2E_DB });
  const surface = (page) => page.locator('.ProseMirror').first();
  const share = async () => {
    await owner.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(owner.getByRole('dialog').getByLabel('Collaborator email')).toBeVisible();
  };
  const dialog = () => owner.getByRole('dialog');
  const grant = async (email, role = 'COMMENTER') => {
    await dialog().getByLabel('Collaborator email').fill(email);
    await dialog().getByLabel('Access', { exact: true }).selectOption(role);
    await dialog().getByRole('button', { name: 'Grant access', exact: true }).click();
    await expect(dialog().getByRole('status')).toContainText('Access granted');
    await expect(dialog().getByLabel('Collaborator email')).toHaveValue('');
    await expect(dialog().getByRole('region', { name: 'Document sharing' })).toHaveAttribute('aria-busy', 'false');
  };
  const recipientRow = () => dialog().getByRole('listitem').filter({ hasText: users.primary.email });
  const closeShare = () => dialog().getByRole('button', { name: 'Close', exact: true }).click();
  const title = 'RFC: collaborative access';
  await signIn(owner, users['collab-a']);
  const documentId = await createDocument(owner, title); await waitForEditor(owner);
  await owner.getByRole('button', { name: 'Blank document', exact: true }).click();
  await owner.getByRole('textbox', { name: 'Document title' }).fill(title);
  await owner.getByRole('textbox', { name: 'Document title' }).press('Enter');
  await surface(owner).click(); await owner.keyboard.insertText('Share this proposal with your team.');
  await expect.poll(async () => (await db.query('SELECT COUNT(*)::int AS count FROM crdt_operations WHERE document_id=$1', [documentId])).rows[0].count, { timeout: 30000 }).toBeGreaterThan(0);
  await share();
  await dialog().getByLabel('Collaborator email').fill('no-account-for-sharing@example.com');
  await dialog().getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(dialog().getByRole('alert')).toContainText('No account with this verified email');
  await expect(dialog().getByLabel('Collaborator email')).toHaveValue('no-account-for-sharing@example.com');
  await grant(users.primary.email.toUpperCase()); // Recipient has not opened Concord yet.
  await grant(users['isolation-stranger'].email, 'VIEWER');
  await dialog().getByRole('button', { name: 'Copy document link' }).click();
  assert.equal(await owner.evaluate(() => navigator.clipboard.readText()), new URL(`/documents/${documentId}`, process.env.CONCORD_E2E_BASE_URL).href);
  await owner.screenshot({ path: path.join(output, 'share-dialog.png') });
  const dialogAxe = await new AxeBuilder({ page: owner }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa']).analyze();
  assert.deepEqual(dialogAxe.violations, []);
  await owner.setViewportSize({ width: 390, height: 844 });
  await expect(dialog().getByLabel('Collaborator email')).toBeVisible();
  const overflows = () => dialog().evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return element.scrollWidth > element.clientWidth || bounds.left < 0 || bounds.right > window.innerWidth;
  });
  // Wait for the responsive layout and dialog transition to settle after resizing.
  await expect.poll(overflows).toBe(false);
  const dialogOverflow = await overflows();
  await owner.screenshot({ path: path.join(output, 'share-mobile.png') });
  await owner.keyboard.press('Escape');
  await expect(owner.getByRole('dialog')).toHaveCount(0);
  await expect(owner.getByRole('button', { name: 'Share', exact: true })).toBeFocused();
  await owner.setViewportSize({ width: 1440, height: 1000 });
  stages.push('owner shares by verified email before recipient first visit; unknown account preserves input; clipboard, keyboard, desktop/mobile and accessible dialog pass');
  console.log('[sharing] email grants and dialog checks passed');

  await signIn(recipient, users.primary);
  await recipient.getByRole('link', { name: 'Shared with me', exact: true }).click();
  await expect(recipient.getByRole('link', { name: title, exact: true })).toBeVisible();
  await expect(recipient.getByRole('row').filter({ hasText: title })).toContainText('Can comment');
  await recipient.getByRole('searchbox', { name: 'Search documents by title' }).fill('No matching shared title');
  await recipient.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(recipient.getByRole('link', { name: title, exact: true })).toHaveCount(0);
  assert.equal(new URL(recipient.url()).searchParams.get('scope'), 'shared');
  await recipient.getByRole('searchbox', { name: 'Search documents by title' }).fill('collaborative access');
  await recipient.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(recipient.getByRole('link', { name: title, exact: true })).toBeVisible();
  await recipient.getByRole('button', { name: 'Clear search' }).click();
  await expect(recipient.getByRole('link', { name: title, exact: true })).toBeVisible();
  await recipient.screenshot({ path: path.join(output, 'shared-with-me.png') });
  const homeAxe = await new AxeBuilder({ page: recipient }).include('[aria-label="Document collections"]').withTags(['wcag2a', 'wcag2aa']).analyze();
  assert.deepEqual(homeAxe.violations, []);
  await recipient.getByRole('link', { name: title, exact: true }).click();
  await expect(surface(recipient)).toHaveAttribute('contenteditable', 'false');
  await expect(surface(recipient)).toContainText('Share this proposal with your team.', { timeout: 30000 });
  await surface(recipient).locator('p').first().selectText();
  await recipient.getByRole('button', { name: 'Open review, history, and draft tools' }).click();
  await recipient.getByRole('tab', { name: 'Comments', exact: true }).click();
  await expect(recipient.getByRole('textbox', { name: 'New thread' })).toBeVisible();
  await recipient.getByRole('textbox', { name: 'New thread' }).fill('Reviewed: keep access limited to this team.');
  await recipient.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(recipient.getByRole('tabpanel')).toContainText('Reviewed: keep access limited to this team.');
  const forbiddenGrant = await recipient.request.post(`/api/documents/${documentId}/permissions`, { data: { action: 'grant', email: users.primary.email, role: 'EDITOR' } });
  assert.equal(forbiddenGrant.status(), 404);
  await signIn(stranger, users['isolation-owner']);
  const hidden = await stranger.request.get(`/api/documents/${documentId}/permissions`); assert.equal(hidden.status(), 404);
  await stranger.getByRole('link', { name: 'Shared with me', exact: true }).click();
  await expect(stranger.getByRole('link', { name: title, exact: true })).toHaveCount(0);
  stages.push('recipient discovers explicit invitation across workspaces; commenter reads and can comment; unrelated account cannot discover/open; non-owner cannot grant');
  console.log('[sharing] discovery and authorization passed');

  await share();
  await recipientRow().getByRole('combobox').selectOption('EDITOR');
  await expect(dialog().getByRole('status')).toContainText('Role updated');
  await expect(surface(recipient)).toHaveAttribute('contenteditable', 'true', { timeout: 30000 });
  await recipient.getByRole('button', { name: 'Close review and history panel' }).last().click();
  await surface(recipient).click(); await recipient.keyboard.press('ControlOrMeta+End');
  await recipient.keyboard.insertText(' Recipient edit is durable.');
  await expect(surface(owner)).toContainText('Recipient edit is durable.', { timeout: 30000 });
  await recipientRow().getByRole('combobox').selectOption('VIEWER');
  await expect(dialog().getByRole('status')).toContainText('Role updated');
  await expect(surface(recipient)).toHaveAttribute('contenteditable', 'false', { timeout: 30000 });
  await recipient.getByRole('button', { name: 'Open review, history, and draft tools' }).click();
  await recipient.getByRole('tab', { name: 'Comments', exact: true }).click();
  await expect(recipient.getByRole('textbox', { name: 'New thread' })).toHaveCount(0);
  await recipient.getByRole('button', { name: 'Close review and history panel' }).last().click();
  await recipient.screenshot({ path: path.join(output, 'viewer.png') });
  stages.push('live commenter-to-editor promotion enables real edits and fanout; editor-to-viewer downgrade disables editor and comment form');
  console.log('[sharing] live role changes passed');

  // Deliberately pause HTTP access polling: gateway revocation must work independently.
  const blockedPolls = (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Access status temporarily unavailable' }) });
  await recipient.route('**/permissions?status=1', blockedPolls);
  await recipientRow().getByRole('button', { name: /^Remove access for/ }).click();
  await expect(dialog().getByRole('status')).toContainText(/[Aa]ccess removed/);
  await expect(recipientRow()).toHaveCount(0);
  await closeShare();
  const beforePrivateOps = (await db.query('SELECT COUNT(*)::int AS count FROM crdt_operations WHERE document_id=$1', [documentId])).rows[0].count;
  await surface(owner).click(); await owner.keyboard.press('ControlOrMeta+End');
  await owner.keyboard.insertText(' Private text after removal.');
  await expect(surface(owner)).toContainText('Private text after removal.');
  await expect.poll(async () => (await db.query('SELECT COUNT(*)::int AS count FROM crdt_operations WHERE document_id=$1', [documentId])).rows[0].count, { timeout: 30000 }).toBeGreaterThan(beforePrivateOps);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((await surface(recipient).innerText()).includes('Private text after removal.'), false);
  assert.equal((await recipient.request.get(`/api/documents/${documentId}/permissions`)).status(), 404);
  await recipient.unroute('**/permissions?status=1', blockedPolls);
  await expect(recipient.getByText('Document not found', { exact: true })).toBeVisible({ timeout: 30000 });
  await recipient.goto('/?scope=shared');
  await expect(recipient.getByRole('link', { name: title, exact: true })).toHaveCount(0);
  stages.push('revoked open viewer receives no new content even with web polling unavailable; HTTP is denied; open page and Shared with me remove access');
  console.log('[sharing] independent gateway revocation passed');

  await owner.getByRole('button', { name: 'Share', exact: true }).click();
  await owner.route(`**/documents/${documentId}/permissions`, async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Sharing is temporarily unavailable' }) });
    else await route.continue();
  });
  await dialog().getByLabel('Collaborator email').fill(users.primary.email);
  await dialog().getByRole('button', { name: 'Grant access', exact: true }).click();
  await expect(dialog().getByRole('alert')).toContainText('Sharing is temporarily unavailable');
  await expect(dialog().getByLabel('Collaborator email')).toHaveValue(users.primary.email);
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM document_user_permissions WHERE document_id=$1', [documentId])).rows[0].count, 1);
  await owner.unroute(`**/documents/${documentId}/permissions`);
  await grant(users.primary.email, 'VIEWER');
  await owner.screenshot({ path: path.join(output, 'share-dialog.png') });
  stages.push('service failure preserves invite input and creates no phantom access; retry succeeds');

  const pageErrors = monitors.flatMap((monitor) => monitor.all().filter((message) => message.startsWith('pageerror:')));
  assert.deepEqual(pageErrors, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, webMode: process.env.CONCORD_E2E_MODE || 'dev', browser: browser.version(), stages, dialogAxeViolations: dialogAxe.violations.length, collectionAxeViolations: homeAxe.violations.length, mobileDialogOverflow: dialogOverflow, pageErrors, expectedHttpErrors: ['400: unknown verified email', '404: non-owner or inaccessible document', '503: deliberately interrupted service/status polling'], console: monitors.map((monitor) => monitor.all()) }, null, 2));
  console.log(`[sharing] PASS: ${stages.length} acceptance stages`);
  if (process.argv.includes('--hold')) {
    // Keep only this disposable stack available for manual, visible browser inspection.
    await owner.context().storageState({ path: path.join(output, 'owner-auth.json') });
    await fs.writeFile(path.join(output, 'live.json'), JSON.stringify({ origin: process.env.CONCORD_E2E_BASE_URL, documentId, owner: users['collab-a'], recipient: users.primary }));
    console.log('[sharing] LIVE: waiting for output/playwright/sharing/finish-live');
    for (let attempt = 0; attempt < 600; attempt++) {
      try { await fs.access(path.join(output, 'finish-live')); break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
} catch (error) {
  const pages = browser?.contexts().flatMap((context) => context.pages()) ?? [];
  for (let index = 0; index < pages.length; index++) {
    console.log('[sharing] failure page:', index, pages[index].url());
    await pages[index].screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {});
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, stages, error: String(error), console: monitors.map((monitor) => monitor.all()) }, null, 2));
  throw error;
} finally { await browser?.close(); await db?.end(); await cleanup(); }
