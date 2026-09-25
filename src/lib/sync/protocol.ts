/**
 * Concord sync wire protocol v1 — TypeScript mirror of the Rust gateway
 * codec (P3-M012; docs/PROTOCOL.md §9, DEC-029).
 *
 * Two frame classes:
 * - Control frames: compact typed JSON *text* messages `{v, type, id?,
 *   payload}`. Strict decode — unknown version/type/shape are errors.
 * - Data frames (`clientOps`, `syncBatch`): binary with a fixed
 *   big-endian header; CRDT operation bytes travel verbatim (Phase 2
 *   canonical serialization — never re-encoded here).
 *
 * Byte-exact parity with Rust is enforced by the committed golden
 * fixtures (`fixtures/protocol/v1/golden.json`) in both test suites.
 */

export const WIRE_VERSION = 1;

// Wire limits (PROTOCOL §9.11) — mirror of rust limits.rs.
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH_OPS = 1024;
export const MAX_BATCH_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_SYNC_PAGE_OPS = 1024;
export const MAX_OP_BYTES = 64 * 1024;
export const MAX_TOKEN_BYTES = 32 * 1024;

export const BATCH_KIND_CLIENT_OPS = 0x20;
export const BATCH_KIND_SYNC = 0x21;

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "unsupported_protocol_version",
  "unknown_frame_type",
  "invalid_state",
  "malformed_frame",
  "payload_too_large",
  "rate_limited",
  "database_unavailable",
  "server_draining",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Fatal error codes close the connection after the error frame. */
export const FATAL_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "unauthorized",
  "unsupported_protocol_version",
  "payload_too_large",
]);

// ---------------------------------------------------------------------------
// Control frame payloads (camelCase — the wire contract)
// ---------------------------------------------------------------------------

export type Role = "owner" | "editor" | "commenter" | "viewer";

export interface Hello {
  clientProtocolVersion: number;
}

export interface HelloAck {
  protocolVersion: number;
  connectionId: string;
}

export interface Authenticate {
  token: string;
}

export interface Authenticated {
  userId: string;
  clerkUserId: string;
  orgId?: string;
}

export interface SummaryEntry {
  replicaId: string;
  sequence: string;
}

export interface JoinDocument {
  documentId: string;
  stateSummary: SummaryEntry[];
}

export interface JoinAccepted {
  documentId: string;
  role: Role;
  durableCursor: string;
}

export interface SyncRequest {
  cursor: string;
}

/** Empty payload marker for sync_done (no fields). */
export type SyncDone = { readonly __syncDone?: undefined };

export interface DurableAck {
  batchId: string;
  opIds: string[];
}

export interface Ping {
  nonce: string;
}

export interface Pong {
  nonce: string;
}

export interface ErrorFrame {
  code: ErrorCode;
  message: string;
  requestId?: string;
}

export interface ServerDraining {
  reason: string;
  graceMs: number;
}

/** s→c (P5-M031): the client's cursor precedes the compaction floor —
 * delta catch-up is impossible; fetch + import the covering snapshot,
 * then resume catch-up from the boundary. All u64s as decimal strings. */
export interface SnapshotResyncRequired {
  boundary: string;
  snapshotId: string;
  snapshotChecksum: string;
  snapshotFormatVersion: string;
  coverageOpCount: string;
}

/** c→s (P5-M031): fetch one snapshot by id for resync. */
export interface FetchSnapshot {
  snapshotId: string;
}

/** s→c (P5-M031): the requested snapshot, base64 wrapper bytes + the
 * metadata the client re-validates (checksum over the wrapper bytes,
 * declared size). All u64s as decimal strings. */
export interface SnapshotPayload {
  snapshotId: string;
  formatVersion: string;
  coverageSeq: string;
  coveredOpCount: string;
  stateDigest: string;
  checksum: string;
  payloadBase64: string;
  payloadSize: string;
}

/** Which side of a CRDT item a presence caret/selection endpoint sits on. */
export type PresenceSide = "before" | "after";

/** c→s (Feature 2, ephemeral): the sender's live caret/selection anchored to
 * CRDT item ids ("r:c"). `*Item` is absent when the caret cannot be anchored
 * to a live item (empty document). Relayed to peers; never persisted. */
export interface PresenceState {
  replicaId: string;
  anchorItem?: string;
  anchorSide: PresenceSide;
  headItem?: string;
  headSide: PresenceSide;
}

/** s→c: one peer's relayed presence; `connectionId`/`userId` are stamped by
 * the gateway from the authenticated session (unforgeable). */
export interface PresenceUpdate {
  connectionId: string;
  userId: string;
  replicaId: string;
  anchorItem?: string;
  anchorSide: PresenceSide;
  headItem?: string;
  headSide: PresenceSide;
}

/** s→c: a peer left the room; drop its caret. */
export interface PresenceLeave {
  connectionId: string;
}

