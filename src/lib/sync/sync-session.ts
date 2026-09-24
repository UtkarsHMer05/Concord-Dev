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
import {
  performSnapshotResync,
  type SnapshotEnvelope,
  SnapshotResyncError,
} from "./snapshot-resync";
import type { SnapshotPayload, SnapshotResyncRequired } from "./protocol";
import type { ErrorCode } from "./protocol";
import { SyncTransport, type ConnectionStatus } from "./transport";

export interface CrdtEnginePort {
  /** Applies ops; catch-up batches also atomically persist their cursor. */
  applyRemote(ops: Uint8Array[], cursor?: string): Promise<{ applied: number; duplicates: number }>;
  /** Durable cursor in the same database as the CRDT op log. */
  syncCursor?(): Promise<string>;
  /** Persists a resync snapshot boundary after the base and pending ops land. */
  persistCursor?(cursor: string): Promise<void>;
  /** The local replica id (for the join state summary). */
  replicaId(): Promise<string>;
  /** Highest contiguous local counter (own summary entry). */
  localSummary(): Promise<string>;
  /** Subscribes to locally generated canonical op bytes. */
  onLocalOps(handler: (ops: Uint8Array[]) => void): () => void;
  /** Durable own-replica log for repairing worker-log/outbox crash gaps. */
  localOpsSince?(counter: string): Promise<{ ops: Uint8Array[]; nextCounter: string }>;
}

/**
 * Snapshot-resync extension of the engine port (P5-M031). The resync
 * flow REPLACES the local engine base with the server snapshot, so the
 * port must expose atomic import + the unsynced-op set (which the flow
 * captures before import and re-applies after — a client never loses
 * its own unacked work to a resync).
 */
export interface ResyncEnginePort extends CrdtEnginePort {
  /** Replaces the local engine base with the inner snapshot bytes. */
  importSnapshot(inner: Uint8Array): Promise<void>;
  /** The UNSYNCED outbox set (pending + sent, never durably acked). */
  unackedOps(): Promise<Uint8Array[]>;
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
  onError?: (code: ErrorCode, message: string) => void;
  onLocalError?: (message: string) => void;
  onOutboxState?: (state: {
    pending: number;
    sent: number;
    durablyAcked: number;
    serverConfirmed: boolean;
  }) => void;
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
  private enqueueTail: Promise<void> = Promise.resolve();
  private inboundTail: Promise<void> = Promise.resolve();
  private catchupFailed = false;
  private catchupComplete = false;
  private serverConfirmed = false;
  /**
   * Snapshot resync (P5-M031): the signal the server last sent while the
   * fetch was in flight. A payload that does not match the outstanding
   * signal (envelope↔signal cross-check) is rejected — a stale or
   * mismatched payload can never replace the local base.
   */
  private resyncSignal: SnapshotResyncRequired | null = null;

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
        onDurableAck: (batchId, opIds) => {
          void this.handleDurableAck(batchId, opIds).catch((error: unknown) => {
            this.reportLocalError(error);
            this.transport.reconnect();
          });
        },
        // Reconnect flow (M034): authenticated → join(state summary) →
        // catch-up from the persisted cursor → sync_done → READY → resend.
        onAuthenticated: () => {
          this.catchupFailed = false;
          this.catchupComplete = false;
          this.serverConfirmed = false;
          // Repair any worker-log/outbox gap before the server accepts our
          // state summary. This also retries a previously failed outbox write.
          this.enqueueTail = this.enqueueTail
            .then(() => this.recoverOutbox(), () => this.recoverOutbox());
          void this.enqueueTail.then(() => this.joinWithSummary()).catch((error: unknown) => {
            this.reportLocalError(error);
            this.transport.reconnect();
          });
        },
        onPeerOps: (ops) => this.queueRemote(ops),
        onSyncBatch: (ops, nextCursor, hasMore) => {
          this.queueRemote(ops, nextCursor.toString());
          void hasMore;
        },
        onJoinAccepted: () => this.requestCatchup(),
        onSyncDone: () => {
          void this.onReady().catch((error: unknown) => {
            this.reportLocalError(error);
            this.transport.reconnect();
          });
        },
        // Stale-client resync (P5-M031): a cursor below the compaction
        // floor cannot be served by delta catch-up. The server points
        // us at the covering snapshot; we fetch, validate
        // (checksum-before-trust), import atomically, re-apply our own
        // unacked ops, then resume catch-up from the boundary.
        onSnapshotResyncRequired: (signal) => void this.beginSnapshotResync(signal),
        onSnapshotPayload: (payload) => {
          void this.handleSnapshotPayload(payload).catch((error: unknown) => {
            this.reportLocalError(error);
            this.transport.reconnect();
          });
        },
        onError: (code, message) => {
          options.onError?.(code, message);
          // A failed catch-up has no sync_done. Reconnect so the durable
          // cursor is retried with backoff; ready sessions retain their
          // outbox and show the error without starting a retry loop.
          if (
            code === "database_unavailable" &&
            this.transport.currentStatus === "syncing"
          ) {
            this.transport.reconnect();
          }
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
    this.serverConfirmed = false;
    if (this.options.engine.syncCursor) {
      this.lastCursor = await this.options.engine.syncCursor();
    }
    // Subscribe before scanning: edits made during recovery are queued behind
    // it, while duplicate notifications retain the existing outbox state.
    this.enqueueTail = this.recoverOutbox();
    this.unsubscribeLocal = this.options.engine.onLocalOps((ops) => {
      this.enqueueTail = this.enqueueTail.then(
        () => this.enqueueLocal(ops),
        async () => {
          await this.recoverOutbox();
          await this.enqueueLocal(ops);
        },
      );
      void this.enqueueTail.catch((error: unknown) => {
        this.reportLocalError(error);
      });
    });
    try {
      await this.enqueueTail;
    } catch (error) {
      // The worker log is still durable. Connect so authenticated retries can
      // backfill it before joining or sending any operations.
      this.reportLocalError(error);
    }
    await this.reportOutboxState(false);
    this.transport.connect();
  }

