//! CRDT operation envelope: structural validation + stable identity
//! extraction from Phase 2 canonical bytes (P3-M011/P3-M016).
//!
//! This is deliberately NOT a second CRDT (non-negotiable #6/#7): the
//! gateway only parses enough of the canonical operation frame
//! (cpp/crdt serialize.cpp, PROTOCOL §7) to:
//!   1. extract the stable operation identity `(replica, counter)` used as
//!      the durable unique key, and
//!   2. verify the envelope is structurally well-formed (valid header,
//!      in-range identity/lamport, bounded strings, exact consume) so
//!      garbage cannot be persisted into the durable log.
//!
//! Merge/order semantics remain exclusively in the C++/WASM core.

use super::error::DecodeError;
use super::limits::MAX_OP_BYTES;

/// Canonical per-op byte limits mirrored from the Phase 2 core
/// (cpp/crdt/serialize.cpp): identical constants, single source of truth is
/// the C++ core; these are the envelope-level guards for server safety.
const OP_VERSION: u8 = 1;
const MAX_ATTR_NAME_BYTES: usize = 64;
const MAX_ATTR_VALUE_BYTES: usize = 256;
/// Decoder-side string cap (serialize.cpp get_string): values may not
/// exceed 4× the max value length in bytes.
const MAX_STRING_BYTES: usize = MAX_ATTR_VALUE_BYTES * 4;

const OP_TYPE_INSERT: u8 = 1;
const OP_TYPE_DELETE: u8 = 2;
const OP_TYPE_SETATTR: u8 = 3;
const ITEM_KIND_TEXT: u8 = 1;
const ITEM_KIND_DELIMITER: u8 = 2;

const COUNTER_MAX: u64 = (1u64 << 63) - 1;
const LAMPORT_MIN: u64 = 1;
const LAMPORT_MAX: u64 = (1u64 << 63) - 1;

/// Stable operation identity — the durable uniqueness key
/// (`(document_id, replica, counter)`; FAILURE_MODEL §1.1). Displayed as
/// `"<replica>:<counter>"` (decimal) on the wire and in `durable_ack`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct OpIdentity {
    pub replica: u64,
    pub counter: u64,
}

impl OpIdentity {
    /// Wire form (decimal `replica:counter`), mirrored in TypeScript.
    pub fn to_wire(self) -> String {
        format!("{}:{}", self.replica, self.counter)
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        let (replica, counter) = s.split_once(':')?;
        Some(Self {
            replica: replica.parse().ok()?,
            counter: counter.parse().ok()?,
        })
    }
}

/// A structurally validated canonical operation: raw bytes plus its
/// extracted identity. The bytes are stored verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpEnvelope {
    pub identity: OpIdentity,
    pub bytes: Vec<u8>,
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Option<u8> {
        let b = *self.bytes.get(self.offset)?;
        self.offset += 1;
        Some(b)
    }

    fn u64_le(&mut self) -> Option<u64> {
        let s = self.bytes.get(self.offset..self.offset + 8)?;
        self.offset += 8;
        Some(u64::from_le_bytes(s.try_into().expect("slice is 8 bytes")))
    }

    fn take(&mut self, len: usize) -> Option<&'a [u8]> {
        let s = self.bytes.get(self.offset..self.offset.checked_add(len)?)?;
        self.offset += len;
        Some(s)
    }

    fn done(&self) -> bool {
        self.offset == self.bytes.len()
    }
}

fn bad(reason: impl Into<String>) -> DecodeError {
    DecodeError::BadOperation {
        reason: reason.into(),
    }
}

