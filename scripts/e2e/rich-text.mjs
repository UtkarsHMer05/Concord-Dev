// Real UI → WASM/IndexedDB → Rust/PostgreSQL → second authenticated browser.
// Reuses the existing disposable harness; never touches the development database.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import pg from 'pg';
import setup from '../browser-e2e-setup.mjs';
import { signIn, createDocument, waitForEditor, ConsoleMonitor } from '../../tests/browser/helpers.ts';

process.env.CONCORD_E2E_PROFILE = 'full';
const output = path.resolve('output/playwright/rich-text');
await fs.mkdir(output, { recursive: true });
const cleanup = await setup();
let browser;
let db;
const stages = [];
const monitors = [];
try {
    browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
    const origin = process.env.CONCORD_E2E_BASE_URL;
    const users = JSON.parse(process.env.CONCORD_E2E_USERS);
    const contextA = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
    const contextB = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } });
    const a = await contextA.newPage(); const b = await contextB.newPage();
    const monA = new ConsoleMonitor(); monA.attach(a);
    const monB = new ConsoleMonitor(); monB.attach(b);
    monitors.push(monA, monB);
    await signIn(a, users.primary); await signIn(b, users['collab-a']);
    const id = await createDocument(a, 'Rich-text collaboration');
    await waitForEditor(a);
    assert.match(process.env.CONCORD_E2E_DB, /\/concord_e2e$/);
    db = new pg.Pool({ connectionString: process.env.CONCORD_E2E_DB });
    await db.query(`INSERT INTO document_user_permissions(document_id, user_id, role, granted_by_user_id)
        SELECT d.id, u.id, 'EDITOR', d.owner_user_id FROM documents d, users u
        WHERE d.id = $1 AND u.clerk_user_id = $2`, [id, users['collab-a'].clerkUserId]);
    const surface = (page) => page.locator('.ProseMirror[contenteditable="true"]').first();
    await fs.writeFile(path.join(output, 'steps.jsonl'), '');
    const record = async (page, action) => {
        const state = await surface(page).evaluate((el) => ({ html: el.innerHTML, selection: String(window.getSelection()), offset: window.getSelection()?.focusOffset }));
        await fs.appendFile(path.join(output, 'steps.jsonl'), JSON.stringify({ action, ...state }) + '\n');
    };
    const list = async (page, label) => {
        await page.getByRole('button', { name: 'Lists', exact: true }).click();
        await page.getByRole('menuitem', { name: label, exact: true }).click();
        await expect(surface(page)).toBeFocused();
        await record(page, label);
    };
    const end = async (page) => { await surface(page).click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); };
    const selectPrevious = async (page, text) => { for (let i = 0; i < [...text].length; i += 1) await page.keyboard.press('Shift+ArrowLeft', { delay: 25 }); };
    const selectLine = async (page, text) => {
        await surface(page).locator('p').filter({ hasText: new RegExp(`^${text}$`) }).click();
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
        await selectPrevious(page, text);
    };
    const input = async (page, text) => { await page.keyboard.insertText(text); await record(page, text); };
    const settle = async (page) => {
        await expect.poll(() => page.evaluate(() => new Promise((resolve, reject) => {
            const open = indexedDB.open('concord-sync');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const d = open.result;
                if (!d.objectStoreNames.contains('outbox')) { d.close(); resolve(-1); return; }
                const request = d.transaction('outbox').objectStore('outbox').getAll();
                request.onsuccess = () => { const pending = request.result.filter((r) => r.state !== 'durably_acked').length; d.close(); resolve(pending); };
                request.onerror = () => reject(request.error);
            };
        })), { timeout: 45000 }).toBe(0);
    };
    const html = (page) => surface(page).innerHTML();
    const matches = async () => {
        await expect.poll(async () => [await html(a), await html(b)], { timeout: 45000 }).toEqual([await html(a), await html(a)]);
    };
    await list(a, 'Bullet List'); await input(a, 'Parent'); await a.keyboard.press('Enter');
    await input(a, 'Child'); await list(a, 'Indent list item');
    await a.keyboard.press('Enter'); await input(a, 'Nested sibling');
    await list(a, 'Outdent list item');
    await a.keyboard.press('Enter'); await a.keyboard.press('Enter');
    await list(a, 'Ordered List'); await input(a, 'Plan'); await a.keyboard.press('Enter'); await input(a, 'Implement');
    await a.keyboard.press('Enter'); await a.keyboard.press('Enter');
    await list(a, 'Task List'); await input(a, 'Release checklist'); await a.keyboard.press('Enter'); await input(a, 'Run tests');
    await a.keyboard.press('Enter'); await a.keyboard.press('Enter');
    await input(a, 'Concord docs'); await selectPrevious(a, 'Concord docs');
    await a.getByRole('button', { name: 'Insert link', exact: true }).click();
    await a.getByRole('textbox', { name: 'Link URL' }).fill('https://example.com/concord');
    await a.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(surface(a)).toBeFocused();
    await record(a, 'Link applied');
    await expect(a.locator('.tiptap a[href="https://example.com/concord"]')).toHaveText('Concord docs');
    await a.keyboard.press('ArrowRight', { delay: 80 }); await record(a, 'After link ArrowRight');
    await a.keyboard.press('Enter'); await record(a, 'After link Enter');
    await input(a, 'npm test'); await selectPrevious(a, 'npm test');
    await a.getByRole('button', { name: 'Inline code', exact: true }).click();
    await expect(surface(a)).toBeFocused();
    await a.keyboard.press('ArrowRight', { delay: 80 });
    await a.getByRole('button', { name: 'Inline code', exact: true }).click();
    await a.keyboard.press('Enter');
    await input(a, 'Concurrent formatting');
    await settle(a);
    await b.goto(`/documents/${id}`); await waitForEditor(b);
    await expect(b.locator('.tiptap ul ul')).toHaveCount(1, { timeout: 30000 });
    await expect(b.locator('.tiptap ol li')).toHaveCount(2);
    await expect(b.locator('.tiptap input[type=checkbox]')).toHaveCount(2);
    await expect(b.locator('.tiptap a[href="https://example.com/concord"]')).toHaveText('Concord docs');
    await expect(b.locator('.tiptap code')).toHaveText('npm test');
    await matches(); stages.push('two users: nested bullets, numbered lists, tasks, link and inline code');
    await a.screenshot({ path: path.join(output, 'nested.png'), fullPage: false });
    console.log('[rich-text] two-user rich text converged');

    await contextA.setOffline(true); await contextB.setOffline(true);
    await selectLine(a, 'Concurrent formatting'); await a.getByRole('button', { name: 'Bold', exact: true }).click();
    await selectLine(b, 'Concurrent formatting'); await b.getByRole('button', { name: 'Italic', exact: true }).click();
    await b.locator('.tiptap input[type=checkbox]').first().check();
    await a.locator('.tiptap p').filter({ hasText: /^Child$/ }).click();
    await list(a, 'Outdent list item');
    await expect(a.locator('.tiptap ul ul')).toHaveCount(0);
    await expect(a.locator('.tiptap strong')).toContainText('Concurrent formatting');
    await expect(b.locator('.tiptap em')).toContainText('Concurrent formatting');
    await a.screenshot({ path: path.join(output, 'offline.png'), fullPage: false });
    await contextA.setOffline(false); await contextB.setOffline(false);
    await settle(a); await settle(b);
    await expect(a.locator('.tiptap strong em, .tiptap em strong')).toHaveText('Concurrent formatting', { timeout: 45000 });
    await expect(b.locator('.tiptap input[type=checkbox]').first()).toBeChecked();
    await matches(); stages.push('offline indent, overlapping bold/italic, task toggle, reconnect convergence');
    console.log('[rich-text] offline edits and formatting converged');

    const checkpointHtml = await html(a);
    await a.getByRole('button', { name: 'Open review, history, and draft tools' }).click();
    await a.getByRole('textbox', { name: 'Checkpoint name' }).fill('Rich text checkpoint');
    await a.getByRole('button', { name: 'Save', exact: true }).click();
    await a.getByRole('button', { name: /Rich text checkpoint.*seq/ }).click();
    const preview = a.getByRole('tabpanel');
    await expect(preview.locator('ol li')).toHaveCount(2);
    await expect(preview.locator('input[type=checkbox]').first()).toBeChecked();
    await expect(preview.locator('a[href="https://example.com/concord"]')).toHaveText('Concord docs');
    await expect(preview.locator('code')).toHaveText('npm test');
    await a.screenshot({ path: path.join(output, 'history.png') });
    await end(a); await input(a, ' after checkpoint'); await settle(a);
    a.once('dialog', (dialog) => void dialog.accept());
    await a.getByRole('button', { name: 'Restore version' }).click();
    await expect(a.getByRole('status').filter({ hasText: 'Restore committed' })).toBeVisible({ timeout: 30000 });
    await expect.poll(() => html(a), { timeout: 30000 }).toBe(checkpointHtml);
    await a.getByRole('button', { name: 'Close review and history panel' }).last().click();
    await matches(); stages.push('native gateway checkpoint, rich preview and forward restore retain formatting');

    const converged = await html(a);
    await a.reload(); await b.reload(); await waitForEditor(a); await waitForEditor(b);
    await expect.poll(() => html(a), { timeout: 30000 }).toBe(converged);
    await expect.poll(() => html(b), { timeout: 30000 }).toBe(converged);
    stages.push('reload preserves identical content, formatting and task state');
    const clonedSession = await a.evaluate(() => Object.fromEntries(Object.entries(sessionStorage).filter(([key]) => key.startsWith('concord.tab-replica.'))));
    const c = await contextA.newPage();
    await c.addInitScript((data) => { for (const [key, value] of Object.entries(data)) sessionStorage.setItem(key, value); }, clonedSession);
    await c.goto(`/documents/${id}`); await waitForEditor(c);
    await expect.poll(() => html(c), { timeout: 30000 }).toBe(converged);
    const identities = await Promise.all([a, c].map((page) => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('concord.tab-replica.')).map(([, value]) => value))));
    assert.notDeepEqual(identities[0], identities[1]);
    await Promise.all([end(a), end(c)]);
    await Promise.all([input(a, ' Alice tab'), input(c, ' Second tab')]);
    await settle(a); await settle(c);
    await expect.poll(() => surface(b).textContent(), { timeout: 45000 }).toContain('Alice tab');
    await expect.poll(() => surface(b).textContent(), { timeout: 45000 }).toContain('Second tab');
    await expect.poll(async () => await html(c), { timeout: 30000 }).toBe(await html(a));
    await matches(); stages.push('same browser, cloned sessionStorage: distinct replicas and concurrent edits converge');
    await c.close();

    const old = await contextA.newPage();
    await old.route('**/crdt-worker.js', (route) => route.fulfill({ contentType: 'application/javascript', body: 'self.onmessage = ({data}) => self.postMessage({id:data.id,ok:true,result:{kind:"init",ready:true}});' }));
    await old.goto(`/documents/${id}`);
    await expect(old.getByText('Update required. Offline edits are preserved.', { exact: true })).toBeVisible();
    await expect(old.getByRole('button', { name: 'Reload Concord' })).toBeVisible();
    await expect(old.getByRole('status').filter({ hasText: 'Waiting for update' })).toBeVisible();
    await expect(old.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    await old.screenshot({ path: path.join(output, 'upgrade.png') });
    await old.close(); stages.push('stale worker shows explicit reload/upgrade path and disables editing');

    await a.evaluate(() => window.scrollTo(0, 0)); await b.evaluate(() => window.scrollTo(0, 0));
    await a.screenshot({ path: path.join(output, 'alice.png'), fullPage: false });
    await b.screenshot({ path: path.join(output, 'bob.png'), fullPage: false });
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: path.join(output, 'mobile.png'), fullPage: false });
    const ops = await db.query('SELECT COUNT(*)::int AS count FROM crdt_operations WHERE document_id = $1', [id]);
    assert.ok(ops.rows[0].count > 0);
    assert.deepEqual(monA.fatalErrors(), []); assert.deepEqual(monB.fatalErrors(), []);
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, stages, durableOperations: ops.rows[0].count, identicalRenderedContent: true, html: await html(b) }, null, 2));
    console.log(`[rich-text] PASS: ${stages.length} stages; ${ops.rows[0].count} operations persisted in PostgreSQL`);
} catch (error) {
    const states = [];
    for (const [index, page] of (browser?.contexts().flatMap((context) => context.pages()) ?? []).entries()) {
        await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {});
        states.push(await page.getByRole('status').evaluateAll((els) => els.map((el) => ({ text: el.textContent, title: el.getAttribute('title') }))).catch(() => []));
    }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, stages, error: String(error).slice(0, 3000), states, console: monitors.map((monitor) => monitor.fatalErrors()) }, null, 2));
    throw error;
} finally {
    await db?.end(); await browser?.close(); await cleanup();
}
