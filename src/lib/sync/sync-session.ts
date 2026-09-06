/**
 * Sync session — the collaboration runtime for one document (P3-M034).
 *
 * Orchestrates the Phase 2 worker runtime and the network transport:
 *
 *   connect → authenticate → join(state summary) → catch-up (sync batches)
 *   → apply remote ops idempotently (worker) → resend unacked local ops
 *   → READY → live ops flow (local → outbox → client_ops → durable_ack;
 *   peer fanout → worker.applyRemote → editor render)
 *
 * On reconnect the same flow reruns; unacked ops resend under their
 * ORIGINAL identities (M032/M034 non-negotiables). The Phase 1 content
 * mirror continues as a degraded fallback while disconnected.
 */

import { identityFromOpBytes, type OpIdentityString } from "./identities";
import { PendingOpStore } from "./pending-store";
import { SyncTransport, type ConnectionStatus } from "./transport";

export interface CrdtEnginePort {
  /** Applies remote canonical op bytes (idempotent). */
  applyRemote(ops: Uint8Array[]): Promise<{ applied: number; duplicates: number }>;
  /** The local replica id (for the join state summary). */
  replicaId(): Promise<string>;
  /** Highest contiguous local counter (own summary entry). */
  localSummary(): Promise<string>;
  /** Subscribes to locally generated canonical op bytes. */
  onLocalOps(handler: (ops: Uint8Array[]) => void): () => void;
}

export interface SyncSessionOptions {
  documentId: string;
  gatewayUrl: string;
  getToken: () => Promise<string>;
  engine: CrdtEnginePort;
  /** Persisted server-seq cursor ("0" when unknown). */
  getCursor: () => string;
  setCursor: (cursor: string) => void;
  /** Outbox (IndexedDB); opened by the session when not provided (tests). */
  store?: PendingOpStore;
  onStatus?: (status: ConnectionStatus) => void;
}

/** Batching window for outgoing local ops (ms). */
const OUTBOX_FLUSH_MS = 30;
/** Max ops per client_ops batch (protocol limit). */
const MAX_BATCH = 512;

export class SyncSession {
  private readonly transport: SyncTransport;
  private store: PendingOpStore | null = null;
  private storeReady: Promise<PendingOpStore>;
  private disposed = false;
  private nextBatchId = 1;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCursor: string;
  private unsubscribeLocal: (() => void) | null = null;
  /** Ops buffered from the engine waiting for the flush window. */
  private pendingFlush: Uint8Array[] = [];
  /** Sets of op identities currently marked sent, by batch id. */
  private sentBatches = new Map<string, OpIdentityString[]>();

  constructor(private readonly options: SyncSessionOptions) {
    this.lastCursor = options.getCursor();
    this.storeReady = options.store
      ? Promise.resolve(options.store)
      : PendingOpStore.open(options.documentId);
    this.transport = new SyncTransport({
      url: options.gatewayUrl,
      getToken: options.getToken,
      events: {
        onStatus: (s) => options.onStatus?.(s),
        onDurableAck: (batchId, opIds) => void this.handleDurableAck(batchId, opIds),
        // Reconnect flow (M034): authenticated → join(state summary) →
        // catch-up from the persisted cursor → sync_done → READY → resend.
        onAuthenticated: () => void this.joinWithSummary(),
        onPeerOps: (ops) => void this.applyRemoteOps(ops),
        onSyncBatch: (ops, nextCursor, hasMore) => {
          this.lastCursor = nextCursor.toString();
          options.setCursor(this.lastCursor);
          void this.applyRemoteOps(ops);
          void hasMore;
        },
        onJoinAccepted: () => this.requestCatchup(),
        onSyncDone: () => void this.onReady(),
        onError: (code, message) => {
          // database_unavailable / server_draining keep pending ops; the
          // transport reconnects. Non-fatal errors never clear the outbox.
          void code;
          void message;
        },
        onDraining: () => {},
        onFatal: () => {
          // Fatal (unauthorized/version): the session stops retrying —
          // UI surfaces the status; user action decides.
        },
      },
    });
  }

