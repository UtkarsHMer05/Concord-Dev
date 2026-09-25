// Time-travel replay of a document's retained durable op log (read-only).
//
// The CRDT apply path is permutation-invariant, so folding any PREFIX of the
// client's arrival-ordered log reconstructs the state as of that point — the
// same fold the gateway's snapshot builder performs, run locally in WASM.
// The replay engine is a temporary instance (reserved maintenance replica,
// exactly like gateway reconstruction) and never touches the live editor.
//
// Stepping uses the same anchoring trick as the gateway: checkpoint snapshots
// every ~√n operations bound both rebase cost (≤ stride applies) and memory
// (≈ √n snapshots), so arbitrary jumps stay cheap for large logs.
import { ConcordEngine } from "./runtime";
import type { LoadConcordCrdtFactory } from "./wasm-types";

export interface ReplayState {
  /** Canonical visible JSON of the document at this prefix length. */
  json: string;
  /** Canonical CRDT digest at this prefix length. */
  digest: string;
}

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcordReplayError";
  }
}

/** Bounded read-side cache: rendered states are derivable, never authoritative. */
const MAX_STATE_CACHE_ENTRIES = 64;

function strideFor(opCount: number): number {
  return Math.max(8, Math.ceil(Math.sqrt(Math.max(opCount, 1))));
}

export class DocumentReplay {
  private engine: ConcordEngine | null = null;
  private position = -1;
  private closed = false;
  private readonly checkpoints = new Map<number, Uint8Array>();
  private readonly states = new Map<number, ReplayState>();

  private constructor(
    private readonly ops: Uint8Array[],
    private readonly factory: LoadConcordCrdtFactory,
    private readonly stride: number,
  ) {}

  /** Number of replayable positions: 0 (empty document) .. ops.length. */
  get length(): number {
    return this.ops.length;
  }

  static async open(
    ops: Uint8Array[],
    loadFactory: LoadConcordCrdtFactory,
  ): Promise<DocumentReplay> {
    if (!Array.isArray(ops) || ops.length > 4_000_000) {
      throw new ReplayError("operation log is invalid");
    }
    for (const op of ops) {
      if (!(op instanceof Uint8Array) || op.length === 0) {
        throw new ReplayError("operation log contains an invalid entry");
      }
    }
    const replay = new DocumentReplay(ops, loadFactory, strideFor(ops.length));
    try {
      replay.engine = await ConcordEngine.create(1n, loadFactory);
    } catch (cause) {
      throw new ReplayError(cause instanceof Error ? cause.message : "replay engine unavailable");
    }
    replay.position = 0;
    replay.checkpoints.set(0, await replay.engine.exportSnapshot());
    return replay;
  }

  /** State after the first `index` operations. Forward steps apply
   *  incrementally; backward jumps rebase from the nearest earlier
   *  checkpoint snapshot and re-apply at most `stride` operations. */
  async at(index: number): Promise<ReplayState> {
    if (this.closed) throw new ReplayError("replay is closed");
    if (!Number.isInteger(index) || index < 0 || index > this.ops.length) {
      throw new ReplayError("replay index out of range");
    }
    const cached = this.states.get(index);
    if (cached && this.position === index) return cached;

    await this.positionAt(index);
    const engine = this.requireEngine();
    const state: ReplayState = { json: engine.visibleJson(), digest: engine.digest() };
    if (!state.digest.startsWith("sha256:")) {
      throw new ReplayError("replay produced an invalid state");
    }
    this.states.set(index, state);
    if (this.states.size > MAX_STATE_CACHE_ENTRIES) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined && oldest !== index && oldest !== 0) this.states.delete(oldest);
    }
    return state;
  }

  close(): void {
    this.closed = true;
    this.engine?.free();
    this.engine = null;
    this.position = -1;
    this.checkpoints.clear();
    this.states.clear();
  }

  private requireEngine(): ConcordEngine {
    if (!this.engine) throw new ReplayError("replay is closed");
    return this.engine;
  }

  private async positionAt(index: number): Promise<void> {
    if (this.position === index) return;
    if (this.position > index || this.position < 0) {
      let base = 0;
      for (
        let candidate = index - (index % this.stride);
        candidate > 0;
        candidate -= this.stride
      ) {
        if (this.checkpoints.has(candidate)) { base = candidate; break; }
      }
      const snapshot = this.checkpoints.get(base);
      if (!snapshot) throw new ReplayError("replay checkpoint is missing");
      this.requireEngine().free();
      let rebased: ConcordEngine;
      try {
        rebased = await ConcordEngine.importFromSnapshot(1n, snapshot, this.factory);
      } catch (cause) {
        throw new ReplayError(cause instanceof Error ? cause.message : "replay rebase failed");
      }
      // close() can win the race while the rebase snapshot import is in
      // flight (e.g. the panel unmounts mid-jump); drop the freshly built
      // engine instead of resurrecting a closed replay and leaking it.
      if (this.closed) {
        rebased.free();
        throw new ReplayError("replay is closed");
      }
      this.engine = rebased;
      this.position = base;
    }
    const engine = this.requireEngine();
    while (this.position < index) {
      // "duplicate" cannot occur in a clean prefix replay of unique
      // identities; tolerate it defensively so a corrupted log degrades
      // to a best-effort view instead of wedging the scrubber.
      engine.applyRemote(this.ops[this.position]);
      this.position += 1;
      if (this.position % this.stride === 0 && !this.checkpoints.has(this.position)) {
        this.checkpoints.set(this.position, await engine.exportSnapshot());
      }
    }
  }
}
