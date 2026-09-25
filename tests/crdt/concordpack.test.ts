import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ConcordPackError,
  decodeConcordPack,
  encodeConcordPack,
  exportConcordPack,
  previewConcordPack,
  type ConcordPackClient,
} from "@/lib/crdt/concordpack";
import { ConcordEngine } from "@/lib/crdt/runtime";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function loadFactory() {
  const source = await readFile(path.join(repoRoot, "wasm/dist/concord-crdt.js"), "utf8");
  const binary = await readFile(path.join(repoRoot, "wasm/dist/concord-crdt.wasm"));
  const load = new Function(`${source}; return loadConcordCrdt;`)();
  return (await load({
    instantiateWasm(info: WebAssembly.Imports, receiveInstance: (instance: WebAssembly.Instance) => void) {
      WebAssembly.instantiate(binary, info).then((result) => receiveInstance(result.instance));
      return {};
    },
  })) as never;
}

class EngineClient implements ConcordPackClient {
  readonly ops: Uint8Array[] = [];

  private constructor(
    private engine: ConcordEngine,
  ) {}

  static async create(replicaId: bigint): Promise<EngineClient> {
    return new EngineClient(await ConcordEngine.create(replicaId, loadFactory));
  }

  async localInsertText(index: number, codepoint: number): Promise<void> {
    this.ops.push(this.engine.localInsertText(index, codepoint));
  }

  async exportSnapshot(): Promise<Uint8Array> {
    return this.engine.exportSnapshot();
  }

  async exportOps(): Promise<Uint8Array[]> {
    return this.ops.map((op) => op.slice());
  }

  async digest(): Promise<string> {
    return this.engine.digest();
  }

  visibleJson(): string {
    return this.engine.visibleJson();
  }

  close(): void {
    this.engine.free();
  }
}

describe("Concord portable pack", () => {
  it("round-trips the snapshot, retained operations, and canonical state", async () => {
    const source = await EngineClient.create(7n);
    try {
      await source.localInsertText(0, 0x68);
      await source.localInsertText(1, 0x69);
      const pack = await exportConcordPack(source, loadFactory);
      const decoded = await decodeConcordPack(pack);

      expect(decoded.ops).toHaveLength(2);
      expect(decoded.stateDigest).toBe(await source.digest());
      const preview = await previewConcordPack(pack, loadFactory);
      expect(preview.state.stateDigest).toBe(await source.digest());
      expect(preview.visibleJson).toBe(source.visibleJson());
    } finally {
      source.close();
    }
  });

  it("rejects tampered and truncated payloads", async () => {
    const source = await EngineClient.create(12n);
    try {
      await source.localInsertText(0, 0x61);
      const pack = await exportConcordPack(source, loadFactory);
      const damaged = pack.slice();
      damaged[damaged.length - 1] ^= 1;
      await expect(decodeConcordPack(damaged)).rejects.toBeInstanceOf(ConcordPackError);
      await expect(decodeConcordPack(pack.slice(0, -1))).rejects.toBeInstanceOf(ConcordPackError);
    } finally {
      source.close();
    }
  });

  it("rejects a false canonical digest before exposing content", async () => {
    const source = await EngineClient.create(13n);
    try {
      await source.localInsertText(0, 0x61);
      const state = {
        snapshot: await source.exportSnapshot(),
        ops: await source.exportOps(),
        stateDigest: `sha256:${"0".repeat(64)}`,
      };
      const pack = await encodeConcordPack(state);
      await expect(previewConcordPack(pack, loadFactory)).rejects.toThrow("state digest mismatch");
    } finally {
      source.close();
    }
  });
});
