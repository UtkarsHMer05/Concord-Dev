import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cells, workload, distribution } from './editor-workloads.mjs';
import { validateCampaign, summarize } from './comparison-report.mjs';

function fixture() {
  const rows = cells.flatMap(cell => [0, 1].flatMap(round => ['concord', 'yjs'].map(engine => {
    const plan = workload(cell, true);
    return { cell, engine, round, warmup: round === 0, correctness: true, workload: plan,
      workloadChecksum: createHash('sha256').update(JSON.stringify(plan)).digest('hex'), canonicalChecksum: '0'.repeat(64),
      samples: plan.edits.flatMap((edits, writer) => edits.map((edit, index) => ({ writer, index, edit, renderMs: round ? 10 : 1000, localDurableMs: 2, acknowledgementMs: cell === 'offline' ? null : 3 }))),
      reloadRecoveryMs: 10, reconnectMs: cell === 'offline' ? 20 : null, observedOfflineMs: cell === 'offline' ? 1000 : null,
      durablePayloadBytes: 200, resources: Array.from({ length: plan.clients }, () => ({ pendingBatches: 0, dedicatedWorkers: engine === 'concord' ? 1 : 0, browserHeapBytes: 300, localPayloadBytes: 200, snapshotBytes: 100 })) };
  })));
  return { schema: 'concord.bench.editor-comparison/1', result: 'passed', measuredRuns: 1, offlineSeconds: 1, coverage: { paired: true, production: false }, rows,
    environment: { git: { commit: 'test' }, chromium: 'test', versions: { yjs: '13.6.33' } } };
}
test('comparison excludes warmups and never invents offline ACKs', () => {
  const summary = summarize(fixture()); assert.equal(summary[0].concord.renderMs.p95, 10);
  assert.equal(summary.at(-1).concord.acknowledgementMs, null);
  assert.deepEqual(distribution([1, 2, 3, 4]), { samples: 4, min: 1, p50: 2, p95: 4, max: 4 });
});
test('missing coverage, unmatched user edits and incomplete memory fail publication', () => {
  const missing = fixture(); missing.rows.pop(); assert.throws(() => validateCampaign(missing));
  const mismatch = fixture(); mismatch.rows[0].samples[0].edit = { kind: 'insert', at: 'end', text: 'different edit' }; assert.throws(() => validateCampaign(mismatch));
  const memory = fixture(); memory.rows[0].resources[0].dedicatedWorkers = 0; assert.throws(() => validateCampaign(memory));
  const failed = fixture(); failed.result = 'incomplete'; assert.throws(() => validateCampaign(failed));
  const premature = fixture(); premature.rows.at(-1).resources[0].pendingBatches = 1; assert.throws(() => validateCampaign(premature));
  const nan = fixture(); nan.rows[0].samples[0].renderMs = NaN; assert.throws(() => validateCampaign(nan));
});