  /** Join with the local state summary (own replica coverage). */
  private async joinWithSummary(): Promise<void> {
    try {
      const replicaId = await this.options.engine.replicaId();
      const sequence = await this.options.engine.localSummary();
      this.transport.joinDocument(this.options.documentId, [
        { replicaId, sequence },
      ]);
    } catch {
      // Engine not ready — the transport reconnect loop will retry the
      // full handshake; no partial join.
    }
  }

  /** Called by the transport when join_accepted arrives: request catch-up. */
  private requestCatchup(): void {
    this.transport.requestSync(this.lastCursor);
  }

  get status(): ConnectionStatus {
    return this.transport.currentStatus;
  }

  /** Starts the session (connect + handshake + join + catch-up). */
  async start(): Promise<void> {
    this.store = await this.storeReady;
    this.unsubscribeLocal = this.options.engine.onLocalOps((ops) => {
      void this.enqueueLocal(ops);
    });
    this.transport.connect();
  }

  /** Clean stop (navigation/logout): cancels timers, closes transport. */
  async stop(): Promise<void> {
    this.disposed = true;
    this.unsubscribeLocal?.();
    this.unsubscribeLocal = null;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.transport.close();
    this.store?.close();
  }

  // ------------------------------------------------------------------ outbound

  /** Local ops from the engine: persist pending FIRST, then flush later. */
  private async enqueueLocal(ops: Uint8Array[]): Promise<void> {
    if (this.disposed || ops.length === 0) {
      return;
    }
    const store = this.store ?? (await this.storeReady);
    for (const op of ops) {
      const identity = identityFromOpBytes(op);
      if (identity === null) {
        // Structurally invalid local op — a programming error; drop loudly.
        console.error("[sync] local op missing identity; not persisted");
        continue;
      }
      await store.addPending(`${identity.replica}:${identity.counter}`, op);
    }
    this.pendingFlush.push(...ops);
    if (this.transport.currentStatus === "ready") {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushOutbox();
    }, OUTBOX_FLUSH_MS);
  }

  /** Sends one bounded batch of unacked ops under stable identities. */
  private async flushOutbox(): Promise<void> {
    if (this.transport.currentStatus !== "ready" || this.disposed) {
      return;
    }
    const store = this.store ?? (await this.storeReady);
    const unacked = await store.unackedOps();
    if (unacked.length === 0) {
      return;
    }
    // Stable order; batch identity list kept for the matching durable_ack.
    const batch = unacked.slice(0, MAX_BATCH);
    const batchId = this.nextBatchId++;
    const ids = batch.map((record) => record.id.split(":").slice(-2).join(":"));
    try {
      this.transport.sendClientOps(batchId, batch.map((r) => r.op));
    } catch {
      return; // not open: reconnect flow will resend
    }
    await store.markSent(ids);
    this.sentBatches.set(batchId.toString(), ids);
  }

  // ------------------------------------------------------------------ inbound

  private async applyRemoteOps(ops: Uint8Array[]): Promise<void> {
    if (ops.length === 0 || this.disposed) {
      return;
    }
    // The worker applies idempotently (dedup inside the engine) — order
    // independence is a CRDT guarantee, not a transport one.
    await this.options.engine.applyRemote(ops);
  }

  private async onReady(): Promise<void> {
    // Full reconnect semantics (M034): catch-up finished — now resend every
    // still-unacked local op (same identities; server dedups).
    await this.flushOutbox();
  }

  private async handleDurableAck(batchId: string, opIds: OpIdentityString[]): Promise<void> {
    const store = this.store ?? (await this.storeReady);
    await store.markDurablyAcked(opIds);
    // Once durably acked AND the cursor persisted past them, records are
    // safe to compact — but keep them until the next catch-up confirms.
    const sent = this.sentBatches.get(batchId);
    if (sent !== undefined) {
      this.sentBatches.delete(batchId);
    }
    // Continue flushing any ops generated while the batch was in flight.
    void this.flushOutbox();
  }
}