// ---------------------------------------------------------------------------
// Frame union
// ---------------------------------------------------------------------------

export type ControlPayload =
  | { type: "hello"; payload: Hello }
  | { type: "hello_ack"; payload: HelloAck }
  | { type: "authenticate"; payload: Authenticate }
  | { type: "authenticated"; payload: Authenticated }
  | { type: "join_document"; payload: JoinDocument }
  | { type: "join_accepted"; payload: JoinAccepted }
  | { type: "sync_request"; payload: SyncRequest }
  | { type: "sync_done"; payload: SyncDone }
  | { type: "durable_ack"; payload: DurableAck }
  | { type: "ping"; payload: Ping }
  | { type: "pong"; payload: Pong }
  | { type: "fetch_snapshot"; payload: FetchSnapshot }
  | { type: "snapshot_resync_required"; payload: SnapshotResyncRequired }
  | { type: "snapshot_payload"; payload: SnapshotPayload }
  | { type: "error"; payload: ErrorFrame }
  | { type: "server_draining"; payload: ServerDraining }
  | { type: "presence"; payload: PresenceState }
  | { type: "presence_update"; payload: PresenceUpdate }
  | { type: "presence_leave"; payload: PresenceLeave };

export const CONTROL_FRAME_TYPES = [
  "hello",
  "hello_ack",
  "authenticate",
  "authenticated",
  "join_document",
  "join_accepted",
  "sync_request",
  "sync_done",
  "durable_ack",
  "ping",
  "pong",
  "fetch_snapshot",
  "snapshot_resync_required",
  "snapshot_payload",
  "error",
  "server_draining",
  "presence",
  "presence_update",
  "presence_leave",
] as const;

export type ControlFrameType = (typeof CONTROL_FRAME_TYPES)[number];

export class ProtocolDecodeError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "frame_too_large"
      | "invalid_json"
      | "bad_envelope"
      | "unsupported_version"
      | "unknown_frame_type"
      | "bad_payload"
      | "bad_binary_header"
      | "bad_binary_body",
  ) {
    super(message);
    this.name = "ProtocolDecodeError";
  }
}

// ---------------------------------------------------------------------------
// Control codec
// ---------------------------------------------------------------------------

/** Shape validators per frame type (strict: unknown keys rejected). */
const PAYLOAD_VALIDATORS: Record<ControlFrameType, (p: unknown) => string | null> = {
  hello: isStrict({ clientProtocolVersion: isUint }),
  hello_ack: isStrict({ protocolVersion: isUint, connectionId: isString }),
  authenticate: isStrict({ token: isString }),
  authenticated: isStrict({ userId: isString, clerkUserId: isString, orgId: optional(isString) }),
  join_document: isStrict({
    documentId: isString,
    stateSummary: arrayOf(isStrict({ replicaId: isString, sequence: isString })),
  }),
  join_accepted: isStrict({
    documentId: isString,
    role: isEnum("owner", "editor", "commenter", "viewer"),
    durableCursor: isString,
  }),
  sync_request: isStrict({ cursor: isString }),
  sync_done: isStrict({}),
  durable_ack: isStrict({ batchId: isString, opIds: arrayOf(isString) }),
  ping: isStrict({ nonce: isString }),
  pong: isStrict({ nonce: isString }),
  fetch_snapshot: isStrict({ snapshotId: isString }),
  // P5-M031 frames (SEC5-3: payloadSize carries the declared wrapper
  // byte length so the client's size check is live on this transport).
  snapshot_resync_required: isStrict({
    boundary: isString,
    snapshotId: isString,
    snapshotChecksum: isString,
    snapshotFormatVersion: isString,
    coverageOpCount: isString,
  }),
  snapshot_payload: isStrict({
    snapshotId: isString,
    formatVersion: isString,
    coverageSeq: isString,
    coveredOpCount: isString,
    stateDigest: isString,
    checksum: isString,
    payloadBase64: isString,
    payloadSize: isString,
  }),
  error: isStrict({ code: isEnum(...ERROR_CODES), message: isString, requestId: optional(isString) }),
  server_draining: isStrict({ reason: isString, graceMs: isUint }),
  presence: isStrict({
    replicaId: isString,
    anchorItem: optional(isString),
    anchorSide: isEnum("before", "after"),
    headItem: optional(isString),
    headSide: isEnum("before", "after"),
  }),
  presence_update: isStrict({
    connectionId: isString,
    userId: isString,
    replicaId: isString,
    anchorItem: optional(isString),
    anchorSide: isEnum("before", "after"),
    headItem: optional(isString),
    headSide: isEnum("before", "after"),
  }),
  presence_leave: isStrict({ connectionId: isString }),
};

/** A decoded control frame with its optional correlation id. */
export interface DecodedControlFrame {
  id?: string;
  type: ControlFrameType;
  payload: unknown;
}

