/**
 * Concord realtime sync transport — browser WebSocket client for the Rust
 * gateway (P3-M031/M033).
 *
 * Owns: connection creation, hello/authenticate handshake, document join,
 * typed frame encode/decode (src/lib/sync/protocol.ts), a connection-state
 * observable, bounded exponential backoff with jitter on reconnect, and
 * clean close. React/editor code depends on SyncSession (the collaboration
 * runtime), never on this raw transport (DEC-016 seam discipline).
 *
 * Reconnect semantics (P3-M033): bounded exponential backoff with jitter,
 * max-delay cap, immediate first retry after an unclean drop, cancellation
 * on close/navigation. Backoff computation is a pure function
 * (computeBackoffDelay) tested separately from real timers.
 */

import {
  decodeControlFrame,
  decodeDataFrame,
  encodeClientOpsFrame,
  encodeControlFrame,
  type ControlFrameType,
  type DecodedControlFrame,
  type ErrorCode,
  type PresenceState,
  type PresenceUpdate,
  type SnapshotPayload,
  type SnapshotResyncRequired,
  FATAL_ERROR_CODES,
} from "./protocol";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "authenticated"
  | "joining"
  | "syncing"
  | "ready"
  | "reconnecting"
  | "draining"
  | "closed";

export interface TransportEvents {
  /** Connection status changed. */
  onStatus: (status: ConnectionStatus) => void;
  /** A durable ack arrived for a batch we sent. */
  onDurableAck: (batchId: string, opIds: string[]) => void;
  /** Authentication succeeded (join may proceed). */
  onAuthenticated: () => void;
  /** Join accepted; catch-up should be requested with the local cursor. */
  onJoinAccepted: () => void;
  /** Peer operations arrived (client_ops fanout frame, binary). */
  onPeerOps: (ops: Uint8Array[]) => void;
  /** A catch-up batch arrived (sync_batch, binary). */
  onSyncBatch: (ops: Uint8Array[], nextCursor: number, hasMore: boolean) => void;
  /** Catch-up finished; the session is READY. */
  onSyncDone: () => void;
  /** The server demands snapshot resync: the local cursor precedes the
   * compaction floor (P5-M031). The session fetches + imports the
   * covering snapshot, then resumes delta catch-up from the boundary. */
  onSnapshotResyncRequired: (signal: SnapshotResyncRequired) => void;
  /** The requested snapshot payload arrived (P5-M031), already decoded
   * and shape-validated; the session re-validates integrity before
   * import (checksum-before-trust, defense in depth). */
  onSnapshotPayload: (payload: SnapshotPayload) => void;
  /** Safe server error (vocabulary codes only). */
  onError: (code: ErrorCode, message: string, requestId?: string) => void;
  /** The server is draining (grace window). */
  onDraining: (graceMs: number) => void;
  /** The transport gave up (fatal error or explicit close). */
  onFatal: (reason: string) => void;
  /** A peer's live presence (cursor/selection) arrived (Feature 2). */
  onPresenceUpdate?: (peer: PresenceUpdate) => void;
  /** A peer left; drop its caret (Feature 2). */
  onPresenceLeave?: (connectionId: string) => void;
}

export interface TransportOptions {
  /** Gateway WS url, e.g. ws://127.0.0.1:8787/api/v1/sync */
  url: string;
  /** Returns a fresh Clerk session JWT for authenticate (never cached long). */
  getToken: () => Promise<string>;
  events: TransportEvents;
  /** Backoff knobs (M033). Defaults are conservative for local dev. */
  backoff?: Partial<BackoffConfig>;
  /** setTimeout/clearTimeout injection for deterministic tests. */
  timers?: TimerSource;
  /** Math.random substitute for deterministic backoff tests. */
  random?: () => number;
}

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
  /** Retry immediately on the first attempt after an unclean drop. */
  immediateFirstRetry: boolean;
}

const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 250,
  maxMs: 15_000,
  immediateFirstRetry: true,
};

/** Timer abstraction so tests run backoff without real clocks. */
export interface TimerSource {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const defaultTimers: TimerSource = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as number),
};

