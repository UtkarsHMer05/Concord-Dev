//! Binary data frames: `client_ops` and `sync_batch` (P3-M011,
//! PROTOCOL §9.3).
//!
//! Layout (all integers big-endian):
//!
//! ```text
//! client_ops: [version u8][kind u8][batch_id u64][count u16]
//!             { [op_len u32][op bytes] }*
//! sync_batch:  [version u8][kind u8][next_cursor u64][has_more u8][count u16]
//!             { [op_len u32][op bytes] }*
//! ```
//!
//! `op bytes` are Phase 2 canonical operation frames (PROTOCOL §7) carried
//! verbatim — the gateway never rewrites them. Envelope-level validation
//! lives in [`super::envelope`]; here we enforce framing bounds only.

use super::error::{DecodeError, EncodeError};
use super::limits::{MAX_BATCH_OPS, MAX_BATCH_PAYLOAD_BYTES, MAX_OP_BYTES, MAX_SYNC_PAGE_OPS};
use super::WIRE_VERSION;

pub const BATCH_KIND_CLIENT_OPS: u8 = 0x20;
pub const BATCH_KIND_SYNC: u8 = 0x21;

const HEADER_MIN: usize = 1 + 1 + 8 + 2; // client_ops header (shortest)
const HEADER_SYNC: usize = 1 + 1 + 8 + 1 + 2; // sync_batch header

/// A decoded binary data frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataFrame {
    ClientOps(ClientOps),
    SyncBatch(SyncBatch),
}

/// c→s: a batch of CRDT operations from one client, under one batch id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientOps {
    pub batch_id: u64,
    pub ops: Vec<Vec<u8>>,
    /// Identities extracted during validated decode (empty for plain
    /// `decode`); order matches `ops`.
    pub identities: Vec<super::envelope::OpIdentity>,
}

/// s→c: one bounded page of catch-up/fanout operations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncBatch {
    /// Server-seq high-water mark of this batch (highest op id included).
    pub next_cursor: u64,
    pub has_more: bool,
    pub ops: Vec<Vec<u8>>,
}

impl DataFrame {
    /// Decode a binary WebSocket message into a data frame. Enforces every
    /// wire limit (count, per-op size, total payload) — hostile input can
    /// only produce `DecodeError`, never a panic or unbounded allocation:
    /// `op_len` is checked against the remaining bytes before any read.
    pub fn decode(bytes: &[u8]) -> Result<Self, DecodeError> {
        if bytes.len() < 2 {
            return Err(DecodeError::BadBinaryHeader {
                reason: "truncated version/kind".into(),
            });
        }
        let version = bytes[0];
        if version != WIRE_VERSION as u8 {
            return Err(DecodeError::UnsupportedVersion {
                version: version as u32,
            });
        }
        match bytes[1] {
            BATCH_KIND_CLIENT_OPS => Ok(DataFrame::ClientOps(decode_client_ops(bytes)?)),
            BATCH_KIND_SYNC => Ok(DataFrame::SyncBatch(decode_sync_batch(bytes)?)),
            other => Err(DecodeError::BadBinaryHeader {
                reason: format!("unknown binary frame kind 0x{other:02x}"),
            }),
        }
    }

    /// Decode a `client_ops` frame AND structurally validate every operation
    /// envelope (identity extraction, bounds, exact-consume). This is the
    /// ingestion entry point (P3-M027 step 4): a batch containing any
    /// structurally invalid operation is rejected wholesale (all-or-nothing
    /// batch rule, FAILURE_MODEL §1.2). `sync_batch` frames are
    /// server-generated and skip envelope validation here.
    pub fn decode_client_ops_validated(bytes: &[u8]) -> Result<ClientOps, DecodeError> {
        let frame = Self::decode(bytes)?;
        match frame {
            DataFrame::ClientOps(mut ops) => {
                // Stable identities within one batch must be unique — a
                // client never legitimately sends the same identity twice.
                let mut seen = std::collections::HashSet::with_capacity(ops.ops.len());
                let mut identities = Vec::with_capacity(ops.ops.len());
                for op in &ops.ops {
                    let env = super::envelope::validate_op(op)?;
                    if !seen.insert(env.identity) {
                        return Err(DecodeError::BadBinaryBody {
                            reason: format!(
                                "duplicate operation identity {} in batch",
                                env.identity.to_wire()
                            ),
                        });
                    }
                    identities.push(env.identity);
                }
                ops.identities = identities;
                Ok(ops)
            }
            DataFrame::SyncBatch(_) => Err(DecodeError::BadBinaryHeader {
                reason: "expected client_ops frame".into(),
            }),
        }
    }

    /// Encode a data frame. Errors only on limit violations (programmer
    /// error for server-constructed `sync_batch`).
    pub fn encode(&self) -> Result<Vec<u8>, EncodeError> {
        match self {
            DataFrame::ClientOps(f) => encode_client_ops(f),
            DataFrame::SyncBatch(f) => encode_sync_batch(f),
        }
    }
}

fn read_be_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes
        .get(offset..offset + 2)
        .map(|s| u16::from_be_bytes([s[0], s[1]]))
}

