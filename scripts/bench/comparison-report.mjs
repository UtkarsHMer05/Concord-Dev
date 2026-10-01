import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cells, distribution } from './editor-workloads.mjs';

export const metrics = {
  renderMs: { label: 'Edit to rendering opportunity', unit: 'ms', values: row => row.samples.map(sample => sample.renderMs) },
  localDurableMs: { label: 'Edit to IndexedDB durability', unit: 'ms', values: row => row.samples.map(sample => sample.localDurableMs) },
  acknowledgementMs: { label: 'Edit to PostgreSQL acknowledgement', unit: 'ms', values: row => row.samples.map(sample => sample.acknowledgementMs).filter(value => value !== null) },
  reloadRecoveryMs: { label: 'Cold page reload and convergence', unit: 'ms', values: row => [row.reloadRecoveryMs] },
  reconnectMs: { label: 'Offline backlog and peer catch-up', unit: 'ms', values: row => row.reconnectMs === null ? [] : [row.reconnectMs] },
  browserHeapBytes: { label: 'Page and worker V8 memory', unit: 'bytes', values: row => [row.resources.reduce((n, resource) => n + resource.browserHeapBytes, 0)] },
  localPayloadBytes: { label: 'All clients’ local retained payloads', unit: 'bytes', values: row => [row.resources.reduce((n, resource) => n + resource.localPayloadBytes, 0)] },
  durablePayloadBytes: { label: 'PostgreSQL retained update payloads', unit: 'bytes', values: row => [row.durablePayloadBytes] },
  snapshotBytes: { label: 'Writer snapshot / full-state update', unit: 'bytes', values: row => [row.resources[0].snapshotBytes] },
};
const labels = { append: 'Append typing', middle: 'Middle edits', paste: 'Large pastes', delete: 'Deletes', format: 'Bold / italic', contested: 'One contested document', independent: 'Independent documents', offline: 'Offline backlog' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function validateCampaign(campaign) {
  assert.equal(campaign.schema, 'concord.bench.editor-comparison/1'); assert.equal(campaign.result, 'passed', 'Incomplete campaigns cannot be published as a comparison');
  assert.ok(campaign.environment?.git?.commit && campaign.environment?.chromium && campaign.environment?.versions?.yjs);
  assert.equal(campaign.coverage.paired, true);
  assert.equal(campaign.rows.length, cells.length * 2 * (campaign.measuredRuns + 1));
  const seen = new Set();
  for (const row of campaign.rows) {
    const id = `${row.cell}:${row.engine}:${row.round}`; assert.ok(!seen.has(id), `Duplicate cell ${id}`); seen.add(id);
    assert.ok(cells.includes(row.cell) && ['concord', 'yjs'].includes(row.engine)); assert.equal(row.correctness, true);
    assert.equal(row.warmup, row.round === 0); assert.ok(row.round >= 0 && row.round <= campaign.measuredRuns);
    assert.equal(row.workloadChecksum, hash(row.workload)); assert.match(row.canonicalChecksum, /^[a-f0-9]{64}$/);
    assert.equal(row.samples.length, row.workload.edits.flat().length);
    const edits = new Set();
    for (const sample of row.samples) {
      assert.deepEqual(sample.edit, row.workload.edits[sample.writer]?.[sample.index]);
      const editId = `${sample.writer}:${sample.index}`; assert.ok(!edits.has(editId)); edits.add(editId);
      if (row.cell === 'offline') assert.equal(sample.acknowledgementMs, null, 'Offline edits have no server ACK');
      else assert.ok(Number.isFinite(sample.acknowledgementMs) && sample.acknowledgementMs >= 0);
    }
    assert.equal(row.resources.length, row.workload.clients);
    for (const resource of row.resources) { assert.equal(resource.pendingBatches, 0); assert.equal(resource.dedicatedWorkers, row.engine === 'concord' ? 1 : 0, 'Page-only memory would omit the Concord worker'); }
    for (const metric of Object.values(metrics)) { const values = metric.values(row); if (values.length) distribution(values); }
    if (row.cell === 'offline') assert.ok(row.observedOfflineMs >= campaign.offlineSeconds * 1000 - 10, 'Disconnection shorter than declared');
  }
  for (const cell of cells) for (let round = 0; round <= campaign.measuredRuns; round++) {
    const pair = campaign.rows.filter(row => row.cell === cell && row.round === round);
    assert.equal(pair.length, 2); assert.equal(pair[0].workloadChecksum, pair[1].workloadChecksum, 'Engines must receive identical user edits');
  }
  if (campaign.coverage.production) { assert.equal(campaign.live.length, campaign.measuredRuns); assert.ok(campaign.live.every(row => row.correctness && row.pendingOperations === 0)); }
  return campaign;
}
export function summarize(campaign) {
  validateCampaign(campaign);
  return cells.map(cell => ({ cell, label: labels[cell], runs: campaign.measuredRuns,
    ...Object.fromEntries(['concord', 'yjs'].map(engine => {
      const rows = campaign.rows.filter(row => row.cell === cell && row.engine === engine && !row.warmup);
      return [engine, Object.fromEntries(Object.entries(metrics).map(([name, metric]) => { const values = rows.flatMap(metric.values); return [name, values.length ? distribution(values) : null]; }))];
    })) }));
}
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const display = (value, unit) => value === null ? '—' : unit === 'bytes' ? `${(value / 1024).toFixed(1)} KiB` : `${value.toFixed(2)} ms`;

function svg(summary, campaign) {
  const panels = ['renderMs', 'localDurableMs', 'acknowledgementMs', 'durablePayloadBytes'];
  const parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1180" viewBox="0 0 1600 1180" role="img" aria-labelledby="title desc"><title id="title">Concord and Yjs browser comparison</title><desc id="desc">Four panels showing all eight workloads, including costs where Concord is higher. Lower values are better. Each panel has its own linear axis.</desc><rect width="1600" height="1180" fill="#f7f8fa"/><g font-family="Arial,sans-serif" fill="#17202a"><text x="40" y="52" font-size="30" font-weight="bold">Concord and Yjs: measured editor costs</text>',
    `<text x="40" y="85" font-size="17">${campaign.measuredRuns} measured runs + 1 warmup · Chromium ${escape(campaign.environment.chromium)} · ${escape(campaign.environment.hardware.cpuModel || campaign.environment.os.arch)} · ${campaign.profile}</text>`,
    '<rect x="40" y="104" width="18" height="18" fill="#185abc"/><text x="66" y="120" font-size="17">Concord</text><rect x="180" y="104" width="18" height="18" fill="#a13d13"/><text x="206" y="120" font-size="17">Yjs</text><text x="300" y="120" font-size="17">Lower is better · common PostgreSQL transport · each panel uses a separate scale</text>'];
  for (let panel = 0; panel < panels.length; panel++) {
    const name = panels[panel]; const metric = metrics[name]; const stat = metric.unit === 'bytes' ? 'p50' : 'p95';
    const x = 40 + (panel % 2) * 800; const y = 165 + Math.floor(panel / 2) * 460;
    const maximum = Math.max(1, ...summary.flatMap(row => ['concord', 'yjs'].map(engine => row[engine][name]?.[stat] || 0)));
    parts.push(`<text x="${x}" y="${y}" font-size="21" font-weight="bold">${escape(metric.label)} (${stat})</text>`);
    for (let i = 0; i < summary.length; i++) {
      const row = summary[i]; const top = y + 34 + i * 47;
      parts.push(`<text x="${x}" y="${top + 13}" font-size="14">${escape(row.label)}</text>`);
      for (let e = 0; e < 2; e++) {
        const engine = ['concord', 'yjs'][e]; const value = row[engine][name]?.[stat] ?? null;
        const width = value === null ? 0 : Math.max(1, value / maximum * 320);
        parts.push(`<rect x="${x + 190}" y="${top + e * 17}" width="${width}" height="12" fill="${e ? '#a13d13' : '#185abc'}"/><text x="${x + 524}" y="${top + 11 + e * 17}" font-size="13">${display(value, metric.unit)}</text>`);
      }
    }
    parts.push(`<text x="${x + 190}" y="${y + 433}" font-size="13">Axis: 0 to ${display(maximum, metric.unit)}; offline ACK omitted</text>`);
  }
  parts.push(`<text x="40" y="1115" font-size="15">Candidate ${escape(campaign.environment.git.commit.slice(0, 12))}${campaign.environment.git.dirty ? ' + working changes' : ''} · Yjs ${escape(campaign.environment.versions.yjs)} / y-prosemirror ${escape(campaign.environment.versions['y-prosemirror'])}</text>`,
    '<text x="40" y="1143" font-size="15">Presentation opportunity is not physical paint. Timings are local and unthrottled; production gateway results are reported separately.</text></g></svg>');
  return parts.join('');
}
function html(summary, campaign) {
  const metricInfo = Object.fromEntries(Object.entries(metrics).map(([key, { label, unit }]) => [key, { label, unit }]));
  const data = JSON.stringify({ summary, metricInfo }).replaceAll('<', '\\u003c');
  const live = campaign.live.length ? `<h2>Actual Concord production path</h2><p>Real Clerk authentication, production Next.js, Rust gateway, PostgreSQL, NATS and Redis. These results are separate from the paired engine comparison.</p><table><caption>One sequential browser profile per measured run</caption><thead><tr><th>Run</th><th>ACK p95</th><th>Reconnect</th><th>Cold reload</th></tr></thead><tbody>${campaign.live.map((row, i) => `<tr><th>${i + 1}</th><td>${display(distribution(row.samples.map(sample => sample.acknowledgementMs)).p95, 'ms')}</td><td>${display(row.reconnectMs, 'ms')}</td><td>${display(row.reloadRecoveryMs, 'ms')}</td></tr>`).join('')}</tbody></table>` : '<p><strong>Production app coverage was explicitly omitted (--paired-only).</strong> This is a controlled editor comparison.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Concord and Yjs performance comparison</title><style>
body{margin:0;background:#f7f8fa;color:#17202a;font:16px/1.6 system-ui,sans-serif}main{max-width:1160px;margin:auto;padding:32px 24px}h1{font-size:clamp(26px,4vw,42px);line-height:1.15;max-width:780px}h2{margin-top:36px}a{color:#124eaa}p{max-width:960px}code{overflow-wrap:anywhere}.meta{font-size:14px;color:#465260}.controls{display:flex;gap:20px;flex-wrap:wrap;margin:24px 0}label{display:grid;font-weight:600;gap:6px}select{padding:10px;font:inherit;max-width:100%;border:1px solid #697684;background:white;border-radius:4px}table{border-collapse:collapse;width:100%;table-layout:fixed;background:white}caption{text-align:left;margin:16px 0 10px;color:#465260}th,td{padding:14px 12px;text-align:left;border-bottom:1px solid #d1d9e0;overflow-wrap:anywhere}th:first-child{width:29%}.bar{height:8px;background:#185abc;margin-top:8px;min-width:1px}.bar.yjs{background:#a13d13}.samples{font-size:12px;color:#465260}.notice{padding:16px;border-left:4px solid #185abc;background:#eaf1fe}.downloads{display:flex;gap:24px;flex-wrap:wrap}summary{cursor:pointer;font-weight:600}details{margin-top:24px}img{max-width:100%}@media(max-width:600px){main{padding:24px 14px}th,td{padding:10px 6px;font-size:13px}th:first-child{width:30%}.controls{display:block}label{margin-bottom:16px}select{width:100%}}:focus-visible{outline:3px solid #185abc;outline-offset:3px}
</style></head><body><main><p class="meta">Concord · reproducible engineering evidence</p><h1>Concord and Yjs: measured editor costs</h1><p class="notice">${campaign.profile === 'quick' ? '<strong>Quick correctness profile — not headline performance evidence.</strong> ' : ''}All ${cells.length} workload pairs passed text/formatting, convergence, durability and reload checks. Lower measurements are better; the report includes costs where Concord is higher.</p>
<p class="meta">${campaign.measuredRuns} measured runs, one excluded warmup · ${escape(campaign.environment.hardware.cpuModel || campaign.environment.os.arch)} · Chromium ${escape(campaign.environment.chromium)} · Yjs ${escape(campaign.environment.versions.yjs)} · y-prosemirror ${escape(campaign.environment.versions['y-prosemirror'])}</p>
<div class="downloads"><a href="raw.json" download>Raw results and environment</a><a href="summary.csv" download>Summary CSV</a><a href="charts.svg" download>Export chart</a></div>
<div class="controls"><label>Metric<select id="metric" aria-label="Metric">${Object.entries(metricInfo).map(([key, metric]) => `<option value="${key}">${escape(metric.label)}</option>`).join('')}</select></label><label>Statistic<select id="stat" aria-label="Statistic"><option value="p50">Median (p50)</option><option value="p95">p95</option></select></label></div>
<table id="chart"><caption id="caption"></caption><thead><tr><th scope="col">Workload</th><th scope="col">Concord</th><th scope="col">Yjs</th></tr></thead><tbody></tbody></table>
<details><summary>Method and limits</summary><ul>${Object.entries(campaign.method).map(([name, value]) => `<li><strong>${escape(name)}:</strong> ${escape(value)}</li>`).join('')}</ul><p>Retained payload bytes exclude database indexes, row headers and WAL. Local payloads sum all replicas; snapshots and full-state updates are listed separately. Byte-size p95 has only ${campaign.measuredRuns} measured run samples. Concurrent insert tie ordering may differ, so that workload checks complete tokens and within-engine peer convergence. These measurements do not establish asymptotic complexity, maximum throughput or a hosted deployment.</p><p>Offline interval: ${campaign.offlineSeconds}s. Exact user edits, initial text, sample counts, checksums, toolchain/build details and binary hashes are in the raw download.</p></details>
${live}<h2>Reproduce this campaign</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">npm ci
npm run bench:compare</pre><p>See <a href="https://github.com/UtkarsHMer05/Concord-Dev/blob/main/docs/PERFORMANCE_COMPARISON.md">the setup and measurement guide</a> for Docker, native toolchain and development authentication prerequisites.</p><p class="meta">${escape(campaign.runId)}<br>Candidate ${escape(campaign.environment.git.commit)}${campaign.environment.git.dirty ? ' plus working changes (source hashes recorded)' : ''}<br>${escape(campaign.finishedAt)}</p>
</main><script>const data=${data};const metric=document.querySelector('#metric'),stat=document.querySelector('#stat');function render(){const name=metric.value,s=stat.value,unit=data.metricInfo[name].unit;const max=Math.max(1,...data.summary.flatMap(row=>['concord','yjs'].map(engine=>row[engine][name]?.[s]||0)));const fmt=value=>value==null?'No online samples':unit==='bytes'?(value/1024).toFixed(1)+' KiB':value.toFixed(2)+' ms';document.querySelector('#caption').textContent=data.metricInfo[name].label+' · '+s+' · lower is better';document.querySelector('#chart tbody').innerHTML=data.summary.map(row=>'<tr><th scope="row">'+row.label+'</th>'+['concord','yjs'].map(engine=>{const sample=row[engine][name],value=sample?.[s];return '<td>'+fmt(value)+'<div class="bar '+engine+'" style="width:'+(value==null?0:Math.max(1,value/max*100))+'%"></div><span class="samples">'+(sample?sample.samples+' samples':'Offline / not applicable')+'</span></td>'}).join('')+'</tr>').join('')}metric.addEventListener('change',render);stat.addEventListener('change',render);render();</script></body></html>`;
}
export async function writeReport(campaign, output) {
  const summary = summarize(campaign);
  await fs.writeFile(path.join(output, 'raw.json'), JSON.stringify(campaign, null, 2));
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  const lines = ['workload,engine,metric,unit,runs,samples,p50,p95,min,max'];
  for (const row of summary) for (const engine of ['concord', 'yjs']) for (const [name, metric] of Object.entries(metrics)) { const result = row[engine][name]; if (result) lines.push([row.cell, engine, name, metric.unit, row.runs, result.samples, result.p50, result.p95, result.min, result.max].join(',')); }
  await fs.writeFile(path.join(output, 'summary.csv'), lines.join('\n') + '\n');
  await fs.writeFile(path.join(output, 'charts.svg'), svg(summary, campaign));
  await fs.writeFile(path.join(output, 'report.html'), html(summary, campaign));
}
if (import.meta.filename === process.argv[1]) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/bench/comparison-report.mjs <raw.json>');
  const filename = path.resolve(process.argv[2]); await writeReport(JSON.parse(await fs.readFile(filename, 'utf8')), path.dirname(filename));
}