/**
 * Pure bounded exponential backoff with jitter (P3-M033).
 * attempt 0 (with immediateFirstRetry) → 0 ms; then base * 2^n capped at
 * maxMs; jitter adds [0, 0.25) of the delay. Deterministic given
 * (attempt, config, random).
 */
export function computeBackoffDelay(
  attempt: number,
  config: BackoffConfig,
  random: () => number,
): number {
  if (attempt < 0) {
    throw new Error("attempt must be non-negative");
  }
  if (config.immediateFirstRetry && attempt === 0) {
    return 0;
  }
  const exp = config.baseMs * Math.pow(2, attempt - (config.immediateFirstRetry ? 1 : 0));
  const capped = Math.min(exp, config.maxMs);
  const jitter = Math.floor(capped * 0.25 * random());
  return capped + jitter;
}

/**
 * A single-connection sync transport with automatic reconnect.
 */
export class SyncTransport {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private attempt = 0;
  private backoffTimer: unknown = null;
  private closedByUser = false;
  private readonly backoff: BackoffConfig;
  private readonly timers: TimerSource;
  private readonly random: () => number;
  private nextCorrelation = 1;
  private draining = false;
  private authenticateInFlight = false;

  constructor(private readonly options: TransportOptions) {
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.timers = options.timers ?? defaultTimers;
    this.random = options.random ?? Math.random;
  }

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  /** Opens the connection and runs the handshake. Idempotent while open. */
  connect(): void {
    if (this.ws !== null || this.closedByUser) {
      return;
    }
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.options.url);
      ws.binaryType = "arraybuffer";
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.send("hello", { clientProtocolVersion: 1 }, undefined);
    };
    ws.onmessage = (event) => this.handleMessage(event.data);
    ws.onerror = () => {
      // onclose always follows; nothing else to do.
    };
    ws.onclose = () => this.handleUncleanClose();
  }

  /** Joins a document with the local state summary (u64 counters as strings). */
  joinDocument(
    documentId: string,
    stateSummary: Array<{ replicaId: string; sequence: string }>,
  ): void {
    this.setStatus("joining");
    this.send("join_document", { documentId, stateSummary }, `j${this.nextCorrelation++}`);
  }

  /** Requests catch-up strictly after a server cursor (decimal string). */
  requestSync(cursor: string): void {
    this.send("sync_request", { cursor }, undefined);
  }

  /** Fetches one snapshot by id for stale-client resync (P5-M031). */
  fetchSnapshot(snapshotId: string): void {
    this.send("fetch_snapshot", { snapshotId }, undefined);
  }

  /** Sends a client_ops batch (identity-stable canonical bytes). */
  sendClientOps(batchId: number, ops: Uint8Array[]): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error("transport not open");
    }
    this.ws.send(encodeClientOpsFrame({ batchId, ops }));
  }

  /** Publishes ephemeral presence (Feature 2). Best-effort: only sent when
   * READY, and a closed/opening socket silently drops it (a caret is
   * disposable — the next selectionchange re-sends). Never throws. */
  sendPresence(state: PresenceState): void {
    if (this.status !== "ready" || this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      this.ws.send(encodeControlFrame({ type: "presence", payload: state }));
    } catch {
      // A racing close: presence is disposable, drop it.
    }
  }

  /** Clean close: no reconnect (navigation/logout). */
  close(): void {
    this.closedByUser = true;
    this.clearBackoffTimer();
    if (this.ws !== null) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close(1000, "client closed");
      } catch {
        // already closing
      }
    }
    this.setStatus("closed");
  }

  // ------------------------------------------------------------------ internals

  private send(type: ControlFrameType, payload: unknown, id: string | undefined): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send(encodeControlFrame({ id, type, payload }));
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data === "string") {
      let frame: DecodedControlFrame;
      try {
        frame = decodeControlFrame(data);
      } catch {
        // Frames the browser can't decode are protocol drift — surface safely.
        this.options.events.onError("malformed_frame", "undecodable frame from server");
        return;
      }
      this.handleControlFrame(frame);
      return;
    }
    try {
      const bytes = new Uint8Array(data);
      const decoded = decodeDataFrame(bytes);
      if (decoded.kind === "client_ops") {
        this.options.events.onPeerOps(
          decoded.frame.ops.map((o) => new Uint8Array(o)),
        );
      } else {
        this.options.events.onSyncBatch(
          decoded.frame.ops.map((o) => new Uint8Array(o)),
          decoded.frame.nextCursor,
          decoded.frame.hasMore,
        );
      }
    } catch {
      this.options.events.onError("malformed_frame", "undecodable binary frame from server");
    }
  }

  private handleControlFrame(frame: DecodedControlFrame): void {
    switch (frame.type) {
      case "hello_ack":
        // Server accepted the protocol version — authenticate with a fresh
        // token (never a cached long-lived one).
        if (!this.authenticateInFlight) {
          this.authenticateInFlight = true;
          this.options
            .getToken()
            .then((token) => {
              this.authenticateInFlight = false;
              this.send("authenticate", { token }, undefined);
            })
            .catch(() => {
              this.authenticateInFlight = false;
              this.options.events.onError("unauthorized", "token retrieval failed");
              this.scheduleReconnect();
            });
        }
        break;
      case "authenticated":
        this.setStatus("authenticated");
        this.options.events.onAuthenticated();
        break;
      case "join_accepted":
        this.setStatus("syncing");
        this.options.events.onJoinAccepted();
        break;
      case "sync_done":
        // Keep accumulating backoff until the full join and catch-up succeeds.
        this.attempt = 0;
        this.setStatus("ready");
        this.options.events.onSyncDone();
        break;
      case "snapshot_resync_required":
        this.options.events.onSnapshotResyncRequired(
          frame.payload as SnapshotResyncRequired,
        );
        break;
      case "snapshot_payload":
        this.options.events.onSnapshotPayload(frame.payload as SnapshotPayload);
        break;
      case "durable_ack":
        this.options.events.onDurableAck(
          (frame.payload as { batchId: string }).batchId,
          (frame.payload as { opIds: string[] }).opIds,
        );
        break;
      case "error": {
        const payload = frame.payload as { code: ErrorCode; message: string; requestId?: string };
        this.options.events.onError(payload.code, payload.message, payload.requestId);
        if (FATAL_ERROR_CODES.has(payload.code)) {
          this.options.events.onFatal(`server rejected: ${payload.code}`);
          this.teardownSocket();
          this.setStatus("closed");
        }
        break;
      }
      case "server_draining":
        this.draining = true;
        this.setStatus("draining");
        this.options.events.onDraining((frame.payload as { graceMs: number }).graceMs);
        break;
      case "ping": {
        const nonce = (frame.payload as { nonce: string }).nonce;
        this.send("pong", { nonce }, undefined);
        break;
      }
      case "presence_update":
        this.options.events.onPresenceUpdate?.(frame.payload as PresenceUpdate);
        break;
      case "presence_leave":
        this.options.events.onPresenceLeave?.(
          (frame.payload as { connectionId: string }).connectionId,
        );
        break;
      default:
        // Server-origin frames with no client action — ignore safely.
        break;
    }
  }

  private handleUncleanClose(): void {
    if (this.closedByUser) {
      return;
    }
    this.teardownSocket();
    this.draining = false;
    this.scheduleReconnect();
  }

  /** Retry the full handshake after local catch-up persistence fails. */
  reconnect(): void {
    if (this.closedByUser) return;
    this.teardownSocket();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = computeBackoffDelay(this.attempt, this.backoff, this.random);
    this.attempt += 1;
    this.setStatus("reconnecting");
    this.clearBackoffTimer();
    this.backoffTimer = this.timers.setTimeout(() => {
      this.backoffTimer = null;
      this.connect();
    }, delay);
  }

  private clearBackoffTimer(): void {
    if (this.backoffTimer !== null) {
      this.timers.clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private teardownSocket(): void {
    if (this.ws !== null) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {
        // noop
      }
      this.ws = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.options.events.onStatus(status);
    }
  }
}
