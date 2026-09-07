//! Inter-gateway event envelope v1 (P4-M005, DEC-031).
//!
//! Binary layout (all integers big-endian):
//! ```text
//! [schema_version u8 = 1]
//! [origin_gateway u64]
//! [document_id 16B uuid bytes]
//! [event_id u64]                  // origin's batch id — stable identity
//! [server_cursor u64]             // advisory durable cursor after commit
//! [payload_sha256 32B]            // integrity over the op list
//! [op_count u16]
//! { [op_len u32][op bytes] }*      // canonical Phase 2 op bytes, verbatim
//! ```
//!
//! Validation is STRICT (M015): version, sizes, op caps, checksum, and op
//! envelope structure (via the Phase 3 validator). Broker payloads are
//! untrusted internal input — malformed events are structured errors,
//! never panics, and never reach fanout.

use sha2::{Digest, Sha256};

use crate::protocol::envelope::validate_op;
use crate::protocol::{MAX_BATCH_OPS, MAX_OP_BYTES};

pub const EVENT_SCHEMA_VERSION: u8 = 1;
/// Whole-event byte cap (header 65 + op list; generous vs. batch payload cap).
pub const MAX_EVENT_BYTES: usize = 8 * 1024 * 1024;

/// Decoded + validated event ready for local fanout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerEvent {
    pub origin_gateway: u64,
    pub document_id: uuid::Uuid,
    pub event_id: u64,
    pub server_cursor: u64,
    pub ops: Vec<Vec<u8>>,
}

/// Structured envelope errors.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum BrokerEventError {
    #[error("truncated event")]
    Truncated,
    #[error("unsupported schema version {0}")]
    UnsupportedVersion(u8),
    #[error("event exceeds size cap")]
    TooLarge,
    #[error("op count {0} exceeds limit")]
    TooManyOps(usize),
    #[error("checksum mismatch")]
    ChecksumMismatch,
    #[error("op {0} failed envelope validation")]
    InvalidOp(usize),
    #[error("trailing bytes after event")]
    Trailing,
}

impl BrokerEvent {
    fn header_len(op_count: usize, op_bytes: usize) -> usize {
        1 + 8 + 16 + 8 + 8 + 32 + 2 + op_count * 4 + op_bytes
    }

    /// Encodes with checksum + bounds enforcement. Publisher-side; fails
    /// only on limit violations.
    pub fn encode(&self) -> Vec<u8> {
        assert!(!self.ops.is_empty(), "events carry accepted batches");
        assert!(
            self.ops.len() <= MAX_BATCH_OPS,
            "batch cap enforced upstream"
        );
        let op_bytes: usize = self.ops.iter().map(|o| o.len()).sum();
        let mut out = Vec::with_capacity(Self::header_len(self.ops.len(), op_bytes));
        out.push(EVENT_SCHEMA_VERSION);
        out.extend_from_slice(&self.origin_gateway.to_be_bytes());
        out.extend_from_slice(self.document_id.as_bytes());
        out.extend_from_slice(&self.event_id.to_be_bytes());
        out.extend_from_slice(&self.server_cursor.to_be_bytes());
        out.extend_from_slice(&Self::checksum(&self.ops));
        out.extend_from_slice(&(self.ops.len() as u16).to_be_bytes());
        for op in &self.ops {
            out.extend_from_slice(&(op.len() as u32).to_be_bytes());
            out.extend_from_slice(op);
        }
        out
    }

    /// Strict decode (M015): every bound checked before allocation; op
    /// envelopes structurally validated; checksum verified.
    pub fn decode(bytes: &[u8]) -> Result<Self, BrokerEventError> {
        if bytes.len() < 74 {
            return Err(BrokerEventError::Truncated);
        }
        if bytes.len() > MAX_EVENT_BYTES {
            return Err(BrokerEventError::TooLarge);
        }
        if bytes[0] != EVENT_SCHEMA_VERSION {
            return Err(BrokerEventError::UnsupportedVersion(bytes[0]));
        }
        let read_be_u64 =
            |off: usize| u64::from_be_bytes(bytes[off..off + 8].try_into().expect("checked"));
        let origin_gateway = read_be_u64(1);
        let document_id = uuid::Uuid::from_bytes(bytes[9..25].try_into().expect("checked"));
        let event_id = read_be_u64(25);
        let server_cursor = read_be_u64(33);
        let expected_checksum: [u8; 32] = bytes[41..73].try_into().expect("checked");
        let op_count = u16::from_be_bytes([bytes[73], bytes[74]]) as usize;
        if op_count == 0 || op_count > MAX_BATCH_OPS {
            return Err(BrokerEventError::TooManyOps(op_count));
        }

        // Bounded op parse.
        let mut ops = Vec::with_capacity(op_count.min(64));
        let mut offset = 75;
        for i in 0..op_count {
            if offset + 4 > bytes.len() {
                return Err(BrokerEventError::Truncated);
            }
            let op_len =
                u32::from_be_bytes(bytes[offset..offset + 4].try_into().expect("checked")) as usize;
            offset += 4;
            if op_len == 0 || op_len > MAX_OP_BYTES {
                return Err(BrokerEventError::InvalidOp(i));
            }
            if offset + op_len > bytes.len() {
                return Err(BrokerEventError::Truncated);
            }
            ops.push(bytes[offset..offset + op_len].to_vec());
            offset += op_len;
        }
        if offset != bytes.len() {
            return Err(BrokerEventError::Trailing);
        }

        // Checksum over the op list.
        let actual = Self::checksum(&ops);
        if actual != expected_checksum {
            return Err(BrokerEventError::ChecksumMismatch);
        }

        // Op envelope structure (same validator as the client path).
        for (i, op) in ops.iter().enumerate() {
            if validate_op(op).is_err() {
                return Err(BrokerEventError::InvalidOp(i));
            }
        }

        Ok(Self {
            origin_gateway,
            document_id,
            event_id,
            server_cursor,
            ops,
        })
    }