/**
 * Decode one text message. Strict — rejects unknown versions, unknown
 * frame types, extra envelope/payload fields, and wrong payload shapes,
 * mirroring `ControlFrame::decode` in Rust exactly.
 */
export function decodeControlFrame(text: string): DecodedControlFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolDecodeError("control frame is not valid JSON", "invalid_json");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProtocolDecodeError("control frame must be a JSON object", "bad_envelope");
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.some((k) => !["v", "type", "payload", "id"].includes(k))) {
    throw new ProtocolDecodeError("unexpected extra envelope fields", "bad_envelope");
  }
  for (const required of ["v", "type", "payload"]) {
    if (!(required in obj)) {
      throw new ProtocolDecodeError(`missing envelope field '${required}'`, "bad_envelope");
    }
  }
  if (obj.v !== WIRE_VERSION) {
    throw new ProtocolDecodeError(`unsupported wire version ${String(obj.v)}`, "unsupported_version");
  }
  if (typeof obj.type !== "string") {
    throw new ProtocolDecodeError("'type' must be a string", "bad_envelope");
  }
  const type = obj.type as ControlFrameType;
  if (!CONTROL_FRAME_TYPES.includes(type)) {
    throw new ProtocolDecodeError(`unknown frame type '${obj.type}'`, "unknown_frame_type");
  }
  if ("id" in obj && typeof obj.id !== "string") {
    throw new ProtocolDecodeError("'id' must be a string", "bad_envelope");
  }
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const reason = PAYLOAD_VALIDATORS[type](obj.payload);
  if (reason !== null) {
    throw new ProtocolDecodeError(`bad ${type} payload: ${reason}`, "bad_payload");
  }
  // Defense-in-depth token cap (PROTOCOL §9.11), same as Rust.
  if (type === "authenticate" && (obj.payload as Authenticate).token.length > MAX_TOKEN_BYTES) {
    throw new ProtocolDecodeError("token exceeds size cap", "bad_payload");
  }
  return { id, type, payload: obj.payload };
}

/** Encode a control frame to wire text (key order matches Rust). */
export function encodeControlFrame(frame: {
  id?: string;
  type: ControlFrameType;
  payload: unknown;
}): string {
  const envelope: Record<string, unknown> = { v: WIRE_VERSION };
  if (frame.id !== undefined) {
    envelope.id = frame.id;
  }
  envelope.type = frame.type;
  envelope.payload = frame.payload;
  return JSON.stringify(envelope);
}

// ---------------------------------------------------------------------------
// Data codec (binary)
// ---------------------------------------------------------------------------

export interface ClientOpsFrame {
  batchId: number;
  ops: Uint8Array[];
}

export interface SyncBatchFrame {
  nextCursor: number;
  hasMore: boolean;
  ops: Uint8Array[];
}

/**
 * Decode a binary data frame. Enforces count/size limits identically to
 * Rust; op bytes are returned verbatim (envelope validation is the
 * gateway's job; the browser never trusts its own outgoing path this way).
 */
export function decodeDataFrame(
  bytes: Uint8Array,
):
  | { kind: "client_ops"; frame: ClientOpsFrame }
  | { kind: "sync_batch"; frame: SyncBatchFrame } {
  if (bytes.length < 2) {
    throw new ProtocolDecodeError("truncated version/kind", "bad_binary_header");
  }
  if (bytes[0] !== WIRE_VERSION) {
    throw new ProtocolDecodeError(`unsupported version ${bytes[0]}`, "unsupported_version");
  }
  const kind = bytes[1];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === BATCH_KIND_CLIENT_OPS) {
    if (bytes.length < 12) {
      throw new ProtocolDecodeError("truncated client_ops header", "bad_binary_header");
    }
    const batchId = view.getBigUint64(2, false);
    const count = view.getUint16(10, false);
    const ops = readOps(view, 12, count, MAX_BATCH_OPS, bytes.length);
    const payloadBytes = ops.reduce((sum, o) => sum + o.length + 4, 0);
    if (payloadBytes > MAX_BATCH_PAYLOAD_BYTES) {
      throw new ProtocolDecodeError("batch payload exceeds cap", "bad_binary_body");
    }
    if (batchId > Number.MAX_SAFE_INTEGER) {
      throw new ProtocolDecodeError("batch id exceeds safe integer", "bad_binary_body");
    }
    return { kind: "client_ops", frame: { batchId: Number(batchId), ops } };
  }
  if (kind === BATCH_KIND_SYNC) {
    if (bytes.length < 13) {
      throw new ProtocolDecodeError("truncated sync_batch header", "bad_binary_header");
    }
    const nextCursor = view.getBigUint64(2, false);
    const hasMoreByte = bytes[10];
    if (hasMoreByte > 1) {
      throw new ProtocolDecodeError("bad has_more flag", "bad_binary_header");
    }
    const count = view.getUint16(11, false);
    const ops = readOps(view, 13, count, MAX_SYNC_PAGE_OPS, bytes.length);
    if (nextCursor > Number.MAX_SAFE_INTEGER) {
      throw new ProtocolDecodeError("cursor exceeds safe integer", "bad_binary_body");
    }
    return {
      kind: "sync_batch",
      frame: { nextCursor: Number(nextCursor), hasMore: hasMoreByte === 1, ops },
    };
  }
  throw new ProtocolDecodeError(`unknown binary kind 0x${kind.toString(16)}`, "bad_binary_header");
}

