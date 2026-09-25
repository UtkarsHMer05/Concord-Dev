import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ConcordModule } from "@/lib/crdt/wasm-types";

import { DocumentReplay, ReplayError } from "@/lib/crdt/replay";
import { ConcordEngine } from "@/lib/crdt/runtime";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let factoryPromise: Promise<ConcordModule> | null = null;

/** The runtime AWAITS the loader passed in — hand the function, not the module. */
function getFactory(): Promise<ConcordModule> {
  factoryPromise ??= (async () => {
    const source = await readFile(path.join(repoRoot, "wasm/dist/concord-crdt.js"), "utf8");
    const binary = await readFile(path.join(repoRoot, "wasm/dist/concord-crdt.wasm"));
    const load = new Function(`${source}; return loadConcordCrdt;`)();
    return (await load({
      instantiateWasm(info: WebAssembly.Imports, receiveInstance: (instance: WebAssembly.Instance) => void) {
        WebAssembly.instantiate(binary, info).then((result) => receiveInstance(result.instance));
        return {};
      },
    })) as Promise<ConcordModule>;
  })();
  return factoryPromise;
}

/** Drives one engine through edits and records every produced op. */
class SourceDocument {
  readonly ops: Uint8Array[] = [];

  private constructor(private engine: ConcordEngine) {}

  static async create(replicaId: bigint): Promise<SourceDocument> {
    return new SourceDocument(await ConcordEngine.create(replicaId, getFactory));
  }

  insertText(index: number, codepoint: number): void {
    this.ops.push(this.engine.localInsertText(index, codepoint));
  }

  insertDelimiter(index: number): void {
    this.ops.push(this.engine.localInsertDelimiter(index, "paragraph"));
  }

  async referenceState(opCount: number): Promise<{ json: string; digest: string }> {
    const reference = await ConcordEngine.create(2n, getFactory);
    try {
      for (const op of this.ops.slice(0, opCount)) reference.applyRemote(op);
      return { json: reference.visibleJson(), digest: reference.digest() };
    } finally {
      reference.free();
    }
  }

  close(): void {
    this.engine.free();
  }
}

async function buildSource(): Promise<SourceDocument> {
  const source = await SourceDocument.create(7n);
  source.insertDelimiter(0);
  for (const codepoint of "hello world".split("").map((c) => c.codePointAt(0) as number)) {
    source.insertText(source.ops.length, codepoint);
  }
  source.insertDelimiter(source.ops.length);
  for (const codepoint of "again".split("").map((c) => c.codePointAt(0) as number)) {
    source.insertText(source.ops.length, codepoint);
  }
  return source;
}

describe("document time-travel replay", () => {
  it("reconstructs every prefix exactly as an independent fold does", async () => {
    const source = await buildSource();
    try {
      const replay = await DocumentReplay.open(source.ops, getFactory);
      try {
        expect(replay.length).toBe(source.ops.length);
        for (const index of [0, 1, 5, source.ops.length - 1, source.ops.length]) {
          const state = await replay.at(index);
          const reference = await source.referenceState(index);
          expect(state.json).toBe(reference.json);
          expect(state.digest).toBe(reference.digest);
        }
      } finally {
        replay.close();
      }
    } finally {
      source.close();
    }
  });

  it("survives arbitrary jump patterns with consistent states", async () => {
    const source = await buildSource();
    try {
      const replay = await DocumentReplay.open(source.ops, getFactory);
      try {
        const seen = new Map<number, string>();
        for (const index of [source.ops.length, 0, 3, source.ops.length, 3, 7, 0, source.ops.length]) {
          const state = await replay.at(index);
          const previous = seen.get(index);
          if (previous !== undefined) expect(state.json).toBe(previous);
          seen.set(index, state.json);
        }
        // Final digest must equal the full independent fold.
        const full = await source.referenceState(source.ops.length);
        expect(seen.get(source.ops.length)).toBe(full.json);
      } finally {
        replay.close();
      }
    } finally {
      source.close();
    }
  });

  it("rejects invalid indices, invalid logs, and use after close", async () => {
    const source = await buildSource();
    try {
      const replay = await DocumentReplay.open(source.ops, getFactory);
      try {
        await expect(replay.at(-1)).rejects.toBeInstanceOf(ReplayError);
        await expect(replay.at(1.5)).rejects.toBeInstanceOf(ReplayError);
        await expect(replay.at(source.ops.length + 1)).rejects.toBeInstanceOf(ReplayError);
        replay.close();
        await expect(replay.at(0)).rejects.toBeInstanceOf(ReplayError);
        replay.close(); // idempotent
      } finally {
        replay.close();
      }
      await expect(DocumentReplay.open([new Uint8Array(0)], getFactory))
        .rejects.toBeInstanceOf(ReplayError);
      await expect(DocumentReplay.open(["nope" as never], getFactory))
        .rejects.toBeInstanceOf(ReplayError);
    } finally {
      source.close();
    }
  });
});