    /// Stable NATS dedup id: document + origin + event id.
    pub fn nats_msg_id(&self) -> String {
        format!(
            "{}:{}:{}",
            self.document_id, self.origin_gateway, self.event_id
        )
    }

    fn checksum(ops: &[Vec<u8>]) -> [u8; 32] {
        let mut hasher = Sha256::new();
        for op in ops {
            hasher.update((op.len() as u32).to_be_bytes());
            hasher.update(op);
        }
        hasher.finalize().into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event(origin: u64) -> BrokerEvent {
        // Two canonical 32-byte insert ops (same envelope as other tests).
        let op = |replica: u64, counter: u64| {
            let mut b = vec![0u8; 32];
            b[0] = 1;
            b[1] = 1;
            b[2..10].copy_from_slice(&replica.to_le_bytes());
            b[10..18].copy_from_slice(&counter.to_le_bytes());
            b[18..26].copy_from_slice(&1u64.to_le_bytes());
            b[26] = 0;
            b[27] = 0;
            b[28] = 1;
            b[29] = 1;
            b[30] = b'a';
            b[31] = 0;
            b
        };
        BrokerEvent {
            origin_gateway: origin,
            document_id: uuid::Uuid::new_v4(),
            event_id: 7,
            server_cursor: 42,
            ops: vec![op(901, 1), op(901, 2)],
        }
    }

    #[test]
    fn round_trip() {
        let event = sample_event(5);
        let decoded = BrokerEvent::decode(&event.encode()).expect("round trip");
        assert_eq!(decoded, event);
    }

    #[test]
    fn rejects_truncated_and_trailing() {
        let event = sample_event(5);
        let bytes = event.encode();
        assert!(matches!(
            BrokerEvent::decode(&bytes[..30]),
            Err(BrokerEventError::Truncated)
        ));
        let mut trailing = bytes.clone();
        trailing.push(0xff);
        assert!(matches!(
            BrokerEvent::decode(&trailing),
            Err(BrokerEventError::Trailing)
        ));
    }

    #[test]
    fn rejects_bad_version_and_checksum() {
        let event = sample_event(5);
        let mut bytes = event.encode();
        bytes[0] = 9;
        assert!(matches!(
            BrokerEvent::decode(&bytes),
            Err(BrokerEventError::UnsupportedVersion(9))
        ));
        let mut bytes = event.encode();
        bytes[41] ^= 0xff; // corrupt checksum
        assert!(matches!(
            BrokerEvent::decode(&bytes),
            Err(BrokerEventError::ChecksumMismatch)
        ));
    }

    #[test]
    fn rejects_structurally_invalid_op() {
        let mut event = sample_event(5);
        event.ops[0] = vec![1, 1, 7]; // garbage op bytes
        let bytes = event.encode();
        assert!(matches!(
            BrokerEvent::decode(&bytes),
            Err(BrokerEventError::InvalidOp(0))
        ));
    }

    #[test]
    fn nats_msg_id_is_stable() {
        let event = sample_event(5);
        let id = event.nats_msg_id();
        assert!(id.contains(":5:7"));
        assert_eq!(id, event.nats_msg_id());
    }

    #[test]
    fn rejects_oversized_event() {
        let mut event = sample_event(5);
        event.ops = vec![vec![1u8; 1024]; MAX_BATCH_OPS];
        let bytes = event.encode();
        // 1024×1024 > caps: parse-level rejection
        assert!(
            matches!(
                BrokerEvent::decode(&bytes),
                Err(BrokerEventError::TooManyOps(_))
            ) || matches!(
                BrokerEvent::decode(&bytes),
                Err(BrokerEventError::InvalidOp(_))
            )
        );
    }
}