function readOps(
  view: DataView,
  startOffset: number,
  count: number,
  maxCount: number,
  totalLen: number,
): Uint8Array[] {
  if (count > maxCount) {
    throw new ProtocolDecodeError(`op count ${count} exceeds ${maxCount}`, "bad_binary_body");
  }
  const ops: Uint8Array[] = [];
  let offset = startOffset;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > totalLen) {
      throw new ProtocolDecodeError("truncated op length", "bad_binary_body");
    }
    const opLen = view.getUint32(offset, false);
    offset += 4;
    if (opLen === 0 || opLen > MAX_OP_BYTES) {
      throw new ProtocolDecodeError(`bad op length ${opLen}`, "bad_binary_body");
    }
    if (offset + opLen > totalLen) {
      throw new ProtocolDecodeError("truncated op bytes", "bad_binary_body");
    }
    ops.push(new Uint8Array(view.buffer, view.byteOffset + offset, opLen));
    offset += opLen;
  }
  if (offset !== totalLen) {
    throw new ProtocolDecodeError("trailing bytes after batch", "bad_binary_body");
  }
  return ops;
}

/** Encode a client_ops binary frame. */
export function encodeClientOps(frame: ClientOpsFrame): Uint8Array {
  if (frame.ops.length > MAX_BATCH_OPS) {
    throw new ProtocolDecodeError(`batch has ${frame.ops.length} ops`, "bad_binary_body");
  }
  const payloadBytes = frame.ops.reduce((sum, o) => sum + o.length + 4, 0);
  if (payloadBytes > MAX_BATCH_PAYLOAD_BYTES) {
    throw new ProtocolDecodeError("batch payload exceeds cap", "bad_binary_body");
  }
  const out = new Uint8Array(12 + payloadBytes);
  const view = new DataView(out.buffer);
  out[0] = WIRE_VERSION;
  out[1] = BATCH_KIND_CLIENT_OPS;
  view.setBigUint64(2, BigInt(frame.batchId), false);
  view.setUint16(10, frame.ops.length, false);
  let offset = 12;
  for (const op of frame.ops) {
    view.setUint32(offset, op.length, false);
    out.set(op, offset + 4);
    offset += 4 + op.length;
  }
  return out;
}

/** Transport-facing alias for the client_ops encoder. */
export const encodeClientOpsFrame = encodeClientOps;

// ---------------------------------------------------------------------------
// Strict shape validation helpers
// ---------------------------------------------------------------------------

type Check = (v: unknown) => string | null;

function isString(v: unknown): string | null {
  return typeof v === "string" ? null : "expected string";
}

function isUint(v: unknown): string | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? null : "expected non-negative integer";
}

function isEnum<T extends string>(...values: readonly T[]): Check {
  return (v) => (typeof v === "string" && (values as readonly string[]).includes(v) ? null : `expected one of ${values.join("|")}`);
}

/**
 * Marks a shape key optional: absent (not in object) OR undefined passes;
 * any present value must satisfy the inner check. Used by isStrict to
 * distinguish "key may be absent" from "key required".
 */
function optional(check: Check): Check & { __optional?: true } {
  const wrapped = ((v: unknown) => (v === undefined ? null : check(v))) as Check & {
    __optional?: true;
  };
  wrapped.__optional = true;
  return wrapped;
}

function arrayOf(check: Check): Check {
  return (v) => {
    if (!Array.isArray(v)) return "expected array";
    for (const item of v) {
      const err = check(item);
      if (err !== null) return err;
    }
    return null;
  };
}

function isStrict(shape: Record<string, Check>): Check {
  return (v) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return "expected object";
    }
    const obj = v as Record<string, unknown>;
    for (const key of Object.keys(shape)) {
      const check = shape[key];
      const isOptional = "__optional" in check;
      if (!(key in obj)) {
        if (isOptional) continue; // optional keys may be absent
        return `missing field '${key}'`;
      }
      const err = check(obj[key]);
      if (err !== null) return `field '${key}': ${err}`;
    }
    for (const key of Object.keys(obj)) {
      if (!(key in shape)) return `unexpected field '${key}'`;
    }
    return null;
  };
}
