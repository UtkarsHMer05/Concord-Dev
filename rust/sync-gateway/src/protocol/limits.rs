//! Wire limits (PROTOCOL §9.11). Enforced at decode time in addition to the
//! transport frame-size cap — protocol inputs are untrusted (non-negotiable
//! #21/#22).

/// Maximum accepted WebSocket message size (text or binary).
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Maximum operations in one `client_ops` batch.
pub const MAX_BATCH_OPS: usize = 1024;

/// Maximum total payload bytes in one `client_ops` batch.
pub const MAX_BATCH_PAYLOAD_BYTES: usize = 4 * 1024 * 1024;

/// Maximum operations in one `sync_batch` page.
pub const MAX_SYNC_PAGE_OPS: usize = 1024;

/// Maximum size of a single CRDT operation (Phase 2 PROTOCOL §5).
pub const MAX_OP_BYTES: usize = 64 * 1024;

/// Defense-in-depth cap on the bearer token string inside `authenticate`.
pub const MAX_TOKEN_BYTES: usize = 32 * 1024;
