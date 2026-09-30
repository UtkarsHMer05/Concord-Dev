// Real export UI → source shutdown → standalone offline verification → fresh
// authenticated destination → atomic retained-history restore and safe retry.
// The existing harness owns only its disposable concord_e2e database/users.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import setup from '../browser-e2e-setup.mjs';
import { signIn, createDocument, waitForEditor, ConsoleMonitor } from '../../tests/browser/helpers.ts';

const output = path.resolve('output/playwright/concordpack');
await fs.mkdir(output, { recursive: true });
const archivePath = path.join(output, 'document.concordpack');
const trustPath = path.join(output, 'trusted-history.json');
const phase = process.argv.find((arg) => arg.startsWith('--phase='))?.split('=')[1];

if (!phase) {
  const startedAt = new Date().toISOString();
  const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const workingTreeChanges = !!execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  const runPhase = (name, env) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.argv[1], `--phase=${name}`, ...(process.argv.includes('--headed') ? ['--headed'] : [])], { env: { ...process.env, ...env, CONCORD_E2E_RUN_ID: `pack-${randomBytes(6).toString('hex')}-${name}` }, stdio: 'inherit' });
    const stop = () => child.kill('SIGINT'); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.once('exit', (code) => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); if (code === 0) resolve(); else reject(new Error(`${name} phase exited ${code}`)); });
  });
  await runPhase('source', { GATEWAY_SIGNING_KEY: randomBytes(32).toString('hex') });
  const source = JSON.parse(await fs.readFile(path.join(output, 'source.json'), 'utf8'));
  for (const url of [source.origin, source.gateway]) {
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }), 'the original web server and gateway must be stopped before verification');
  }
  const temp = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'concord-offline-'));
  try {
    for (const [from, to] of [['rust/target/release/concordpack-verify', 'concordpack-verify'], ['build/native/worker/concord-worker', 'concord-worker'], [archivePath, 'document.concordpack'], [trustPath, 'trusted-history.json']]) await fs.copyFile(path.resolve(from), path.join(temp, to));
    const verify = (bundle = 'document.concordpack', trust = 'trusted-history.json') => spawnSync(path.join(temp, 'concordpack-verify'), ['--bundle', bundle, '--trust', trust, '--worker', path.join(temp, 'concord-worker')], { cwd: temp, env: {}, encoding: 'utf8' });
    const good = verify(); assert.equal(good.status, 0, good.stderr);
    const report = JSON.parse(good.stdout); assert.equal(report.stateDigest, source.manifest.content.stateDigest);
    assert.deepEqual(report.revisions, source.manifest.content.revisions);
    const corrupt = new Uint8Array(await fs.readFile(archivePath)); corrupt[corrupt.length - 1] ^= 1;
    await fs.writeFile(path.join(temp, 'corrupt.concordpack'), corrupt); await fs.writeFile(path.join(output, 'corrupt.concordpack'), corrupt);
    assert.notEqual(verify('corrupt.concordpack').status, 0, 'corruption must fail offline');
    const trust = JSON.parse(await fs.readFile(trustPath, 'utf8'));
    await fs.writeFile(path.join(temp, 'wrong-key.json'), JSON.stringify({ ...trust, publicKey: '0'.repeat(64) }));
    assert.notEqual(verify('document.concordpack', 'wrong-key.json').status, 0, 'untrusted signer must fail offline');
    await fs.writeFile(path.join(output, 'offline.json'), JSON.stringify({ ...report, sourceServersStopped: true, serviceEnvironmentCleared: true, corruptionRejected: true, untrustedSignerRejected: true }, null, 2));
    console.log('[concordpack] standalone verification passed with source servers stopped and no service configuration');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
  const trust = JSON.parse(await fs.readFile(trustPath, 'utf8'));
  await runPhase('destination', { GATEWAY_SIGNING_KEY: randomBytes(32).toString('hex'), GATEWAY_TRUSTED_IMPORT_KEYS: trust.publicKey });
  const destination = JSON.parse(await fs.readFile(path.join(output, 'destination.json'), 'utf8'));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ result: 'passed', startedAt, finishedAt: new Date().toISOString(), baseRevision, workingTreeChanges,
    environment: { node: process.version, platform: process.platform, arch: process.arch, browser: 'Chromium', mode: process.env.CONCORD_E2E_MODE || 'dev' },
    archiveChecksum: createHash('sha256').update(await fs.readFile(archivePath)).digest('hex'), sourceDocumentId: source.manifest.content.documentId,
    destinationDocumentId: destination.documentId, stateDigest: source.manifest.content.stateDigest,
    stages: ['signed export from authenticated rich-text editor', 'source web/gateway shutdown and offline CLI verification',
      'corrupt archive and untrusted signer rejected', 'fresh destination restores retained identities and matching revisions',
      'lost response and reload retry produce one private document', 'continued editing, history restore, provenance, desktop/mobile and accessibility'],
    ...destination }, null, 2));
  console.log(`[concordpack] all 6 acceptance stages passed; evidence: ${output}`);
} else {
  process.env.CONCORD_E2E_PROFILE = 'full';
  const cleanup = await setup();
  let browser; let db; let page;
  const monitor = new ConsoleMonitor(); let expectedImportFailure = false;
  try {
    browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
    const origin = process.env.CONCORD_E2E_BASE_URL; const users = JSON.parse(process.env.CONCORD_E2E_USERS);
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1100 } });
    page = await context.newPage(); monitor.attach(page); await signIn(page, users.primary);
    assert.match(process.env.CONCORD_E2E_DB, /\/concord_e2e$/);
    db = new pg.Pool({ connectionString: process.env.CONCORD_E2E_DB });
    const surface = () => page.locator('.ProseMirror').first();
    const tools = async (tab = 'Concordpack') => {
      if (!await page.getByRole('tabpanel').isVisible()) await page.getByRole('button', { name: 'Open review, history, and draft tools' }).click();
      await page.getByRole('tab', { name: tab, exact: true }).click();
    };
    const close = async () => { await page.getByRole('button', { name: 'Close review and history panel' }).last().click(); };
    const settle = async () => {
      await expect.poll(() => page.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('concord-sync'); request.onerror = () => reject(request.error);
        request.onsuccess = () => { const d = request.result; if (!d.objectStoreNames.contains('outbox')) { d.close(); resolve(-1); return; }
          const get = d.transaction('outbox').objectStore('outbox').getAll(); get.onsuccess = () => { const pending = get.result.filter((r) => r.state !== 'durably_acked').length; d.close(); resolve(pending); }; get.onerror = () => reject(get.error); };
      })), { timeout: 45000 }).toBe(0);
    };
    const api = async (url, method = 'GET', body) => {
      await page.waitForFunction(() => !!window.Clerk?.session);
      const token = await page.evaluate(() => window.Clerk.session.getToken());
      const response = await fetch(`${origin}${url}`, { method, headers: { Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    const id = await createDocument(page, 'Portable RFC'); await waitForEditor(page);
    if (phase === 'source') {
      await page.getByRole('button', { name: 'Blank document', exact: true }).click();
      await page.getByRole('textbox', { name: 'Document title' }).fill('RFC: portable collaboration');
      await page.getByRole('textbox', { name: 'Document title' }).press('Enter');
      await surface().click();
      await page.keyboard.insertText('RFC: portable collaboration'); await page.keyboard.press('Enter');
      await page.keyboard.insertText('Keep document identities and retained history.'); await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Lists', exact: true }).click(); await page.getByRole('menuitem', { name: 'Task List', exact: true }).click();
      await page.keyboard.insertText('Verify the archive before restoring.'); await page.keyboard.press('Enter');
      await page.keyboard.insertText('Assign destination access deliberately.');
      await page.locator('.tiptap input[type=checkbox]').first().check(); await settle();
      await tools('History'); await page.getByRole('textbox', { name: 'Checkpoint name' }).fill('RFC baseline'); await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('button', { name: /RFC baseline.*seq/ })).toBeVisible({ timeout: 30000 });
      await close(); await surface().click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
      await page.keyboard.press('Enter'); await page.keyboard.insertText('Recover even after the original server stops.'); await settle();
      await tools('History'); await page.getByRole('textbox', { name: 'Checkpoint name' }).fill('RFC recovery plan'); await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('button', { name: /RFC recovery plan.*seq/ })).toBeVisible({ timeout: 30000 });
      await expect.poll(async () => (await db.query("SELECT count(*)::int AS n FROM crdt_snapshots WHERE document_id=$1 AND status='finalized'", [id])).rows[0].n,
        { timeout: 45000 }).toBeGreaterThanOrEqual(2);
      await tools();
      const [downloaded] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export signed history', exact: true }).click()]);
      await expect(page.getByRole('button', { name: 'Download verification details' })).toBeVisible({ timeout: 30000 });
      await downloaded.saveAs(archivePath);
      const [details] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download verification details' }).click()]); await details.saveAs(trustPath);
      const bytes = await fs.readFile(archivePath); const manifest = JSON.parse(bytes.subarray(9, 9 + bytes.readUInt32LE(5)).toString());
      const sourceOwner = (await db.query('SELECT owner_user_id FROM documents WHERE id=$1', [id])).rows[0].owner_user_id;
      await page.screenshot({ path: path.join(output, 'export.png'), fullPage: true });
      await fs.writeFile(path.join(output, 'source.json'), JSON.stringify({ origin, gateway: process.env.CONCORD_E2E_GATEWAY_WS.replace('ws:', 'http:').replace('/sync', '/health/live'), owner: sourceOwner, manifest }, null, 2));
      console.log('[concordpack] source exported real task-list content and two retained revisions');
    } else {
      const trustText = await fs.readFile(trustPath, 'utf8'); const trust = JSON.parse(trustText);
      const source = JSON.parse(await fs.readFile(path.join(output, 'source.json'), 'utf8'));
      const archive = await fs.readFile(archivePath);
      await tools();
      const choose = async (file = archivePath, details) => {
        await page.getByLabel('History archive', { exact: true }).setInputFiles(file);
        if (details) await page.getByLabel('Trusted verification details', { exact: true }).fill(details);
        else {
          await page.getByLabel('Load trusted details file, or paste below', { exact: true }).setInputFiles(trustPath);
          await expect(page.getByLabel('Trusted verification details', { exact: true })).toHaveValue(trustText);
        }
        await page.getByRole('button', { name: 'Verify signed archive', exact: true }).click();
      };
      await choose(archivePath, JSON.stringify({ ...trust, publicKey: '0'.repeat(64) }));
      await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('does not match', { timeout: 30000 });
      await expect(page.getByRole('button', { name: 'Restore as new document' })).toBeDisabled();
      await choose(path.join(output, 'corrupt.concordpack'));
      await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('checksum failed', { timeout: 30000 });
      await choose(); await expect(page.getByRole('heading', { name: 'Trusted archive verified' })).toBeVisible({ timeout: 30000 });
      await page.getByLabel('Restored document title').fill('Recovered portable RFC');
      await page.getByRole('heading', { name: 'Trusted archive verified' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, 'verified.png'), fullPage: true });
      // Drop the response after the server committed. Reload loses React state;
      // the persisted retry identity must still produce the same document.
      let committed; let firstRequest;
      await page.route('**/api/gateway/concordpack/import?*', async (route) => {
        firstRequest = new URL(route.request().url()).searchParams.get('requestId');
        const response = await route.fetch(); assert.equal(response.status(), 200); committed = await response.json();
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'response_lost_for_test' }) });
      }, { times: 1 }); expectedImportFailure = true;
      await page.getByRole('button', { name: 'Restore as new document' }).click(); await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText('response_lost_for_test', { timeout: 30000 });
      await page.reload(); await waitForEditor(page); await tools(); await choose();
      await expect(page.getByRole('heading', { name: 'Trusted archive verified' })).toBeVisible({ timeout: 30000 });
      await page.getByLabel('Restored document title').fill('Recovered portable RFC');
      const retriedRequest = page.waitForRequest('**/api/gateway/concordpack/import?*');
      await page.getByRole('button', { name: 'Restore as new document' }).click();
      assert.equal(new URL((await retriedRequest).url()).searchParams.get('requestId'), firstRequest);
      await expect(page.getByRole('link', { name: 'Open restored document' })).toBeVisible({ timeout: 30000 });
      const restoredId = committed.documentId;
      const record = (await db.query('SELECT owner_user_id,organization_id FROM documents WHERE id=$1', [restoredId])).rows[0];
      assert.notEqual(record.owner_user_id, source.owner); assert.equal(record.organization_id, null);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM concordpack_imports WHERE request_id=$1', [firstRequest])).rows[0].n, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM documents WHERE title=$1', ['Recovered portable RFC'])).rows[0].n, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM document_user_permissions WHERE document_id=$1', [restoredId])).rows[0].n, 0);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='document.import_history' AND resource_id=$1", [restoredId])).rows[0].n, 1);
      await page.getByRole('link', { name: 'Open restored document' }).click(); await waitForEditor(page);
      await expect(surface()).toContainText('Recover even after the original server stops.', { timeout: 30000 });
      await expect(page.locator('.tiptap input[type=checkbox]').first()).toBeChecked();
      await tools(); await page.getByRole('button', { name: 'View import provenance' }).click();
      await expect(page.getByText('Original signed manifest and identity mappings', { exact: true })).toBeVisible({ timeout: 30000 });
      const provenance = await api(`/api/gateway/documents/${restoredId}/concordpack/provenance`); assert.equal(provenance.status, 200);
      assert.deepEqual(provenance.body.manifest, source.manifest);
      const restoredSnapshots = (await db.query("SELECT state_digest FROM crdt_snapshots WHERE document_id=$1 AND status='finalized' ORDER BY coverage_seq,id", [restoredId])).rows;
      assert.deepEqual(restoredSnapshots.map((row) => row.state_digest), source.manifest.content.snapshots.map((snapshot) => snapshot.stateDigest));
      const actual = (await db.query('SELECT operation_id,payload FROM crdt_operations WHERE document_id=$1 ORDER BY id', [restoredId])).rows;
      let offset = 9 + archive.readUInt32LE(5) + source.manifest.content.snapshots.reduce((n, s) => n + s.bytes, 0);
      for (let i = 0; i < actual.length; i++) {
        const meta = source.manifest.content.operations[i]; assert.equal(actual[i].operation_id, meta.operationId);
        assert.deepEqual(actual[i].payload, archive.subarray(offset, offset + meta.bytes)); offset += meta.bytes;
      }
      await tools('History');
      for (const revision of source.manifest.content.revisions) {
        const mapped = provenance.body.revisionMap[revision.revisionId];
        const content = await api(`/api/gateway/documents/${restoredId}/revisions/${mapped}`); assert.equal(content.status, 200);
        assert.equal(content.body.stateDigest, revision.stateDigest);
        await page.getByRole('button', { name: new RegExp(`${revision.label}.*seq`) }).click();
        await expect(page.getByRole('tabpanel')).toContainText(revision.stateDigest, { timeout: 30000 });
      }
      await page.screenshot({ path: path.join(output, 'history.png'), fullPage: true });
      const stranger = await browser.newContext({ baseURL: origin }); const outsider = await stranger.newPage(); await signIn(outsider, users['isolation-stranger']);
      await outsider.waitForFunction(() => !!window.Clerk?.session);
      const strangerToken = await outsider.evaluate(() => window.Clerk.session.getToken());
      const denial = await fetch(`${origin}/api/gateway/documents/${restoredId}/concordpack/provenance`, { headers: { Authorization: `Bearer ${strangerToken}` } });
      assert.equal(denial.status, 404); await stranger.close();
      await close(); await surface().click(); await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
      await page.keyboard.press('Enter'); await page.keyboard.insertText('Fresh replica edits safely after history import.'); await settle();
      await page.reload(); await waitForEditor(page); await expect(surface()).toContainText('Fresh replica edits safely after history import.');
      await tools('History'); await page.getByRole('button', { name: /RFC baseline.*seq/ }).click();
      await expect(page.getByRole('button', { name: 'Restore version', exact: true })).toBeVisible();
      page.once('dialog', (dialog) => dialog.accept()); await page.getByRole('button', { name: 'Restore version', exact: true }).click();
      await expect(page.getByRole('tabpanel')).toContainText('Restore committed', { timeout: 30000 }); await close();
      await expect(surface()).not.toContainText('Fresh replica edits safely after history import.', { timeout: 30000 });
      await settle(); await page.reload(); await waitForEditor(page); await expect(surface()).not.toContainText('Fresh replica edits safely after history import.');
      await tools(); await page.getByRole('button', { name: 'View import provenance' }).click();
      await expect(page.getByText('Original signed manifest and identity mappings', { exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(output, 'provenance.png'), fullPage: true });
      const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      assert.deepEqual(a11y.violations, [], 'archive UI accessibility');
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'mobile page must not overflow horizontally');
      await fs.writeFile(path.join(output, 'destination.json'), JSON.stringify({ documentId: restoredId, revisionsMatched: source.manifest.content.revisions.length,
        retainedOperationBytesMatched: actual.length, privateOwnership: true, provenancePreserved: true, lostResponseRetryIdempotent: true,
        retainedSnapshotsMatched: restoredSnapshots.length,
        continuedEditingAndHistoryRestore: true, unauthorizedProvenanceReadRejected: true, accessibilityViolations: a11y.violations.length, mobileOverflow: false }, null, 2));
      console.log('[concordpack] fresh restoration, two matching revisions, safe response-loss retry and post-import editing passed');
    }
    const errors = monitor.fatalErrors().filter((message) => !(expectedImportFailure && /^Failed to load resource:.*503/.test(message)));
    assert.deepEqual(errors, [], 'no unexpected browser errors');
  } catch (error) {
    if (page) console.error(`[concordpack] ${phase} alert: ${await page.getByRole('alert').allTextContents().catch(() => [])}`);
    if (page) await page.screenshot({ path: path.join(output, `${phase}-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally { if (browser) await browser.close(); if (db) await db.end(); await cleanup(); }
}
