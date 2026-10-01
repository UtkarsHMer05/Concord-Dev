// The existing production app and durable gateway; no benchmark hook in product code.
import assert from 'node:assert/strict';
import path from 'node:path';
import { signIn, createDocument, waitForEditor, ConsoleMonitor } from '../../tests/browser/helpers.ts';
import { applyEditorEdit, canonicalDocument, workload } from './editor-workloads.mjs';

async function installProbe(page, documentId) {
  await page.evaluate(documentId => {
    const rows = (name, store) => new Promise((resolve, reject) => {
      const open = indexedDB.open(name); open.onerror = () => reject(open.error);
      open.onsuccess = () => { const db = open.result; if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error(`Missing ${name}/${store}`)); return; }
        const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => { const result = request.result; db.close(); resolve(result); }; request.onerror = () => { db.close(); reject(request.error); }; };
    });
    const stats = async () => {
      const meta = await rows('concord-sync', 'meta');
      const pending = await new Promise((resolve, reject) => {
        const request = indexedDB.open('concord-sync'); request.onerror = () => reject(request.error);
        request.onsuccess = () => { const db = request.result; const tx = db.transaction('outbox'); const index = tx.objectStore('outbox').index('stateId'); const counts = [];
          for (const state of ['pending', 'sent']) { const count = index.count(IDBKeyRange.bound([state, `${documentId}:`], [state, `${documentId}:\uffff`])); count.onsuccess = () => counts.push(count.result); }
          tx.oncomplete = () => { db.close(); resolve(counts.reduce((n, count) => n + count, 0)); }; tx.onerror = () => { db.close(); reject(tx.error); }; };
      });
      const counters = meta.filter(row => row.documentId.startsWith(documentId)).map(row => BigInt(row.counter));
      return { pending, counter: counters.reduce((max, value) => value > max ? value : max, 0n).toString() };
    };
    window.liveBench = {
      start: 0, painted: null, baseline: null, active: false, expectedCounter: null, localCommittedAt: null,
      async before() { this.baseline = await stats(); this.active = true; this.expectedCounter = null; this.localCommittedAt = null; },
      async finish(requireAck = true) {
        const deadline = performance.now() + 60000;
        while (performance.now() < deadline) {
          const state = await stats();
          if (this.localCommittedAt !== null && (!requireAck || (BigInt(state.counter) >= BigInt(this.expectedCounter) && state.pending === 0))) {
            this.active = false;
            return { localDurableMs: this.localCommittedAt - this.start, renderMs: await this.painted, acknowledgementMs: requireAck ? performance.now() - this.start : null, expectedLastOperationCounter: this.expectedCounter };
          }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('Production edit did not reach local persistence / durable ACK');
      }, stats,
      async storedBytes() { const [ops, pending, snapshots] = await Promise.all([rows('concord-crdt', 'oplog'), rows('concord-sync', 'outbox'), rows('concord-crdt', 'snapshots')]); return ops.filter(row => row.documentId.startsWith(documentId)).reduce((n, row) => n + row.op.length, 0) + pending.filter(row => row.id.startsWith(documentId)).reduce((n, row) => n + row.op.length, 0) + snapshots.filter(row => row.documentId.startsWith(documentId)).reduce((n, row) => n + row.snapshot.length, 0); },
      async armTyping() { await this.before(); const editor = document.querySelector('.ProseMirror').editor; editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.commands.focus(); await new Promise(resolve => requestAnimationFrame(resolve)); this.armed = true; this.completion = null; },
      async finishTyping() { if (!this.completion) throw new Error('No production keyboard update observed'); const result = await this.completion; this.armed = false; return result; },
    };
    const editor = document.querySelector('.ProseMirror').editor;
    editor.view.dom.addEventListener('beforeinput', () => { const probe = window.liveBench; if (probe.armed) { probe.start = performance.now(); probe.painted = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - probe.start)))); } });
    editor.on('update', () => { const probe = window.liveBench; if (probe.armed && !probe.completion) probe.completion = probe.finish(); });
  }, documentId);
}
export async function liveProfile({ browser, db, output, runs, quick, offlineSeconds, memory }) {
  const results = []; const origin = process.env.CONCORD_E2E_BASE_URL; const user = JSON.parse(process.env.CONCORD_E2E_USERS).primary;
  for (let round = 1; round <= runs; round++) {
    console.log(`[compare] actual Concord production browser ${round}/${runs}`);
    const context = await browser.newContext({ baseURL: origin, viewport: { width: 1440, height: 1000 } }); const peerContext = await browser.newContext({ baseURL: origin });
    // Benchmark-only observation of the unchanged worker's response after its
    // atomic IDB append. The last counter gates the whole paste, not its first ACK.
    await context.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', event => {
            const result = event.data?.ok && event.data?.result;
            const probe = window.liveBench;
            if (!probe?.active || result?.kind !== 'localOps' || !result.ops.length) return;
            const last = result.ops.at(-1); const view = new DataView(last.buffer, last.byteOffset, last.byteLength);
            probe.expectedCounter = view.getBigUint64(10, true).toString(); probe.localCommittedAt = performance.now();
          });
        }
      };
    });
    const gatewayErrors = [];
    context.on('page', target => target.on('websocket', socket => socket.on('framereceived', frame => {
      if (typeof frame.payload !== 'string') return;
      try {
        const control = JSON.parse(frame.payload);
        if (control.type === 'error') gatewayErrors.push({ code: control.payload.code, message: control.payload.message });
      } catch { gatewayErrors.push({ code: 'malformed_frame', message: 'Gateway text frame was not JSON' }); }
    })));
    const page = await context.newPage(); const peer = await peerContext.newPage(); const monitor = new ConsoleMonitor(); monitor.attach(page); monitor.attach(peer);
    try {
      await signIn(page, user); const documentId = await createDocument(page, 'Measured editor profile'); await waitForEditor(page);
      await page.getByText('Collaborative · Connected', { exact: true }).waitFor({ timeout: 60000 });
      await page.getByRole('button', { name: 'Blank document', exact: true }).click(); await page.getByRole('textbox', { name: 'Document title' }).fill('Performance: offline recovery'); await page.getByRole('textbox', { name: 'Document title' }).press('Enter');
      await installProbe(page, documentId);
      const plan = workload('offline', quick);
      await page.evaluate(() => window.liveBench.before());
      await page.evaluate(applyEditorEdit, { kind: 'insert', at: 'end', text: plan.initialText });
      await page.evaluate(() => window.liveBench.finish());
      const samples = [];
      for (const cell of ['append', 'middle', 'paste', 'delete', 'format']) {
        for (const [index, edit] of workload(cell, quick).edits[0].entries()) {
          let measured;
          if (cell === 'append') { await page.evaluate(() => window.liveBench.armTyping()); await page.keyboard.press('x'); measured = await page.evaluate(() => window.liveBench.finishTyping()); }
          else { await page.evaluate(() => window.liveBench.before()); assert.equal(await page.evaluate(applyEditorEdit, edit), true); measured = await page.evaluate(() => window.liveBench.finish()); }
          samples.push({ cell, index, edit, inputMethod: cell === 'append' ? 'keyboard-beforeinput' : 'PM-command', ...measured });
        }
      }
      await signIn(peer, user); await peer.goto(`/documents/${documentId}`); await waitForEditor(peer);
      await peer.getByText('Collaborative · Connected', { exact: true }).waitFor({ timeout: 60000 });
      const state = async target => canonicalDocument(await target.evaluate(() => document.querySelector('.ProseMirror').editor.getJSON()));
      const equal = async () => {
        const until = Date.now() + 60000;
        while (Date.now() < until) { const left = await state(page); const right = await state(peer); if (JSON.stringify(left) === JSON.stringify(right)) return left; await new Promise(resolve => setTimeout(resolve, 25)); }
        throw new Error('Production peer failed to converge');
      };
      await equal(); await context.setOffline(true); const disconnectedAt = Date.now(); const offlineSamples = [];
      for (const [index, edit] of plan.edits[0].entries()) {
        await page.evaluate(() => window.liveBench.before()); assert.equal(await page.evaluate(applyEditorEdit, edit), true);
        offlineSamples.push({ index, edit, ...await page.evaluate(() => window.liveBench.finish(false)) });
      }
      const marker = '[online peer changed during offline typing]';
      const beforeReconnect = (await state(page))[0].map(char => char.text).join('');
      assert.equal(await peer.evaluate(applyEditorEdit, { kind: 'insert', at: 'end', text: marker }), true);
      const pendingOffline = await page.evaluate(() => window.liveBench.stats()); assert.ok(pendingOffline.pending > 0, 'Offline edits must remain in the durable outbox');
      const remaining = Math.max(0, offlineSeconds * 1000 - (Date.now() - disconnectedAt));
      console.log(`[compare] production offline backlog: ${pendingOffline.pending} ops; remaining disconnection ${(remaining / 1000).toFixed(1)}s`);
      await new Promise(resolve => setTimeout(resolve, remaining)); const observedOfflineMs = Date.now() - disconnectedAt;
      const reconnectStart = performance.now(); await context.setOffline(false); await page.getByText('Collaborative · Connected', { exact: true }).waitFor({ timeout: 60000 }); const converged = await equal();
      let pending = await page.evaluate(() => window.liveBench.stats()); const until = Date.now() + 60000;
      while (pending.pending && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 10)); pending = await page.evaluate(() => window.liveBench.stats()); }
      assert.equal(pending.pending, 0); const reconnectMs = performance.now() - reconnectStart;
      const afterReconnect = converged[0].map(char => char.text).join(''); assert.equal(afterReconnect.split(marker).length - 1, 1); assert.equal(afterReconnect.replace(marker, ''), beforeReconnect);
      const reloadStart = performance.now(); await page.reload(); await waitForEditor(page); await page.getByText('Collaborative · Connected', { exact: true }).waitFor({ timeout: 60000 }); await equal(); const reloadRecoveryMs = performance.now() - reloadStart;
      assert.deepEqual(await state(page), converged); await installProbe(page, documentId);
      const storage = (await db.query('SELECT count(*)::int AS operations,coalesce(sum(octet_length(payload)),0)::float8 AS bytes FROM crdt_operations WHERE document_id=$1', [documentId])).rows[0];
      const snapshots = (await db.query("SELECT coalesce(sum(octet_length(payload)),0)::float8 AS bytes FROM crdt_snapshots WHERE document_id=$1 AND status='finalized'", [documentId])).rows[0];
      const local = await page.evaluate(() => window.liveBench.stats());
      const errors = monitor.fatalErrors().filter(error => !/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(error)); assert.deepEqual(errors, [], 'No unexpected production browser errors');
      assert.ok(gatewayErrors.every(error => error.code === 'rate_limited'), 'No unexpected production gateway errors');
      if (round === 1) await page.screenshot({ path: path.join(output, 'production-editor.png'), fullPage: true });
      results.push({ round, documentId, initialText: plan.initialText, samples, offlineSamples, offlineEdits: plan.edits[0], observedOfflineMs, reconnectMs, reloadRecoveryMs,
        browserMemory: await memory(page), localPayloadBytes: await page.evaluate(() => window.liveBench.storedBytes()), durableOperationPayloadBytes: storage.bytes,
        durableSnapshotBytes: snapshots.bytes, durableOperations: storage.operations, pendingOperations: local.pending, correctness: true, gatewayErrors,
        method: 'Real keyboard input for append; PM commands for other edits; stock worker commit response measures local durability. Exact last generated operation counter observed in outbox plus zero pending gates whole-edit durable ACK; index-count polling has a 5ms interval.' });
    } catch (error) { await page.screenshot({ path: path.join(output, `production-failure-${round}.png`), fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); await peerContext.close(); }
  }
  return results;
}
