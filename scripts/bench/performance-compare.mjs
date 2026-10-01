#!/usr/bin/env node
// One campaign: controlled editor comparison, then actual Concord production browser.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import pg from 'pg';
import AxeBuilder from '@axe-core/playwright';
import setup from '../browser-e2e-setup.mjs';
import { cells, workload, expectedDocument } from './editor-workloads.mjs';
import { writeReport, validateCampaign } from './comparison-report.mjs';
import { liveProfile } from './live-profile.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const pairedOnly = argv.includes('--paired-only');
const value = (flag, fallback) => { const index = argv.indexOf(flag); if (index < 0) return fallback; if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error(`${flag} needs a value`); return argv[index + 1]; };
const runs = Number(value('--runs', quick ? 1 : 3));
const offlineSeconds = Number(value('--offline-seconds', quick ? 1 : 60));
if (!Number.isInteger(runs) || runs < 1 || runs > 20 || !Number.isFinite(offlineSeconds) || offlineSeconds < 0 || offlineSeconds > 600) throw new Error('Use 1–20 runs and 0–600 offline seconds');
for (let i = 0; i < argv.length; i++) { if (['--runs', '--offline-seconds', '--output'].includes(argv[i])) i++; else if (!['--quick', '--paired-only', '--headed'].includes(argv[i])) throw new Error(`Unknown flag: ${argv[i]}`); }
const runId = `comparison-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
const output = path.resolve(value('--output', `output/playwright/performance/${runId}`));
await fs.mkdir(output, { recursive: false }).catch(async error => { if (error.code !== 'ENOENT') throw error; await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(output); });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (command, args) => execFileSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [path.join(root, 'node_modules/tsx/node_modules')] }));
const schema = `bench_${randomBytes(8).toString('hex')}`;
let cleanup, db, server, browser;
const campaign = { schema: 'concord.bench.editor-comparison/1', runId, startedAt: new Date().toISOString(), result: 'incomplete',
  profile: quick ? 'quick' : 'full', measuredRuns: runs, warmupRuns: 1, offlineSeconds, rows: [], live: [], coverage: { paired: false, production: false },
  method: { sharedSubset: 'one paragraph, ASCII text, bold and italic', transport: 'same loopback HTTP append/catch-up; 50ms polling; one transaction per user edit; commit before ACK',
    durability: 'IndexedDB local log and retry outbox; PostgreSQL synchronous_commit=on; retained update log; no compaction in paired comparison',
    render: 'append: actual keyboard beforeinput to second requestAnimationFrame; other edits: PM command dispatch to second rAF; presentation opportunity, not physical paint',
    memory: 'post-GC page + dedicated worker V8 used heap and backing storage; excludes browser native/DOM/GPU allocations',
    order: 'engine order alternates between cells and rounds; one unreported warmup round; fresh browser contexts per cell',
    caveat: 'Paired results compare production Concord bridge/WASM with official Yjs binding in a common harness. Actual Concord gateway measurements are separate.' } };

function decodeBatch(bytes) {
  if (bytes.length < 4) throw new Error('Truncated batch'); const count = bytes.readUInt32LE(0); let offset = 4;
  if (count > 1000000) throw new Error('Too many updates');
  for (let i = 0; i < count; i++) { if (offset + 4 > bytes.length) throw new Error('Truncated size'); const size = bytes.readUInt32LE(offset); offset += 4; if (size < 1 || offset + size > bytes.length) throw new Error('Truncated update'); offset += size; }
  if (!count || offset !== bytes.length) throw new Error('Invalid batch');
}
async function makeServer() {
  const bundle = await build({ entryPoints: [path.join(root, 'scripts/bench/editor-client.mjs')], bundle: true, minify: true, format: 'esm', target: 'es2022', write: false });
  const staticFiles = new Map([
    ['/client.js', ['text/javascript', bundle.outputFiles[0].contents]],
    ['/crdt-worker.js', ['text/javascript', await fs.readFile(path.join(root, 'public/crdt-worker.js'))]],
    ['/wasm/concord-crdt.js', ['text/javascript', await fs.readFile(path.join(root, 'public/wasm/concord-crdt.js'))]],
    ['/wasm/concord-crdt.wasm', ['application/wasm', await fs.readFile(path.join(root, 'public/wasm/concord-crdt.wasm'))]],
  ]);
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Concord editor benchmark</title><style>body{font:16px system-ui;margin:32px;max-width:1000px;background:#f7f8fa;color:#17202a}h1{font-size:24px}.ProseMirror{background:white;padding:24px;border:1px solid #8b949e;min-height:320px;overflow-wrap:anywhere}.ProseMirror:focus{outline:2px solid #185abc}#status{margin:20px 0}</style><h1>Editor benchmark</h1><p id="status" role="status">Starting local replica…</p><div id="editor" aria-label="Benchmark editor"></div><script type="module" src="/client.js"></script></html>`;
  server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      response.setHeader('Cache-Control', 'no-store');
      if (request.method === 'GET' && url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
      if (request.method === 'GET' && staticFiles.has(url.pathname)) { const [type, bytes] = staticFiles.get(url.pathname); response.setHeader('Content-Type', type); response.end(bytes); return; }
      if (request.method === 'GET' && ['report.html', 'raw.json', 'charts.svg', 'summary.csv'].includes(url.pathname.slice(1))) {
        response.setHeader('Content-Type', url.pathname.endsWith('.html') ? 'text/html' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'application/json');
        response.end(await fs.readFile(path.join(output, url.pathname.slice(1)))); return;
      }
      const match = /^\/updates\/(concord|yjs)\/([a-z0-9-]{1,100})(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
      if (!match) { response.writeHead(404).end(); return; }
      const [, engine, documentId, batch] = match;
      if (request.method === 'GET' && !batch) {
        const after = url.searchParams.get('after') || '0'; if (!/^\d{1,15}$/.test(after)) throw new Error('Invalid cursor');
        const result = await db.query(`SELECT seq::float8 AS seq,encode(payload,'base64') AS payload FROM ${schema}.updates WHERE engine=$1 AND document_id=$2 AND seq>$3 ORDER BY seq`, [engine, documentId, after]);
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result.rows)); return;
      }
      if (request.method !== 'POST' || !batch || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(batch)) throw new Error('Invalid append');
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 4 * 1024 * 1024) { response.writeHead(413).end(); return; } chunks.push(chunk); }
      const payload = Buffer.concat(chunks); decodeBatch(payload);
      const connection = await db.connect();
      try {
        await connection.query('BEGIN'); await connection.query('SET LOCAL synchronous_commit=on');
        // Sequence assignment and commit order must agree within one document.
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${engine}:${documentId}`]);
        const inserted = await connection.query(`INSERT INTO ${schema}.updates(engine,document_id,batch,payload) VALUES($1,$2,$3,$4) ON CONFLICT(batch) DO NOTHING RETURNING seq`, [engine, documentId, batch, payload]);
        if (!inserted.rowCount) { const existing = (await connection.query(`SELECT engine,document_id,payload FROM ${schema}.updates WHERE batch=$1`, [batch])).rows[0]; if (existing.engine !== engine || existing.document_id !== documentId || !existing.payload.equals(payload)) throw new Error('Retry conflicts with original batch'); }
        await connection.query('COMMIT'); response.end('committed');
      } catch (error) { await connection.query('ROLLBACK'); throw error; } finally { connection.release(); }
    } catch (error) { response.writeHead(400, { 'Content-Type': 'text/plain' }).end(String(error.message)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

// CDP measures dedicated workers too: page-only JS heap would omit Concord's engine.
async function memory(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    const pageHeap = await cdp.send('Runtime.getHeapUsage');
    const info = (await cdp.send('Target.getTargetInfo')).targetInfo;
    const workers = (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'worker' && target.browserContextId === info.browserContextId);
    const heaps = [pageHeap];
    for (const worker of workers) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: worker.targetId, flatten: false });
      const command = (method, id) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(new Error(`Worker memory timeout: ${method}`)); }, 5000);
        const listener = event => { const message = JSON.parse(event.message); if (event.sessionId === sessionId && message.id === id) { clearTimeout(timeout); cdp.off('Target.receivedMessageFromTarget', listener); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result); } };
        cdp.on('Target.receivedMessageFromTarget', listener);
        cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) }).catch(reject);
      });
      try { await command('HeapProfiler.collectGarbage', 1); heaps.push(await command('Runtime.getHeapUsage', 2)); }
      finally { await cdp.send('Target.detachFromTarget', { sessionId }); }
    }
    if (heaps.some(heap => !Number.isFinite(heap.usedSize) || !Number.isFinite(heap.backingStorageSize))) throw new Error('Chromium did not supply complete page/worker heap measurements');
    return { v8UsedBytes: heaps.reduce((n, heap) => n + heap.usedSize, 0), backingStorageBytes: heaps.reduce((n, heap) => n + heap.backingStorageSize, 0),
      browserHeapBytes: heaps.reduce((n, heap) => n + heap.usedSize + heap.backingStorageSize, 0), dedicatedWorkers: workers.length };
  } finally { await cdp.detach(); }
}
async function pairedCell(origin, engine, cell, round) {
  const plan = workload(cell, quick); const token = randomUUID().replaceAll('-', ''); const clients = []; const samples = [];
  const documentIds = Array.from({ length: plan.documents }, (_, i) => `cell-${token}-${i}`);
  const expected = expectedDocument(plan);
  let offlineStarted, observedOfflineMs = null, reconnectMs = null;
  const load = async client => { await client.page.goto(client.url); await client.page.waitForFunction(() => window.benchReady === true, { timeout: 60000 }); };
  const settle = async () => { for (let pass = 0; pass < 2; pass++) await Promise.all(clients.map(client => client.page.evaluate(() => window.bench.settle()))); };
  try {
    for (let i = 0; i < plan.clients; i++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(String(error)));
      const documentId = documentIds[cell === 'independent' ? i : 0];
      const query = new URLSearchParams({ engine, doc: documentId, peer: String(i), seed: i === 0 || cell === 'independent' ? plan.initialText : '' });
      const client = { page, context, documentId, errors, url: `${origin}/?${query}` }; clients.push(client); await load(client);
    }
    await settle(); const before = await Promise.all(clients.map(client => memory(client.page)));
    if (cell === 'offline') { await clients[0].page.evaluate(() => window.bench.setOnline(false)); await clients[0].context.setOffline(true); offlineStarted = Date.now(); }
    await Promise.all(plan.edits.map(async (edits, writer) => {
      for (let index = 0; index < edits.length; index++) {
        let measured;
        if (cell === 'append') { await clients[writer].page.evaluate(() => window.bench.armTyping()); await clients[writer].page.keyboard.press('x'); measured = await clients[writer].page.evaluate(() => window.bench.finishTyping()); }
        else measured = await clients[writer].page.evaluate(edit => window.bench.edit(edit), edits[index]);
        samples.push({ writer, index, edit: edits[index], inputMethod: cell === 'append' ? 'keyboard-beforeinput' : 'PM-command', ...measured });
      }
    }));
    if (cell === 'offline') {
      // An online peer changes the document while the writer accumulates an IDB outbox.
      const peerEdit = { kind: 'insert', at: 'end', text: '[peer changed while writer was offline]' };
      await clients[1].page.evaluate(edit => window.bench.edit(edit), peerEdit);
      const remaining = Math.max(0, offlineSeconds * 1000 - (Date.now() - offlineStarted));
      console.log(`[compare] ${engine} offline backlog persisted; remaining disconnection ${(remaining / 1000).toFixed(1)}s`);
      await new Promise(resolve => setTimeout(resolve, remaining));
      observedOfflineMs = Date.now() - offlineStarted; await clients[0].context.setOffline(false);
      const start = performance.now(); await clients[0].page.evaluate(() => window.bench.setOnline(true)); await settle(); reconnectMs = performance.now() - start;
    } else await settle();
    const states = await Promise.all(clients.map(client => client.page.evaluate(() => window.bench.state())));
    for (const state of states) assert.deepEqual(state.errors, []);
    if (cell !== 'independent') for (const state of states) assert.deepEqual(state.canonical, states[0].canonical, 'Peer rich-text states must converge');
    if (cell === 'contested') {
      for (const edit of plan.edits.flat()) assert.equal(states[0].text.split(edit.text).length - 1, 1, `Contested edit lost/duplicated: ${edit.text}`);
      assert.equal(states[0].text.length, plan.initialText.length + plan.edits.flat().reduce((n, edit) => n + edit.text.length, 0));
    } else if (cell === 'offline') {
      const text = states[0].canonical[0].map(char => char.text).join('');
      const marker = '[peer changed while writer was offline]';
      assert.equal(text.split(marker).length - 1, 1); assert.equal(text.replace(marker, ''), expected[0][0].map(char => char.text).join(''), 'Offline user text must survive in order');
      assert.ok(states[0].canonical[0].every(char => char.marks.length === 0));
    } else if (cell === 'independent') states.forEach((state, i) => assert.deepEqual(state.canonical, expected[i], 'Independent user edits must match the reference'));
    else assert.deepEqual(states[0].canonical, expected[0], 'Text and formatting must match the user-level reference');
    const reloadStart = performance.now();
    // Skip the initial seed on reload. The local log, followed by catch-up, must be sufficient.
    const reloadUrl = new URL(clients[0].url); reloadUrl.searchParams.set('seed', ''); clients[0].url = reloadUrl.href;
    await load(clients[0]); await settle(); const reloadRecoveryMs = performance.now() - reloadStart;
    assert.deepEqual((await clients[0].page.evaluate(() => window.bench.state())).canonical, states[0].canonical, 'Reload must preserve the exact state');
    const resources = await Promise.all(clients.map(async client => ({ ...await client.page.evaluate(() => window.bench.resources()), ...await memory(client.page) })));
    for (const client of clients) assert.deepEqual(client.errors, [], 'No uncaught browser exceptions');
    assert.ok(resources.every(resource => resource.pendingBatches === 0), 'Every local batch must be durably acknowledged');
    const stored = (await db.query(`SELECT sum(octet_length(payload))::float8 AS bytes,count(*)::int AS batches FROM ${schema}.updates WHERE engine=$1 AND document_id=ANY($2::text[])`, [engine, documentIds])).rows[0];
    const canonicalChecksum = sha(JSON.stringify(states.map(state => state.canonical)));
    return { engine, cell, round, warmup: round === 0, workload: plan, workloadChecksum: sha(JSON.stringify(plan)), correctness: true, canonicalChecksum,
      samples, reconnectMs, reloadRecoveryMs, resources, initialMemory: before,
      durablePayloadBytes: stored.bytes, committedBatches: stored.batches, observedOfflineMs };
  } finally { await Promise.all(clients.map(client => client.context.close())); }
}

try {
  run(process.execPath, ['scripts/worker-bundle.mjs']);
  if (!pairedOnly) {
    process.env.CONCORD_E2E_MODE = 'production'; process.env.CONCORD_E2E_PROFILE = 'full'; process.env.CONCORD_E2E_RUN_ID = `perf-${randomBytes(5).toString('hex')}`;
    run('cmake', ['-S', 'cpp', '-B', 'build/native', '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release']);
    run('cmake', ['--build', 'build/native', '--target', 'concord-worker']);
    run('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--release', '-p', 'sync-gateway', '--bins']);
    cleanup = await setup();
  }
  const connectionString = pairedOnly ? process.env.DATABASE_TEST_URL || 'postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test' : process.env.CONCORD_E2E_DB;
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!['concord_test', 'concord_e2e'].includes(databaseName)) throw new Error('Benchmark writes require the isolated concord_test or concord_e2e database');
  db = new pg.Pool({ connectionString }); await db.query(`CREATE SCHEMA ${schema}`);
  await db.query(`CREATE TABLE ${schema}.updates(seq BIGSERIAL PRIMARY KEY,engine TEXT NOT NULL CHECK(engine IN ('concord','yjs')),document_id TEXT NOT NULL,batch UUID NOT NULL UNIQUE,payload BYTEA NOT NULL)`);
  const environment = JSON.parse(execFileSync(process.execPath, ['scripts/bench/capture-env.mjs', '--label', 'editor-comparison'], { cwd: root, encoding: 'utf8' }));
  const versions = {};
  for (const dependency of ['yjs', 'y-prosemirror', '@tiptap/core', '@tiptap/starter-kit', '@playwright/test', 'pg']) versions[dependency] = JSON.parse(await fs.readFile(path.join(root, 'node_modules', dependency, 'package.json'), 'utf8')).version;
  campaign.environment = { ...environment, versions, postgres: (await db.query('SELECT version() AS version')).rows[0].version,
    synchronousCommit: (await db.query('SHOW synchronous_commit')).rows[0].synchronous_commit,
    hashes: Object.fromEntries(await Promise.all(['package-lock.json', 'public/wasm/concord-crdt.wasm', 'public/crdt-worker.js', 'src/lib/sync/sync-session.ts', ...(!pairedOnly ? ['rust/Cargo.lock', 'rust/target/release/sync-gateway', 'build/native/worker/concord-worker'] : []), ...['editor-workloads.mjs', 'editor-client.mjs', 'performance-compare.mjs', 'live-profile.mjs', 'comparison-report.mjs'].map(file => `scripts/bench/${file}`)].map(async file => [file, sha(await fs.readFile(path.join(root, file)))]))) };
  browser = await chromium.launch({ headless: !argv.includes('--headed') }); campaign.environment.chromium = browser.version(); campaign.environment.browserMode = argv.includes('--headed') ? 'headed' : 'headless';
  const origin = await makeServer();
  for (let round = 0; round <= runs; round++) for (let index = 0; index < cells.length; index++) {
    const order = (round + index) % 2 ? ['yjs', 'concord'] : ['concord', 'yjs'];
    for (const engine of order) {
      console.log(`[compare] ${round === 0 ? 'warmup' : `run ${round}/${runs}`} ${cells[index]} / ${engine}`);
      const row = await pairedCell(origin, engine, cells[index], round); campaign.rows.push(row);
      await fs.appendFile(path.join(output, 'samples.ndjson'), `${JSON.stringify(row)}\n`);
      await fs.writeFile(path.join(output, 'raw.json'), JSON.stringify(campaign, null, 2));
    }
  }
  campaign.coverage.paired = true;
  if (!pairedOnly) { campaign.live = await liveProfile({ browser, db, output, runs, quick, offlineSeconds, memory }); campaign.coverage.production = true; }
  campaign.result = 'passed'; campaign.finishedAt = new Date().toISOString(); validateCampaign(campaign);
  await writeReport(campaign, output);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
  await page.goto(`${origin}/report.html`); await page.getByRole('heading', { name: 'Concord and Yjs: measured editor costs' }).waitFor();
  await page.getByLabel('Metric').selectOption('localDurableMs'); await page.getByLabel('Statistic').selectOption('p95');
  assert.equal(await page.locator('#chart tbody tr').count(), 8);
  assert.equal((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations.length, 0, 'Report must be accessible');
  await page.screenshot({ path: path.join(output, 'report.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  campaign.reportBrowserChecks = { accessibilityViolations: 0, mobileOverflow: false, controlsWorking: true };
  await writeReport(campaign, output);
  await context.close();
  console.log(`[compare] complete: ${output}`);
} catch (error) {
  campaign.result = 'incomplete'; campaign.failure = String(error.stack || error); campaign.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'raw.json'), JSON.stringify(campaign, null, 2));
  await Promise.all(['report.html', 'charts.svg'].map(file => fs.rm(path.join(output, file), { force: true })));
  console.error(`[compare] incomplete coverage; raw results preserved at ${output}`); throw error;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await db.end(); }
  if (cleanup) await cleanup();
}