  private async recoverOutbox(): Promise<void> {
    if (!this.options.engine.localOpsSince) return;
    const store = this.store ?? (await this.storeReady);
    if (typeof store.lastSeenCounter !== "function") return;
    const since = await store.lastSeenCounter();
    const { ops } = await this.options.engine.localOpsSince(since);
    await this.enqueueLocal(ops);
    if (ops.length === 0) await this.reportOutboxState(false);
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
    try {
      await this.enqueueTail;
    } catch {
      // A failed outbox write remains recoverable from the worker log.
    }
    this.store?.close();
  }

  private reportLocalError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.options.onLocalError?.(message);
    console.error("[sync] local durability operation failed:", message);
  }

  // ------------------------------------------------------------------ outbound

  /** Local ops from the engine: persist pending FIRST, then flush later. */
  private async enqueueLocal(ops: Uint8Array[]): Promise<void> {
    if (this.disposed || ops.length === 0) {
      return;
    }
    this.serverConfirmed = false;
    const store = this.store ?? (await this.storeReady);
    try {
      for (const op of ops) {
        const identity = identityFromOpBytes(op);
        if (identity === null) {
          // Structurally invalid local op — a programming error; drop loudly.
          console.error("[sync] local op missing identity; not persisted");
          continue;
        }
        await store.addPending(`${identity.replica}:${identity.counter}`, op);
      }
    } finally {
      await this.reportOutboxState(false);
    }
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
      void this.flushOutbox().catch((error: unknown) => this.reportLocalError(error));
    }, OUTBOX_FLUSH_MS);
  }

  /** Sends one bounded batch of unacked ops under stable identities. */
  private async flushOutbox(): Promise<void> {
    if (this.transport.currentStatus !== "ready" || !this.catchupComplete || this.disposed) {
      return;
    }
    const store = this.store ?? (await this.storeReady);
    const unacked = await store.unackedOps();
    if (unacked.length === 0) {
      return;
    }
    // Stable order; the operation identities remain in the durable outbox
    // until their individual durable ACKs arrive.
    const batch = unacked.slice(0, MAX_BATCH);
    const batchId = this.nextBatchId++;
    const ids = batch.map((record) => record.id.split(":").slice(-2).join(":"));
    try {
      this.transport.sendClientOps(batchId, batch.map((r) => r.op));
    } catch {
      return; // not open: reconnect flow will resend
    }
    await store.markSent(ids);
    await this.reportOutboxState(false);
  }

  // ------------------------------------------------------------------ resync (P5-M031)

  /** The server demands snapshot resync (cursor below the compaction
   * floor). Records the signal and fetches the covering snapshot. The
   * engine port must support resync (importSnapshot + unackedOps) —
   * otherwise the session logs loudly and reconnects (a future catch-up
   * attempt re-triggers the signal; no silent divergence). */
  private beginSnapshotResync(signal: SnapshotResyncRequired): void {
    const engine = this.options.engine as ResyncEnginePort;
    if (
      typeof engine.importSnapshot !== "function" ||
      typeof engine.unackedOps !== "function"
    ) {
      console.error("[sync] engine port lacks snapshot-resync support; ignoring resync signal");
      return;
    }
    this.resyncSignal = signal;
    this.transport.fetchSnapshot(signal.snapshotId);
  }

  /** The fetched snapshot arrived: cross-check against the outstanding
   * signal, validate integrity (checksum-before-trust), import
   * atomically, re-apply unacked local ops, resume catch-up. */
  private async handleSnapshotPayload(payload: SnapshotPayload): Promise<void> {
    const signal = this.resyncSignal;
    this.resyncSignal = null;
    if (signal === null || this.disposed) {
      return; // unsolicited payload: ignore (never replace the base unasked)
    }
    const engine = this.options.engine as ResyncEnginePort;
    // Envelope adaptation: the WS frame IS the envelope source (the
    // snake_case HTTP-shape fields the validator expects; SEC5-3 made
    // payload_size a wire field so the size check is live here).
    const envelope: SnapshotEnvelope = {
      snapshotId: payload.snapshotId,
      formatVersion: Number(payload.formatVersion),
      coverageSeq: payload.coverageSeq,
      coveredOpCount: payload.coveredOpCount,
      checksum: payload.checksum,
      payloadBase64: payload.payloadBase64,
      stateDigest: payload.stateDigest,
      payloadSize: payload.payloadSize,
    };
    // Signal↔payload agreement: the fetched snapshot must be exactly the
    // one the server announced (id, checksum, boundary, op count) — a
    // mismatched payload is a protocol fault, never an import trigger.
    if (
      payload.snapshotId !== signal.snapshotId ||
      payload.checksum !== signal.snapshotChecksum ||
      payload.coverageSeq !== signal.boundary ||
      payload.coveredOpCount !== signal.coverageOpCount ||
      payload.formatVersion !== signal.snapshotFormatVersion
    ) {
      console.error("[sync] snapshot payload does not match the resync signal; ignoring");
      this.requestCatchup(); // re-requests catch-up → server re-signals
      return;
    }
    try {
      await performSnapshotResync({
        expectedDocumentId: this.options.documentId,
        envelope,
        engine,
        setCursor: (cursor) => this.persistCursor(cursor),
        getCursor: () => this.lastCursor,
      });
    } catch (error) {
      if (error instanceof SnapshotResyncError) {
        // Corrupt/incompatible snapshot: fail closed — the cursor is
        // unchanged, so the next catch-up re-triggers the resync signal
        // (and the server's fetch budget bounds the retry loop).
        console.error(`[sync] snapshot resync rejected: ${error.code}`);
        return;
      }
      throw error;
    }
    // Base replaced: resume delta catch-up from the snapshot boundary.
    this.requestCatchup();
  }

  // ------------------------------------------------------------------ inbound

  private async applyRemoteOps(ops: Uint8Array[], cursor?: string): Promise<void> {
    if ((ops.length === 0 && cursor === undefined) || this.disposed) {
      return;
    }
    // The worker applies idempotently (dedup inside the engine) — order
    // independence is a CRDT guarantee, not a transport one.
    await this.options.engine.applyRemote(ops, cursor);
  }

  private async persistCursor(cursor: string): Promise<void> {
    await this.options.engine.persistCursor?.(cursor);
    this.options.setCursor(cursor);
    this.lastCursor = cursor;
  }

  private async reportOutboxState(catchupConfirmed: boolean): Promise<void> {
    const store = this.store ?? (await this.storeReady);
    if (typeof store.stateCounts !== "function") return;
    try {
      const counts = await store.stateCounts();
      this.serverConfirmed = catchupConfirmed &&
        counts.pending === 0 && counts.sent === 0 && counts.durably_acked === 0;
      this.options.onOutboxState?.({
        pending: counts.pending,
        sent: counts.sent,
        durablyAcked: counts.durably_acked,
        serverConfirmed: this.serverConfirmed,
      });
    } catch (error) {
      // A failed count read must never be rendered as an empty outbox.
      this.reportLocalError(error);
    }
  }

  private queueRemote(ops: Uint8Array[], cursor?: string): void {
    this.inboundTail = this.inboundTail.then(async () => {
      if (this.catchupFailed || this.disposed) return;
      try {
        await this.applyRemoteOps(ops, cursor);
        if (cursor !== undefined) {
          this.options.setCursor(cursor);
          this.lastCursor = cursor;
        }
      } catch (error) {
        this.catchupFailed = true;
        this.reportLocalError(error);
        this.transport.reconnect();
      }
    });
  }

  private async onReady(): Promise<void> {
    // Full reconnect semantics (M034): catch-up finished — now resend every
    // still-unacked local op (same identities; server dedups).
    await this.inboundTail;
    if (this.catchupFailed || this.disposed) return;
    this.catchupComplete = true;
    const store = this.store ?? (await this.storeReady);
    if (typeof store.ackedIds === "function") {
      const acked = await store.ackedIds();
      await store.clearAcked(acked);
    }
    await this.enqueueTail;
    await this.reportOutboxState(true);
    await this.flushOutbox();
  }

  private async handleDurableAck(_batchId: string, opIds: OpIdentityString[]): Promise<void> {
    const store = this.store ?? (await this.storeReady);
    await store.markDurablyAcked(opIds);
    this.serverConfirmed = false;
    await this.reportOutboxState(false);
    // Once durably acked AND the cursor persisted past them, records are
    // safe to compact — but keep them until the next catch-up confirms.
    // Continue flushing any ops generated while the batch was in flight.
    void this.flushOutbox().catch((error: unknown) => this.reportLocalError(error));
  }
}
