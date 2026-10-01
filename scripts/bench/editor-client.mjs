// Benchmark-only editor. Stock Concord bridge/worker and official Yjs binding.
import { Editor, Extension, getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as Y from 'yjs';
import { ySyncPlugin, prosemirrorJSONToYXmlFragment } from 'y-prosemirror';
import { CrdtClient } from '../../src/lib/crdt/worker/client';
import { CrdtEditorBridge } from '../../src/lib/crdt/editor-bridge';
import { IdbPersistence } from '../../src/lib/crdt/worker/idb';
import { applyEditorEdit, canonicalDocument } from './editor-workloads.mjs';

const params = new URLSearchParams(location.search);
const engine = params.get('engine');
const doc = params.get('doc');
const peer = params.get('peer');
if (!['concord', 'yjs'].includes(engine) || !/^[a-z0-9-]{1,100}$/.test(doc || '') || !/^\d{1,2}$/.test(peer || '')) throw new Error('Invalid benchmark identity');
const key = `${engine}:${doc}:${peer}`;
const initialText = params.get('seed') || '';
document.querySelector('h1').textContent = `${engine === 'concord' ? 'Concord' : 'Yjs'} · ${doc}`;
const fatal = [];
let online = true;
let cursor = 0;
let persistenceTail = Promise.resolve();
let pullTail = Promise.resolve();
let sendTail = Promise.resolve();
let captures = [];
let localNotification = null;
let resolveNotification = null;
let receivedBytes = 0;
let sentBytes = 0;
let typing = null;
let bridge, client, ydoc;
const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function completeEdit(start, painted) {
  await collect(); const localDurableMs = performance.now() - start;
  await send(); const acknowledgementMs = online ? performance.now() - start : null;
  return { localDurableMs, acknowledgementMs, renderMs: await painted };
}

const database = await new Promise((resolve, reject) => {
  const request = indexedDB.open('concord-benchmark', 1);
  request.onupgradeneeded = () => { request.result.createObjectStore('updates', { keyPath: 'id', autoIncrement: true }); request.result.createObjectStore('outbox', { keyPath: 'id' }); };
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const store = (name, mode, work) => new Promise((resolve, reject) => {
  const tx = database.transaction(name, mode); const result = work(tx.objectStore(name));
  tx.oncomplete = () => resolve(result?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('IDB transaction aborted'));
});
const records = async name => (await store(name, 'readonly', s => s.getAll())).filter(row => row.key === key);
const appendY = bytes => { persistenceTail = persistenceTail.then(() => store('updates', 'readwrite', s => s.add({ key, bytes }))); return persistenceTail; };

function pack(updates) {
  const bytes = new Uint8Array(4 + updates.reduce((n, update) => n + 4 + update.length, 0));
  const view = new DataView(bytes.buffer); view.setUint32(0, updates.length, true); let offset = 4;
  for (const update of updates) { view.setUint32(offset, update.length, true); offset += 4; bytes.set(update, offset); offset += update.length; }
  return bytes;
}
function unpack(base64) {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); const view = new DataView(bytes.buffer);
  const count = view.getUint32(0, true); const result = []; let offset = 4;
  for (let i = 0; i < count; i++) { const size = view.getUint32(offset, true); offset += 4; result.push(bytes.slice(offset, offset + size)); offset += size; }
  if (offset !== bytes.length) throw new Error('Malformed update batch');
  return result;
}
async function enqueue(updates) {
  if (!updates.length) return;
  await store('outbox', 'readwrite', s => s.put({ id: crypto.randomUUID(), key, bytes: pack(updates) }));
}
async function collect() {
  if (bridge) {
    await bridge.flushLocalChanges();
    if (localNotification) { await localNotification; localNotification = null; }
    const updates = captures; captures = []; await enqueue(updates);
  } else {
    await persistenceTail; const updates = captures; captures = []; await enqueue(updates);
  }
}
async function send() {
  const run = sendTail.then(async () => {
    if (!online) return;
    for (const row of await records('outbox')) {
      const response = await fetch(`/updates/${engine}/${doc}/${row.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: row.bytes });
      if (!response.ok) throw new Error(`Commit failed: ${response.status}`);
      sentBytes += row.bytes.length;
      await store('outbox', 'readwrite', s => s.delete(row.id));
    }
  }); sendTail = run.catch(error => { fatal.push(String(error)); }); return run;
}
async function pull() {
  const run = pullTail.then(async () => {
    if (!online) return;
    const response = await fetch(`/updates/${engine}/${doc}?after=${cursor}`);
    if (!response.ok) throw new Error(`Catch-up failed: ${response.status}`);
    const text = await response.text(); receivedBytes += new TextEncoder().encode(text).length;
    for (const row of JSON.parse(text)) {
      const updates = unpack(row.payload);
      if (bridge) await bridge.applyRemote(updates);
      else for (const bytes of updates) Y.applyUpdate(ydoc, bytes, 'remote');
      cursor = row.seq;
    }
    await persistenceTail;
  }); pullTail = run.catch(error => { fatal.push(String(error)); }); return run;
}
const extensions = [StarterKit.configure({ undoRedo: false, trailingNode: false })];
if (engine === 'yjs') {
  ydoc = new Y.Doc();
  for (const row of await records('updates')) Y.applyUpdate(ydoc, row.bytes, 'restore');
  ydoc.on('update', (bytes, origin) => { void appendY(bytes).catch(error => fatal.push(String(error))); if (origin !== 'remote') captures.push(bytes); });
  if (!initialText && !ydoc.getXmlFragment('prosemirror').length) {
    const response = await fetch(`/updates/${engine}/${doc}?after=0`);
    if (!response.ok) throw new Error(`Initial catch-up failed: ${response.status}`);
    for (const row of await response.json()) { for (const bytes of unpack(row.payload)) Y.applyUpdate(ydoc, bytes, 'remote'); cursor = row.seq; }
    await persistenceTail;
  }
  if (!ydoc.getXmlFragment('prosemirror').length && initialText) {
    prosemirrorJSONToYXmlFragment(getSchema(extensions), { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: initialText }] }] }, ydoc.getXmlFragment('prosemirror'));
  }
  extensions.push(Extension.create({ name: 'benchmarkCollaboration', addProseMirrorPlugins: () => [ySyncPlugin(ydoc.getXmlFragment('prosemirror'))] }));
}
const editor = new Editor({ element: document.querySelector('#editor'), extensions,
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
  onUpdate: () => {
    if (bridge) void bridge.onLocalTransaction(editor).catch(error => fatal.push(String(error)));
    if (typing?.start !== null && typing?.start !== undefined && !typing.completion) typing.completion = completeEdit(typing.start, typing.painted);
  },
});
if (engine === 'concord') {
  client = new CrdtClient();
  client.onLocalOps(ops => { captures.push(...ops); resolveNotification?.(); resolveNotification = null; });
  bridge = new CrdtEditorBridge({ editor, client, documentId: doc, userId: `benchmark-${peer}`,
    seedPmDoc: initialText ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: initialText }] }] } : null });
  await bridge.start(); if (bridge.getState().mode !== 'crdt') throw new Error(JSON.stringify(bridge.getState()));
  if (initialText) await enqueue(await client.exportOps());
}
await collect(); await send(); await pull();
editor.view.dom.addEventListener('beforeinput', () => { if (typing && typing.start === null) { typing.start = performance.now(); typing.painted = paint().then(() => performance.now() - typing.start); } });
const timer = setInterval(() => { if (online) void pull().catch(error => fatal.push(String(error))); }, 50);
const awaitNotification = () => { if (bridge) localNotification = new Promise(resolve => { resolveNotification = resolve; }); };
window.bench = {
  editor,
  async edit(edit) {
    awaitNotification();
    const start = performance.now(); if (!applyEditorEdit(editor, edit)) throw new Error('Editor rejected edit');
    const painted = paint().then(() => performance.now() - start);
    return completeEdit(start, painted);
  },
  async armTyping() { editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.commands.focus(); await paint(); awaitNotification(); typing = { start: null, completion: null }; },
  async finishTyping() { if (!typing?.completion) throw new Error('Keyboard input did not dispatch an editor update'); const result = await typing.completion; typing = null; return result; },
  async settle() { await collect(); await send(); await pull(); await paint(); if (fatal.length) throw new Error(fatal.join('\n')); },
  async setOnline(value) { online = value; if (!value) await Promise.all([sendTail, pullTail]); },
  state: () => ({ canonical: canonicalDocument(editor.getJSON()), text: editor.getText(), errors: [...fatal], pending: null }),
  async resources() {
    await persistenceTail;
    let localPayloadBytes;
    if (bridge) { const state = await new IdbPersistence().loadLocalState(bridge.getStorageId()); localPayloadBytes = (state.snapshot?.length || 0) + state.ops.reduce((n, op) => n + op.length, 0); }
    else localPayloadBytes = (await records('updates')).reduce((n, row) => n + row.bytes.length, 0);
    return { localPayloadBytes, snapshotBytes: bridge ? (await client.exportSnapshot()).length : Y.encodeStateAsUpdate(ydoc).length,
      pendingBatches: (await records('outbox')).length, sentPayloadBytes: sentBytes, receivedResponseBytes: receivedBytes,
      originStorageEstimateBytes: (await navigator.storage.estimate()).usage ?? null };
  },
  dispose() { clearInterval(timer); editor.destroy(); bridge?.dispose(); client?.terminate(); ydoc?.destroy(); database.close(); },
};
await paint(); document.querySelector('#status').textContent = 'Ready: local persistence and PostgreSQL commit active';
window.benchReady = true;