fn read_be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset + 4)
        .map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn read_be_u64(bytes: &[u8], offset: usize) -> Option<u64> {
    bytes
        .get(offset..offset + 8)
        .map(|s| u64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}

fn decode_ops(
    bytes: &[u8],
    mut offset: usize,
    count: usize,
    max_count: usize,
) -> Result<Vec<Vec<u8>>, DecodeError> {
    if count > max_count {
        return Err(DecodeError::BadBinaryBody {
            reason: format!("op count {count} exceeds limit {max_count}"),
        });
    }
    let mut ops = Vec::with_capacity(count.min(64));
    for _ in 0..count {
        let op_len = read_be_u32(bytes, offset).ok_or_else(|| DecodeError::BadBinaryBody {
            reason: "truncated op length".into(),
        })? as usize;
        offset += 4;
        if op_len > MAX_OP_BYTES {
            return Err(DecodeError::BadBinaryBody {
                reason: format!("op length {op_len} exceeds {}", MAX_OP_BYTES),
            });
        }
        if op_len == 0 {
            return Err(DecodeError::BadBinaryBody {
                reason: "empty operation".into(),
            });
        }
        let end = offset
            .checked_add(op_len)
            .ok_or_else(|| DecodeError::BadBinaryBody {
                reason: "length overflow".into(),
            })?;
        if end > bytes.len() {
            return Err(DecodeError::BadBinaryBody {
                reason: "truncated op bytes".into(),
            });
        }
        ops.push(bytes[offset..end].to_vec());
        offset = end;
    }
    if offset != bytes.len() {
        return Err(DecodeError::BadBinaryBody {
            reason: "trailing bytes after batch".into(),
        });
    }
    Ok(ops)
}

fn decode_client_ops(bytes: &[u8]) -> Result<ClientOps, DecodeError> {
    if bytes.len() < HEADER_MIN {
        return Err(DecodeError::BadBinaryHeader {
            reason: "truncated client_ops header".into(),
        });
    }
    let batch_id = read_be_u64(bytes, 2).expect("length checked above");
    let count = read_be_u16(bytes, 10).expect("length checked above") as usize;
    let ops = decode_ops(bytes, HEADER_MIN, count, MAX_BATCH_OPS)?;
    let payload: usize = ops.iter().map(|o| o.len() + 4).sum();
    if payload > MAX_BATCH_PAYLOAD_BYTES {
        return Err(DecodeError::BadBinaryBody {
            reason: format!("batch payload {payload} exceeds {MAX_BATCH_PAYLOAD_BYTES}"),
        });
    }
    Ok(ClientOps {
        batch_id,
        ops,
        identities: Vec::new(),
    })
}

fn decode_sync_batch(bytes: &[u8]) -> Result<SyncBatch, DecodeError> {
    if bytes.len() < HEADER_SYNC {
        return Err(DecodeError::BadBinaryHeader {
            reason: "truncated sync_batch header".into(),
        });
    }
    let next_cursor = read_be_u64(bytes, 2).expect("length checked above");
    let has_more = match bytes[10] {
        0 => false,
        1 => true,
        other => {
            return Err(DecodeError::BadBinaryHeader {
                reason: format!("bad has_more flag 0x{other:02x}"),
            });
        }
    };
    let count = read_be_u16(bytes, 11).expect("length checked above") as usize;
    let ops = decode_ops(bytes, HEADER_SYNC, count, MAX_SYNC_PAGE_OPS)?;
    Ok(SyncBatch {
        next_cursor,
        has_more,
        ops,
    })
}

fn encode_ops(ops: &[Vec<u8>], out: &mut Vec<u8>) -> Result<(), EncodeError> {
    for op in ops {
        if op.len() > MAX_OP_BYTES {
            return Err(EncodeError::OpTooLarge { bytes: op.len() });
        }
        if op.is_empty() {
            return Err(EncodeError::Internal("empty operation in encode"));
        }
        out.extend_from_slice(&(op.len() as u32).to_be_bytes());
        out.extend_from_slice(op);
    }
    Ok(())
}

fn encode_client_ops(f: &ClientOps) -> Result<Vec<u8>, EncodeError> {
    if f.ops.len() > MAX_BATCH_OPS {
        return Err(EncodeError::BatchTooManyOps { count: f.ops.len() });
    }
    let payload: usize = f.ops.iter().map(|o| o.len() + 4).sum();
    if payload > MAX_BATCH_PAYLOAD_BYTES {
        return Err(EncodeError::BatchTooLarge { bytes: payload });
    }
    let mut out = Vec::with_capacity(HEADER_MIN + payload);
    out.push(WIRE_VERSION as u8);
    out.push(BATCH_KIND_CLIENT_OPS);
    out.extend_from_slice(&f.batch_id.to_be_bytes());
    out.extend_from_slice(&(f.ops.len() as u16).to_be_bytes());
    encode_ops(&f.ops, &mut out)?;
    Ok(out)
}

fn encode_sync_batch(f: &SyncBatch) -> Result<Vec<u8>, EncodeError> {
    if f.ops.len() > MAX_SYNC_PAGE_OPS {
        return Err(EncodeError::BatchTooManyOps { count: f.ops.len() });
    }
    let payload: usize = f.ops.iter().map(|o| o.len() + 4).sum();
    let mut out = Vec::with_capacity(HEADER_SYNC + payload);
    out.push(WIRE_VERSION as u8);
    out.push(BATCH_KIND_SYNC);
    out.extend_from_slice(&f.next_cursor.to_be_bytes());
    out.push(u8::from(f.has_more));
    out.extend_from_slice(&(f.ops.len() as u16).to_be_bytes());
    encode_ops(&f.ops, &mut out)?;
    Ok(out)
}
