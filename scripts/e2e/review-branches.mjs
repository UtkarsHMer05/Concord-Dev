// Real auth, editor, offline outbox, gateway and PostgreSQL; disposable E2E DB only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import setup from '../browser-e2e-setup.mjs';
import { signIn, createDocument, waitForEditor, ConsoleMonitor } from '../../tests/browser/helpers.ts';

process.env.CONCORD_E2E_PROFILE = 'full';
const output = path.resolve('output/playwright/review-branches');
await fs.mkdir(output, { recursive: true });
const cleanup = await setup();
const stages = [];
const monitors = [];
let browser; let db;
try {
    browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
    const users = JSON.parse(process.env.CONCORD_E2E_USERS);
    const origin = process.env.CONCORD_E2E_BASE_URL;
    const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } })));
    let alice = await contexts[0].newPage();
    const bob = await contexts[1].newPage(); const reviewer = await contexts[2].newPage();
    for (const page of [alice, bob, reviewer]) { const monitor = new ConsoleMonitor(); monitor.attach(page); monitors.push(monitor); }
    await signIn(alice, users['collab-a']); await signIn(bob, users.primary); await signIn(reviewer, users['isolation-stranger']);
    assert.match(process.env.CONCORD_E2E_DB, /\/concord_e2e$/);
    db = new pg.Pool({ connectionString: process.env.CONCORD_E2E_DB });
    const surface = (page) => page.locator('.ProseMirror').first();
    const panel = (page) => page.getByRole('tabpanel');
    const close = async (page) => { const button = page.getByRole('button', { name: 'Close review and history panel' }).last(); if (await button.isVisible()) await button.click(); };
    const tools = async (page, tab) => {
        if (!await page.getByRole('tabpanel').isVisible()) await page.getByRole('button', { name: 'Open review, history, and draft tools' }).click();
        await page.getByRole('tab', { name: tab, exact: true }).click();
    };
    const settle = async (page) => {
        await expect.poll(() => page.evaluate(() => new Promise((resolve, reject) => {
            const request = indexedDB.open('concord-sync'); request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const d = request.result;
                if (!d.objectStoreNames.contains('outbox')) { d.close(); resolve(-1); return; }
                const get = d.transaction('outbox').objectStore('outbox').getAll();
                get.onsuccess = () => { const pending = get.result.filter((r) => r.state !== 'durably_acked').length; d.close(); resolve(pending); };
                get.onerror = () => reject(get.error);
            };
        })), { timeout: 45000 }).toBe(0);
    };
    const selectLine = async (page, text) => {
        await close(page);
        const paragraph = surface(page).locator('p').filter({ hasText: new RegExp(`^${text}$`) });
        if (await surface(page).getAttribute('contenteditable') === 'false') {
            await paragraph.selectText();
            return;
        }
        await paragraph.click();
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
        for (let i = 0; i < [...text].length; i++) await page.keyboard.press('Shift+ArrowLeft');
    };
    const replace = async (page, before, after) => { await selectLine(page, before); await page.keyboard.insertText(after); await expect(surface(page)).toContainText(after); };
    const identity = async (page) => { await tools(page, 'Share'); return page.getByRole('textbox', { name: 'Your collaboration ID' }).inputValue(); };
    const grant = async (page, id, role) => {
        await tools(page, 'Share');
        await page.getByRole('textbox', { name: 'Collaborator ID', exact: true }).fill(id);
        await page.getByLabel('Access', { exact: true }).selectOption(role);
        await page.getByRole('button', { name: 'Grant access' }).click();
        await expect(page.getByRole('textbox', { name: 'Collaborator ID', exact: true })).toHaveValue('');
        await expect(panel(page).getByText(id, { exact: true })).toBeVisible();
    };
    await createDocument(alice, 'Author identity'); await waitForEditor(alice); const aliceId = await identity(alice);
    await createDocument(reviewer, 'Reviewer identity'); await waitForEditor(reviewer); const reviewerId = await identity(reviewer);
    const main = await createDocument(bob, 'RFC: durable storage review'); await waitForEditor(bob);
    await bob.getByRole('button', { name: 'Blank document', exact: true }).click();
    await bob.getByRole('textbox', { name: 'Document title' }).fill('RFC: durable storage review');
    await bob.getByRole('textbox', { name: 'Document title' }).press('Enter');
    await expect(bob.getByRole('button', { name: 'RFC: durable storage review', exact: true })).toBeVisible();
    const lines = [
        'Purpose: durable document storage',
        'Constraints: preserve text identities and comments',
        'Budget: three replicas',
        'Compatibility: existing clients remain supported',
        'Storage: use a single durable log',
        'Validation: reconnect must retain pending edits',
        'Rollout: deploy the gateway manually',
        'Observability: record durable acknowledgements',
    ];
    await surface(bob).click();
    for (const line of lines) { await bob.keyboard.insertText(line); await bob.keyboard.press('Enter'); }
    await bob.getByRole('button', { name: 'Lists', exact: true }).click(); await bob.getByRole('menuitem', { name: 'Task List', exact: true }).click();
    await expect(surface(bob)).toBeFocused();
    await expect(bob.locator('.tiptap input[type=checkbox]')).toHaveCount(1);
    await bob.keyboard.insertText('Release checklist'); await bob.keyboard.press('Enter'); await bob.keyboard.insertText('Verify recovery');
    await bob.getByRole('button', { name: 'Lists', exact: true }).click(); await bob.getByRole('menuitem', { name: 'Indent list item', exact: true }).click();
    await expect(surface(bob)).toBeFocused();
    await bob.locator('.tiptap input[type=checkbox]').first().check();
    await settle(bob);
    await grant(bob, aliceId, 'EDITOR');
    await alice.goto(`/documents/${main}`); await waitForEditor(alice);
    await expect(surface(alice)).toContainText(lines[7], { timeout: 30000 });
    await tools(alice, 'History'); await alice.getByRole('textbox', { name: 'Checkpoint name' }).fill('RFC baseline');
    await alice.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(alice.getByRole('button', { name: /RFC baseline.*seq/ })).toBeVisible({ timeout: 30000 });
    await tools(alice, 'Branches'); await alice.getByRole('textbox', { name: 'Branch name' }).fill('Storage proposal');
    await alice.getByLabel('Base saved version').selectOption({ label: 'RFC baseline' });
    await alice.getByRole('button', { name: 'Create review branch', exact: true }).click();
    await expect(alice.getByRole('link', { name: 'Open branch', exact: true })).toBeVisible({ timeout: 30000 });
    const branch = (await alice.getByRole('link', { name: 'Open branch', exact: true }).getAttribute('href')).split('/').at(-1);
    await alice.getByRole('link', { name: 'Open branch', exact: true }).click(); await waitForEditor(alice);
    await expect(alice.getByLabel('Review branch information')).toContainText('Storage proposal');
    await expect(alice.locator('.tiptap ul ul')).toHaveCount(1);
    await expect(alice.locator('.tiptap input[type=checkbox]').first()).toBeChecked();
    stages.push('named revision creates a separate rich CRDT branch with independent sharing');
    console.log('[review-branches] branch created from named baseline');

    await grant(alice, reviewerId, 'COMMENTER'); await close(alice);
    await contexts[0].setOffline(true);
    await replace(alice, lines[0], 'Purpose: author proposes storage redesign');
    await replace(alice, lines[4], 'Storage: partition the durable log');
    await replace(alice, lines[6], 'Rollout: automate the gateway deployment');
    await replace(bob, lines[0], 'Purpose: main prioritizes recovery');
    await replace(bob, lines[2], 'Budget: five replicas'); await settle(bob);
    await expect(surface(bob)).toContainText(lines[4]);
    await expect(surface(alice)).toContainText(lines[2]);
    await contexts[0].setOffline(false); await settle(alice);
    await alice.reload(); await waitForEditor(alice);
    await expect(surface(alice)).toContainText('Storage: partition the durable log');
    await expect(surface(bob)).toContainText('Budget: five replicas');
    stages.push('author edits offline; main edits concurrently; reconnect and reload keep both documents independent');
    console.log('[review-branches] offline proposal and independent main edits durable');

    await reviewer.goto(`/documents/${branch}`);
    await expect(surface(reviewer)).toBeVisible(); await expect(surface(reviewer)).toHaveAttribute('contenteditable', 'false');
    // A commenter can anchor feedback, but cannot read main through a branch invitation.
    await tools(reviewer, 'Branches'); await reviewer.getByRole('button', { name: 'Compare with main' }).click();
    await expect(panel(reviewer).getByRole('alert')).toContainText('do not have access');
    await grant(bob, reviewerId, 'VIEWER');
    await selectLine(reviewer, 'Storage: partition the durable log'); await tools(reviewer, 'Comments');
    await reviewer.getByRole('textbox', { name: 'New thread' }).fill('Reviewed: preserve recovery when partitioning the log.');
    await reviewer.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(panel(reviewer).getByText('Reviewed: preserve recovery when partitioning the log.', { exact: true })).toBeVisible();
    await tools(reviewer, 'Branches'); await reviewer.getByRole('button', { name: 'Compare with main' }).click();
    await expect(panel(reviewer)).toContainText('A main document editor must merge the changes');
    await expect(panel(reviewer).getByRole('button', { name: /Merge selected changes/ })).toHaveCount(0);
    stages.push('explicit branch commenter invitation, anchored review feedback, separate main ACL, no reviewer merge/edit access');

    await selectLine(bob, lines[1]); await tools(bob, 'Comments');
    await bob.getByRole('textbox', { name: 'New thread' }).fill('Keep these identities through the merge.');
    await bob.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(panel(bob).getByText('Keep these identities through the merge.', { exact: true })).toBeVisible();
    await tools(bob, 'Branches'); await bob.getByRole('button', { name: 'Compare and merge', exact: true }).click();
    await expect(panel(bob).getByRole('article')).toHaveCount(3);
    await expect(panel(bob)).toContainText('Conflict: both versions changed');
    const storage = panel(bob).getByRole('article').filter({ hasText: 'Storage: partition the durable log' });
    await storage.getByRole('checkbox').check();
    await bob.screenshot({ path: path.join(output, 'comparison.png') });
    let committed;
    const afterCommit = new Promise((resolve, reject) => {
        void bob.route(`**/branches/${branch}/merge`, async (route) => {
            try {
                const response = await route.fetch(); const body = await response.json();
                assert.equal(response.status(), 200); assert.equal(body.duplicate, false); committed = body;
                await route.abort(); resolve(body);
            } catch (error) { reject(error); await route.abort().catch(() => {}); }
        });
    });
    await bob.getByRole('button', { name: 'Merge selected changes (1)', exact: true }).click();
    await afterCommit;
    // Close after SQL commit but before a successful HTTP response reaches the UI.
    const saved = await bob.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('concord.review-merge.v1.')).length);
    assert.equal(saved, 1);
    await bob.close();
    const recovered = await contexts[1].newPage();
    const recoveredMonitor = new ConsoleMonitor(); recoveredMonitor.attach(recovered); monitors.push(recoveredMonitor);
    await recovered.goto(`/documents/${main}`); await waitForEditor(recovered);
    await expect(surface(recovered)).toContainText('Storage: partition the durable log', { timeout: 45000 });
    await expect(surface(recovered)).toContainText('Purpose: main prioritizes recovery');
    await expect(surface(recovered)).toContainText('Budget: five replicas');
    await expect(surface(recovered)).toContainText(lines[6]);
    await tools(recovered, 'Branches'); await recovered.getByRole('button', { name: 'Compare and merge', exact: true }).click();
    await expect(recovered.getByRole('button', { name: 'Retry saved merge' })).toBeVisible();
    await recovered.getByRole('button', { name: 'Retry saved merge' }).click();
    await expect(panel(recovered).getByRole('status').filter({ hasText: 'Merge recovered' })).toBeVisible({ timeout: 30000 });
    const records = await db.query('SELECT * FROM review_merges WHERE main_document_id=$1', [main]);
    assert.equal(records.rowCount, 1); assert.equal(records.rows[0].id, committed.merge.mergeId);
    assert.equal(records.rows[0].source_revision_id, committed.merge.sourceRevisionId);
    assert.equal(records.rows[0].result_revision_id, committed.merge.resultRevisionId);
    const heads = await db.query('SELECT MAX(id)::text AS seq FROM crdt_operations WHERE document_id=$1', [main]);
    assert.equal(heads.rows[0].seq, committed.merge.resultSeq);
    assert.equal(await recovered.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('concord.review-merge.v1.')).length), 0);
    stages.push('selective merge preserves main conflict, unrelated main edits and omitted branch change; lost-response recovery commits once');
    console.log('[review-branches] selective merge and interrupted-response recovery passed');

    await tools(recovered, 'Comments');
    await expect(panel(recovered).getByRole('button', { name: 'Open passage' })).toBeEnabled();
    await tools(alice, 'Comments');
    await expect(panel(alice).getByText('Reviewed: preserve recovery when partitioning the log.', { exact: true })).toBeVisible();
    await tools(recovered, 'History');
    await expect(recovered.getByRole('button', { name: /Merge: Storage proposal.*seq/ })).toBeVisible();
    await tools(alice, 'History');
    await expect(alice.getByRole('button', { name: /Review source: Storage proposal.*seq/ })).toBeVisible();
    await expect(recovered.locator('.tiptap input[type=checkbox]').first()).toBeChecked();
    await expect(recovered.locator('.tiptap ul ul')).toHaveCount(1);
    stages.push('merge source/result appear in history; branch comments and untouched main anchors and nested task state survive');

    // Choose the conflicting proposal explicitly in a second, separate merge.
    await tools(recovered, 'Branches'); await recovered.getByRole('button', { name: 'Compare and merge', exact: true }).click();
    const conflict = panel(recovered).getByRole('article').filter({ hasText: 'Conflict: both versions changed' });
    await conflict.getByRole('combobox').selectOption('branch');
    // A service failure from the bottom of a long review must be visible,
    // and the persisted request must still be available for recovery.
    const mergeUrl = `**/branches/${branch}/merge`;
    await recovered.route(mergeUrl, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"gateway_unavailable"}' }));
    await recovered.getByRole('button', { name: 'Merge selected changes (1)', exact: true }).click();
    await expect(panel(recovered).getByRole('alert')).toContainText('retry your saved request');
    await expect(panel(recovered).getByRole('alert')).toBeInViewport();
    await recovered.screenshot({ path: path.join(output, 'recovery.png') });
    await recovered.setViewportSize({ width: 390, height: 844 });
    await expect(panel(recovered).getByRole('alert')).toBeInViewport();
    await recovered.screenshot({ path: path.join(output, 'recovery-mobile.png') });
    await recovered.setViewportSize({ width: 1440, height: 1000 });
    await recovered.unroute(mergeUrl);
    await recovered.getByRole('button', { name: 'Retry saved merge', exact: true }).click();
    await expect(panel(recovered).getByRole('status').filter({ hasText: 'Merge committed' })).toBeVisible({ timeout: 30000 });
    await expect(surface(recovered)).toContainText('Purpose: author proposes storage redesign');
    await expect(surface(recovered)).toContainText('Budget: five replicas');
    await expect(surface(recovered)).toContainText(lines[6]);
    await recovered.screenshot({ path: path.join(output, 'merged.png') });
    const serious = (await new AxeBuilder({ page: recovered }).include('#document-tools-panel').analyze()).violations.filter((v) => ['critical', 'serious'].includes(v.impact));
    assert.deepEqual(serious.map((v) => v.id), []);
    await recovered.setViewportSize({ width: 390, height: 844 });
    await recovered.screenshot({ path: path.join(output, 'mobile.png') });
    assert.equal(await recovered.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    stages.push('explicit Use branch conflict resolution preserves unrelated edits; visible service failure and saved retry, responsive panel and accessibility check pass');

    // This test deliberately provokes one denied comparison and one failed HTTP response.
    // Gate uncaught runtime errors, while retaining all console errors in private diagnostics.
    for (const monitor of monitors) assert.deepEqual(monitor.all().filter((e) => e.startsWith('pageerror:')), []);
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: true, date: new Date().toISOString().slice(0, 10), webMode: process.env.CONCORD_E2E_MODE ?? 'dev', browser: 'Chromium', stages, mergeRecords: (await db.query('SELECT COUNT(*)::int AS count FROM review_merges WHERE main_document_id=$1', [main])).rows[0].count, recoveryProducedNoExtraOps: true, criticalOrSeriousPanelAccessibilityViolations: serious.length }, null, 2));
    console.log(`[review-branches] PASS: ${stages.length} acceptance stages`);
    if (process.argv.includes('--inspect')) {
        await recovered.setViewportSize({ width: 1440, height: 1000 });
        await contexts[1].storageState({ path: path.join(output, 'browser-state.json') });
        await fs.writeFile(path.join(output, 'inspect.json'), JSON.stringify({ origin, main, branch }));
        console.log('[review-branches] inspection ready; create output/playwright/review-branches/finish-inspection to clean up');
        while (!await fs.stat(path.join(output, 'finish-inspection')).catch(() => null)) await new Promise((resolve) => setTimeout(resolve, 1000));
        await fs.unlink(path.join(output, 'finish-inspection'));
    }
} catch (error) {
    for (const [i, page] of (browser?.contexts().flatMap((context) => context.pages()) ?? []).entries()) {
        await page.screenshot({ path: path.join(output, `failure-${i}.png`) }).catch(() => {});
    }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ passed: false, stages, error: String(error).slice(0, 3000), console: monitors.map((m) => m.all()) }, null, 2));
    throw error;
} finally {
    await db?.end(); await browser?.close(); await cleanup();
    await fs.unlink(path.join(output, 'browser-state.json')).catch(() => {});
    await fs.unlink(path.join(output, 'inspect.json')).catch(() => {});
}
