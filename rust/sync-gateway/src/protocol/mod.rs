//! Wire protocol v1 — frames, codecs, bounded decode (P3-M011).
//!
//! Two frame classes (DEC-029 / docs/PROTOCOL.md §9):
//! - **Control frames**: compact typed JSON *text* messages with a
//!   `{v, type, id?, payload}` envelope. Strict decode: unknown version,
//!   unknown type, wrong payload shape, or trailing junk are structured
//!   errors — never panics.
//! - **Data frames** (`client_ops`, `sync_batch`): binary messages with a
//!   fixed big-endian header; CRDT operation bytes are carried verbatim and
//!   opaque (Phase 2 canonical serialization, PROTOCOL §7). The gateway
//!   never re-encodes, reorders, or interprets CRDT semantics.
//!
//! All decoders enforce the wire limits from PROTOCOL §9.11 at parse time
//! in addition to the transport-level frame-size cap.

pub mod control;
pub mod data;
pub mod envelope;
pub mod error;
/// Canonical op fixture builders (P2 golden parity). Public so Phase 5
/// integration tests can ingest real, valid op bytes through the same
/// pinned encodings as the parity suites.
pub mod golden;
pub mod limits;

#[cfg(test)]
mod tests;

pub use control::{
    Authenticate, Authenticated, ControlFrame, DurableAck, ErrorFrame, Hello, HelloAck,
    JoinAccepted, JoinDocument, Ping, Pong, ServerDraining, SyncDone, SyncRequest,
};
pub use data::{ClientOps, DataFrame, SyncBatch, BATCH_KIND_CLIENT_OPS, BATCH_KIND_SYNC};
pub use envelope::{OpEnvelope, OpIdentity};
pub use error::{error_code_from_str, error_code_to_str, DecodeError, EncodeError, ProtocolError};
pub use limits::{
    MAX_BATCH_OPS, MAX_FRAME_BYTES, MAX_OP_BYTES, MAX_SYNC_PAGE_OPS, MAX_TOKEN_BYTES,
};

/// Wire protocol version implemented by this gateway (PROTOCOL §9.1).
pub const WIRE_VERSION: u32 = 1;
