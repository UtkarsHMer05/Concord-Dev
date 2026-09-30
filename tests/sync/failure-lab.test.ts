import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { traceSchema, runTrace, minimizeTrace, scenarios } from "./failure-lab";

describe("reproducible failure lab", () => {
    it("replays exact engine bytes and exposes pending, interrupted ACK and converged states", { timeout: 30_000 }, async () => {
        const result = await runTrace(scenarios[0]);
        expect(result.failure).toBeNull();
        expect(result.observations.some((o) => o.clients.some((c) => c.pending + c.sent > 0))).toBe(true);
        expect(result.wire.some((frame) => frame.kind === "acknowledgement interrupted after commit")).toBe(true);
        const replay = await runTrace(result.trace);
        expect(replay.trace.operations).toEqual(result.trace.operations);
        expect(replay.observations).toEqual(result.observations);
        expect(replay.wire).toEqual(result.wire);
        expect(replay.scheduleHash).toBe(result.scheduleHash);
        const final = replay.observations.at(-1)!;
        expect(final.clients.every((c) => c.digest === final.gatewayDigest && c.pending + c.sent === 0)).toBe(true);
        // This schedule re-delivers cursor 2 after cursor 3. The real session
        // must not rely on a callback silently clamping a decreasing cursor.
        const duplicates = await runTrace(scenarios[2]);
        expect(duplicates.failure).toBeNull();
    });
    it("reduces the historical replica-alias failure and passes the same actions with distinct identities", { timeout: 30_000 }, async () => {
        const legacy = { ...scenarios[2], mode: "legacy-replica-alias" as const };
        const reduction = await minimizeTrace(legacy);
        expect(reduction.result.failure?.invariant).toBe("replica_identity_collision");
        expect(reduction.reducedActions).toBe(2);
        expect(reduction.oneActionMinimal).toBe(true);
        const fixed = await runTrace({ ...reduction.result.trace, mode: "fixed", operations: [] });
        expect(fixed.passed).toBe(true);
        expect(fixed.scheduleHash).toBe(reduction.result.scheduleHash);
    });
    it("rejects oversized schedules, malformed bytes and mismatched replay bytes", async () => {
        expect(() => traceSchema.parse({ ...scenarios[0], actions: Array(201).fill({ kind: "recover" }) })).toThrow();
        expect(() => traceSchema.parse({ ...scenarios[0], operations: [{ step: 0, client: 0, identity: "101:1", bytes: "<script>" }] })).toThrow();
        const saved = await runTrace(scenarios[1]);
        const changed = { ...saved.trace, operations: saved.trace.operations.map((op) => ({ ...op, bytes: "AAAA" })) };
        expect((await runTrace(changed)).failure?.invariant).toBe("trace_bytes_mismatch");
    });
    it.runIf(Boolean(process.env.CONCORD_LAB_OUTPUT))("writes CLI execution, replay or minimized evidence", { timeout: 120_000 }, async () => {
        const output = process.env.CONCORD_LAB_OUTPUT!;
        await mkdir(output, { recursive: true });
        let results;
        let reduction;
        let fixedReplay;
        if (process.env.CONCORD_LAB_INPUT) {
            const bytes = await readFile(process.env.CONCORD_LAB_INPUT);
            if (bytes.length > 2 * 1024 * 1024) throw new Error("Trace exceeds the 2 MiB limit");
            const trace = traceSchema.parse(JSON.parse(bytes.toString("utf8")));
            if (process.env.CONCORD_LAB_ACTION === "minimize") { reduction = await minimizeTrace(trace); results = [reduction.result]; }
            else results = [await runTrace(trace)];
        } else {
            results = [];
            for (const trace of scenarios) results.push(await runTrace(trace));
            reduction = await minimizeTrace({ ...scenarios[2], mode: "legacy-replica-alias" });
            fixedReplay = await runTrace({ ...reduction.result.trace, mode: "fixed", operations: [] });
            await writeFile(path.join(output, "known-failure.trace.json"), JSON.stringify(reduction.result.trace, null, 2));
            await writeFile(path.join(output, "fixed.trace.json"), JSON.stringify(fixedReplay.trace, null, 2));
        }
        for (const [i, result] of results.entries()) await writeFile(path.join(output, `scenario-${i + 1}.trace.json`), JSON.stringify(result.trace, null, 2));
        if (reduction) await writeFile(path.join(output, "minimized.trace.json"), JSON.stringify(reduction.result.trace, null, 2));
        await writeFile(path.join(output, "simulation.json"), JSON.stringify({ results, reduction, fixedReplay }, null, 2));
        expect(results.length).toBeGreaterThan(0);
    });
});
