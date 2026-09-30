// One entry point over existing correctness tools. Never boots/stops shared
// services, deploys, or silently promotes skipped tests to complete coverage.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { renderReport } from './failure-lab/report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
try { process.loadEnvFile('.env.local'); } catch { /* Optional local environment. */ }
const args = process.argv.slice(2);
const command = args[0]?.startsWith('--') || !args[0] ? 'run' : args.shift();
if (!['run', 'replay', 'minimize'].includes(command)) throw new Error('Usage: npm run failure-lab -- [run | replay trace.json | minimize trace.json] [--sim-only] [--out directory] [--headed]');
const input = command === 'run' ? null : path.resolve(args.shift() ?? '');
const options = { simulatedOnly: command !== 'run', headed: false, output: path.resolve('output/playwright/failure-lab/latest') };
while (args.length) {
    const arg = args.shift();
    if (arg === '--sim-only') options.simulatedOnly = true;
    else if (arg === '--headed') options.headed = true;
    else if (arg === '--out' && args[0]) options.output = path.resolve(args.shift());
    else throw new Error(`Unknown or incomplete option: ${arg}`);
}
if (input && (await fs.stat(input)).size > 2 * 1024 * 1024) throw new Error('Trace exceeds the 2 MiB limit');
await fs.mkdir(options.output, { recursive: true });
const lockPath = path.join(root, '.agent/scratch/failure-lab.lock');
await fs.mkdir(path.dirname(lockPath), { recursive: true });
const lock = await fs.open(lockPath, 'wx').catch(() => { throw new Error('Another failure-lab run owns the checkout lock. Finish that run first; after an interrupted run, remove only .agent/scratch/failure-lab.lock.'); });
await lock.writeFile(String(process.pid));
const lanes = [];
let simulation;
const report = { version: 1, command, startedAt: new Date().toISOString(), coverage: options.simulatedOnly ? 'simulation only; live checks not requested' : 'simulation and live infrastructure', environment: {
    node: process.version, platform: os.platform(), architecture: os.arch(), sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
}, lanes };
const vitest = path.join(root, 'node_modules/vitest/vitest.mjs');
const exists = async (p) => fs.access(p).then(() => true, () => false);
let compilerReady = true;
if (process.platform === 'darwin') {
    const sdkWorks = (env) => { try { execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { env, stdio: 'ignore' }); return true; } catch { return false; } };
    compilerReady = sdkWorks(process.env);
    // Use an already-installed CLT SDK if the selected Xcode cannot build.
    // This is process-local; no license acceptance or system setting change.
    if (!compilerReady && !process.env.DEVELOPER_DIR && await exists('/Library/Developer/CommandLineTools')) {
        const env = { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' };
        if (sdkWorks(env)) { process.env.DEVELOPER_DIR = env.DEVELOPER_DIR; compilerReady = true; report.environment.nativeToolchain = 'installed Command Line Tools'; }
    }
}
const cargoReady = (process.env.PATH ?? '').split(path.delimiter).some((directory) => { try { execFileSync(path.join(directory, 'cargo'), ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
const tcp = (port) => new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    const end = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500); socket.once('connect', () => end(true)); socket.once('error', () => end(false)); socket.once('timeout', () => end(false));
});
const dbUrl = process.env.DATABASE_TEST_URL ?? 'postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test';
const dbAvailable = async () => {
    const url = new URL(dbUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/concord_test' || (url.port || '5432') !== '5433') throw new Error('Live legacy suites require the isolated loopback concord_test DB on port 5433; refusing a different target.');
    const pg = (await import('pg').catch(() => null))?.default;
    if (!pg) return false;
    const db = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 2000 });
    try { await db.connect(); await db.query('SELECT 1'); return true; } catch { return false; } finally { await db.end().catch(() => {}); }
};
async function runLane(id, label, executable, argv, env = {}, required = [], kind = 'live') {
    const lane = { id, label, kind, status: 'running', passed: 0, skipped: 0 };
    lanes.push(lane);
    const missing = required.filter((entry) => !entry[1]).map(([name]) => name);
    if (missing.length) { Object.assign(lane, { status: 'incomplete', reason: `Missing dependencies: ${missing.join(', ')}` }); console.log(`[failure-lab] INCOMPLETE ${label}: ${lane.reason}`); return lane; }
    console.log(`[failure-lab] Running ${label}`);
    const logPath = path.join(options.output, `${id}.log`);
    const log = await fs.open(logPath, 'w');
    let output = ''; let timedOut = false; let writes = Promise.resolve();
    const code = await new Promise((resolve) => {
        const child = spawn(executable, argv, { cwd: root, env: { ...process.env, DATABASE_TEST_URL: dbUrl, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        // Bounded diagnostic tail; raw logs stay local and are never embedded
        // in the shareable HTML/JSON report (they may contain local DSNs).
        const capture = (chunk) => { output = (output + chunk.toString()).slice(-1024 * 1024); writes = writes.then(() => log.write(chunk)); };
        child.stdout.on('data', capture); child.stderr.on('data', capture);
        const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, 12 * 60_000);
        child.once('error', (error) => { output += error.message; clearTimeout(timeout); resolve(1); });
        child.once('close', (value) => { clearTimeout(timeout); resolve(value ?? 1); });
    });
    await writes; await log.close();
    const summaries = [...output.matchAll(/test result: ok\. (\d+) passed; \d+ failed; (\d+) ignored/g)];
    lane.passed = summaries.reduce((n, m) => n + Number(m[1]), 0); lane.skipped = summaries.reduce((n, m) => n + Number(m[2]), 0);
    const vitestResult = path.join(options.output, `${id}.tests.json`);
    if (await exists(vitestResult)) {
        const tests = JSON.parse(await fs.readFile(vitestResult, 'utf8'));
        lane.passed = tests.numPassedTests; lane.skipped = tests.numPendingTests;
        // The CLI deliberately selects its one artifact-producing case.
        if (id === 'simulation' && lane.passed === 1) lane.skipped = 0;
    }
    const skips = /\bSKIP\b|skipped because/i.test(output);
    Object.assign(lane, { status: code !== 0 ? 'failed' : skips || lane.skipped > 0 ? 'incomplete' : 'passed', exitCode: code });
    if (timedOut) lane.reason = 'Timed out; inspect the local log. Coverage is unfinished.';
    else if (code !== 0) lane.reason = `Command failed (exit ${code}); inspect ${id}.log locally.`;
    else if (skips || lane.skipped) lane.reason = 'The underlying suite skipped coverage; inspect the local log.';
    console.log(`[failure-lab] ${lane.status.toUpperCase()} ${label}`);
    return lane;
}
try {
    const wasm = path.join(root, 'wasm/dist/concord-crdt.wasm');
    if (await exists(wasm)) report.environment.wasmSha256 = createHash('sha256').update(await fs.readFile(wasm)).digest('hex');
    const sim = await runLane('simulation', 'Recorded session and real-WASM scenarios', process.execPath,
        [vitest, 'run', '--project', 'unit', 'tests/sync/failure-lab.test.ts', '-t', 'writes CLI execution', '--reporter=json', `--outputFile=${path.join(options.output, 'simulation.tests.json')}`],
        { CONCORD_LAB_OUTPUT: options.output, CONCORD_LAB_ACTION: command, ...(input ? { CONCORD_LAB_INPUT: input } : {}) },
        [['built WASM (npm run wasm:build)', await exists(wasm)], ['installed Vitest (npm ci)', await exists(vitest)]], 'simulated');
    // The other unit cases are intentionally filtered in this CLI invocation;
    // only its one selected execution case is expected here.
    if (sim.exitCode === 0) {
        simulation = JSON.parse(await fs.readFile(path.join(options.output, 'simulation.json'), 'utf8'));
        sim.skipped = 0; sim.status = simulation.results.every((result) => result.passed) ? 'passed' : 'failed';
        delete sim.reason;
        if (command === 'run') {
            sim.knownFailureReproduced = simulation.reduction?.result.failure?.invariant === 'replica_identity_collision';
            if (!sim.knownFailureReproduced || !simulation.reduction?.oneActionMinimal || !simulation.fixedReplay?.passed) sim.status = 'failed';
        }
        if (command === 'minimize' && simulation.reduction?.result.failure) sim.status = 'passed';
    }
    if (!options.simulatedOnly) {
        const db = await dbAvailable(); const worker = await exists('build/native/worker/concord-worker');
        const gateway = await exists('rust/target/release/sync-gateway');
        const key = await exists('.agent/scratch/phase-3/e2e-key.der');
        const brokers = await Promise.all([tcp(4222), tcp(6379)]);
        await runLane('convergence', 'PostgreSQL commit ordering and native reconstruction', 'cargo', ['test', '--manifest-path', 'rust/Cargo.toml', '--test', 'convergence_invariants', '--', '--test-threads=1', '--nocapture'], {}, [['concord_test PostgreSQL', db], ['native worker', worker], ['Cargo toolchain', cargoReady], ['working native SDK', compilerReady]]);
        await runLane('compaction', 'Stale client after real snapshot compaction', 'cargo', ['test', '--manifest-path', 'rust/Cargo.toml', '--test', 'phase5_resync', '--', '--test-threads=1', '--nocapture'], {}, [['concord_test PostgreSQL', db], ['native worker', worker], ['Cargo toolchain', cargoReady], ['working native SDK', compilerReady], ['test JWKS (node scripts/ci/generate-e2e-keys.mjs)', key]]);
        await runLane('realtime', 'Real gateway restart, ACK interruption and transport recovery', process.execPath,
            [vitest, 'run', '--project', 'realtime', '--reporter=json', `--outputFile=${path.join(options.output, 'realtime.tests.json')}`], {},
            [['concord_test PostgreSQL', db], ['release gateway', gateway], ['test JWKS', key], ['NATS on loopback 4222', brokers[0]], ['Redis on loopback 6379', brokers[1]]]);
        const playwright = await import('@playwright/test').catch(() => null);
        const browserRequired = [['native worker', worker], ['release gateway', gateway], ['browser worker bundle', await exists('public/crdt-worker.js')], ['browser WASM assets', await exists('public/wasm/concord-crdt.wasm') && await exists('public/wasm/concord-crdt.js')], ['installed Chromium (npx playwright install chromium)', Boolean(playwright) && await exists(playwright.chromium.executablePath())], ['NATS on loopback 4222', brokers[0]], ['Redis on loopback 6379', brokers[1]], ['dedicated Clerk test publishable key', /^pk_test_/.test(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '')], ['dedicated Clerk test secret', /^sk_test_/.test(process.env.CLERK_SECRET_KEY ?? '')]];
        for (const [id, script, label, evidence] of [
            ['browser-tabs', 'rich-text', 'Real Chromium: shared IndexedDB tabs and stale worker upgrade', 'output/playwright/rich-text/report.json'],
            ['browser-acceptance', 'review-branches', 'Real Chromium: crash after merge acceptance and retry', 'output/playwright/review-branches/report.json'],
        ]) {
            const lane = await runLane(id, label, process.execPath, [`scripts/e2e/${script}.mjs`, ...(options.headed ? ['--headed'] : [])], { CONCORD_E2E_MODE: 'production' }, browserRequired, 'browser');
            if (lane.status === 'passed') {
                const browserResult = JSON.parse(await fs.readFile(evidence, 'utf8'));
                if (!browserResult.passed) lane.status = 'failed';
                lane.passed = browserResult.stages.length;
                lane.stages = browserResult.stages;
            }
        }
    }
} catch (error) {
    lanes.push({ id: 'runner', label: 'Lab execution', kind: 'runner', status: 'failed', reason: error instanceof Error ? error.message : String(error) });
} finally {
    report.finishedAt = new Date().toISOString();
    report.status = lanes.some((lane) => lane.status === 'failed') ? 'failed' : lanes.some((lane) => lane.status !== 'passed') ? 'incomplete' : 'passed';
    report.simulation = simulation;
    await fs.writeFile(path.join(options.output, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(options.output, 'index.html'), renderReport(report));
    await lock.close(); await fs.unlink(lockPath);
}
console.log(`[failure-lab] ${report.status.toUpperCase()} (${report.coverage})`);
console.log(`[failure-lab] Interactive report: ${path.join(options.output, 'index.html')}`);
process.exitCode = report.status === 'passed' ? 0 : report.status === 'incomplete' ? 2 : 1;