/// Validate one canonical operation envelope and extract its identity.
/// Byte-level mirror of `concord::crdt::parse_operation`'s structural rules
/// (ids.hpp ranges, serialize.cpp field order); any deviation is a
/// structured `BadOperation` — nothing is persisted on failure.
pub fn validate_op(bytes: &[u8]) -> Result<OpEnvelope, DecodeError> {
    if bytes.is_empty() {
        return Err(bad("empty operation"));
    }
    if bytes.len() > MAX_OP_BYTES {
        return Err(bad(format!("operation exceeds {} bytes", MAX_OP_BYTES)));
    }

    let mut r = Reader { bytes, offset: 0 };

    let version = r.u8().ok_or_else(|| bad("empty frame"))?;
    if version != OP_VERSION {
        return Err(bad(format!("unsupported op version {version}")));
    }

    let op_type = r.u8().ok_or_else(|| bad("missing op type"))?;

    // Header: identity (replica, counter) + lamport — little-endian.
    let replica = r.u64_le().ok_or_else(|| bad("truncated identity"))?;
    let counter = r.u64_le().ok_or_else(|| bad("truncated identity"))?;
    let lamport = r.u64_le().ok_or_else(|| bad("truncated lamport"))?;

    // Range rules from ids.hpp: replica != 0, counter in [1, 2^63-1],
    // lamport in [1, 2^63-1].
    if replica == 0 {
        return Err(bad("origin replica id must be nonzero"));
    }
    if !(1..=COUNTER_MAX).contains(&counter) {
        return Err(bad(format!("counter {counter} out of range")));
    }
    if !(LAMPORT_MIN..=LAMPORT_MAX).contains(&lamport) {
        return Err(bad(format!("lamport {lamport} out of range")));
    }

    fn opt_id(r: &mut Reader<'_>) -> Result<Option<(u64, u64)>, DecodeError> {
        match r.u8().ok_or_else(|| bad("truncated optional id flag"))? {
            0 => Ok(None),
            1 => {
                let replica = r.u64_le().ok_or_else(|| bad("truncated anchor id"))?;
                let counter = r.u64_le().ok_or_else(|| bad("truncated anchor id"))?;
                if replica == 0 || !(1..=COUNTER_MAX).contains(&counter) {
                    return Err(bad("anchor id out of range"));
                }
                Ok(Some((replica, counter)))
            }
            other => Err(bad(format!("bad optional-id flag 0x{other:02x}"))),
        }
    }

    fn bounded_string<'r>(r: &mut Reader<'r>) -> Result<&'r [u8], DecodeError> {
        let len = r.u64_le().ok_or_else(|| bad("truncated string length"))? as usize;
        if len > MAX_STRING_BYTES {
            return Err(bad(format!(
                "string length {len} exceeds {MAX_STRING_BYTES}"
            )));
        }
        r.take(len).ok_or_else(|| bad("truncated string bytes"))
    }

    match op_type {
        OP_TYPE_INSERT => {
            opt_id(&mut r)?; // left anchor
            opt_id(&mut r)?; // right anchor
            let kind = r.u8().ok_or_else(|| bad("missing item kind"))?;
            match kind {
                ITEM_KIND_TEXT => {
                    let scalar_len = r.u8().ok_or_else(|| bad("missing scalar length"))? as usize;
                    if !(1..=4).contains(&scalar_len) {
                        return Err(bad(format!("bad scalar length {scalar_len}")));
                    }
                    let scalar = r.take(scalar_len).ok_or_else(|| bad("truncated scalar"))?;
                    // Structural check only: valid UTF-8 and not U+0000.
                    let text = std::str::from_utf8(scalar)
                        .map_err(|_| bad("scalar is not valid UTF-8"))?;
                    if text.contains('\0') {
                        return Err(bad("scalar is U+0000"));
                    }
                    if text.chars().count() != 1 {
                        return Err(bad("scalar must be exactly one character"));
                    }
                }
                ITEM_KIND_DELIMITER => {}
                other => return Err(bad(format!("unknown item kind {other}"))),
            }
            let attr_count = r.u8().ok_or_else(|| bad("missing attr count"))? as usize;
            for _ in 0..attr_count {
                let name = bounded_string(&mut r)?;
                if name.len() > MAX_ATTR_NAME_BYTES {
                    return Err(bad("attr name exceeds 64 bytes"));
                }
                match r.u8().ok_or_else(|| bad("truncated attr flag"))? {
                    0 => {}
                    1 => {
                        let value = bounded_string(&mut r)?;
                        if value.len() > MAX_ATTR_VALUE_BYTES {
                            return Err(bad("attr value exceeds 256 bytes"));
                        }
                    }
                    other => return Err(bad(format!("bad attr flag 0x{other:02x}"))),
                }
            }
        }
        OP_TYPE_DELETE => {
            let replica = r.u64_le().ok_or_else(|| bad("truncated delete target"))?;
            let counter = r.u64_le().ok_or_else(|| bad("truncated delete target"))?;
            if replica == 0 || !(1..=COUNTER_MAX).contains(&counter) {
                return Err(bad("delete target out of range"));
            }
        }
        OP_TYPE_SETATTR => {
            let replica = r.u64_le().ok_or_else(|| bad("truncated setattr target"))?;
            let counter = r.u64_le().ok_or_else(|| bad("truncated setattr target"))?;
            if replica == 0 || !(1..=COUNTER_MAX).contains(&counter) {
                return Err(bad("setattr target out of range"));
            }
            let name = bounded_string(&mut r)?;
            if name.len() > MAX_ATTR_NAME_BYTES {
                return Err(bad("attr name exceeds 64 bytes"));
            }
            match r.u8().ok_or_else(|| bad("truncated attr flag"))? {
                0 => {}
                1 => {
                    let value = bounded_string(&mut r)?;
                    if value.len() > MAX_ATTR_VALUE_BYTES {
                        return Err(bad("attr value exceeds 256 bytes"));
                    }
                }
                other => return Err(bad(format!("bad attr flag 0x{other:02x}"))),
            }
        }
        other => return Err(bad(format!("unknown op type {other}"))),
    }

    if !r.done() {
        return Err(bad("trailing bytes after operation"));
    }

    Ok(OpEnvelope {
        identity: OpIdentity { replica, counter },
        bytes: bytes.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal valid insert op built by hand in the canonical format.
    fn make_insert(replica: u64, counter: u64, lamport: u64) -> Vec<u8> {
        let mut b = vec![1u8 /* version */, 1u8 /* insert */];
        b.extend_from_slice(&replica.to_le_bytes());
        b.extend_from_slice(&counter.to_le_bytes());
        b.extend_from_slice(&lamport.to_le_bytes());
        // left = None, right = None
        b.push(0);
        b.push(0);
        // kind = text, scalar = "a" (1 byte)
        b.push(1);
        b.push(1);
        b.push(b'a');
        // no initial attrs
        b.push(0);
        b
    }

    #[test]
    fn valid_insert_parses_with_identity() {
        let env = validate_op(&make_insert(7, 3, 1)).expect("valid");
        assert_eq!(env.identity.replica, 7);
        assert_eq!(env.identity.counter, 3);
        assert_eq!(env.identity.to_wire(), "7:3");
        assert_eq!(OpIdentity::from_wire("7:3"), Some(env.identity));
    }

    #[test]
    fn rejects_zero_replica_and_bad_counter() {
        let zero = validate_op(&make_insert(0, 1, 1));
        assert!(matches!(zero, Err(DecodeError::BadOperation { .. })));
        let bad_counter = validate_op(&make_insert(7, 0, 1));
        assert!(matches!(bad_counter, Err(DecodeError::BadOperation { .. })));
        let over = validate_op(&make_insert(7, u64::MAX, 1));
        assert!(matches!(over, Err(DecodeError::BadOperation { .. })));
    }

    #[test]
    fn rejects_wrong_version_and_type() {
        let mut b = make_insert(7, 1, 1);
        b[0] = 9;
        assert!(matches!(
            validate_op(&b),
            Err(DecodeError::BadOperation { .. })
        ));
        let mut b = make_insert(7, 1, 1);
        b[1] = 99;
        assert!(matches!(
            validate_op(&b),
            Err(DecodeError::BadOperation { .. })
        ));
    }

    #[test]
    fn rejects_trailing_bytes_and_truncation() {
        let mut b = make_insert(7, 1, 1);
        b.push(0xff);
        assert!(matches!(
            validate_op(&b),
            Err(DecodeError::BadOperation { .. })
        ));
        let truncated = &make_insert(7, 1, 1)[..10];
        assert!(matches!(
            validate_op(truncated),
            Err(DecodeError::BadOperation { .. })
        ));
        assert!(matches!(
            validate_op(&[]),
            Err(DecodeError::BadOperation { .. })
        ));
    }

    #[test]
    fn valid_delete_and_setattr_parse() {
        // delete
        let mut d = vec![1u8, 2u8];
        d.extend_from_slice(&7u64.to_le_bytes());
        d.extend_from_slice(&2u64.to_le_bytes());
        d.extend_from_slice(&1u64.to_le_bytes()); // lamport
        d.extend_from_slice(&9u64.to_le_bytes()); // target replica
        d.extend_from_slice(&1u64.to_le_bytes()); // target counter
        let env = validate_op(&d).expect("delete valid");
        assert_eq!(
            env.identity,
            OpIdentity {
                replica: 7,
                counter: 2
            }
        );

        // setattr
        let mut s = vec![1u8, 3u8];
        s.extend_from_slice(&7u64.to_le_bytes());
        s.extend_from_slice(&4u64.to_le_bytes());
        s.extend_from_slice(&2u64.to_le_bytes()); // lamport
        s.extend_from_slice(&9u64.to_le_bytes()); // target replica
        s.extend_from_slice(&1u64.to_le_bytes()); // target counter
        s.extend_from_slice(&2u64.to_le_bytes()); // attr name length ("bo")
        s.push(b'b');
        s.push(b'o');
        s.push(1); // value present
        s.extend_from_slice(&1u64.to_le_bytes()); // value length
        s.push(b'1');
        let env = validate_op(&s).expect("setattr valid");
        assert_eq!(
            env.identity,
            OpIdentity {
                replica: 7,
                counter: 4
            }
        );
        assert!(validate_op(&s).is_ok());
    }
}
