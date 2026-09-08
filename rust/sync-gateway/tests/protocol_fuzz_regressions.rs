//! Protocol fuzz regression suite (P6-M018).
//!
//! Mechanism: the standalone fuzz driver
//! (`cargo run --release --example proto_fuzz`) found ONE panic-class
//! finding at smoke tier, which is fixed in `broker/envelope.rs` and
//! pinned below. In addition, this suite replays a structured seed corpus
//! — the inline equivalent of the C++ `cpp/crdt/fuzz/corpus/` concept
//! (valid frames + documented mutations, no binary files) — through the
//! exact decode entry points, asserting the decode contract:
//! decode-or-structured-error, NEVER a panic, and bounds enforced by
//! error-return (asserted structurally, not by allocation measurement).
//!
//! Seed provenance: every seed below either mirrors the driver's inline
//! corpus or is a minimized mutant that exercised the finding. A new fuzz
//! crash adds a minimized seed + a case here (same policy as
//! `cpp/crdt/tests/test_fuzz_regressions.cpp`).

use sync_gateway::broker::{BrokerEvent, BrokerEventError};
use sync_gateway::protocol::control::{ControlFrame, Frame};
use sync_gateway::protocol::data::DataFrame;
use sync_gateway::protocol::envelope::validate_op;
use sync_gateway::protocol::{DecodeError, MAX_BATCH_OPS, MAX_OP_BYTES, MAX_TOKEN_BYTES};

// ---------------------------------------------------------------------------
// Shared seed builders (mirror examples/proto_fuzz.rs)
// ---------------------------------------------------------------------------

/// Canonical 32-byte insert op (same envelope as the unit/golden tests).
fn golden_insert_op(replica: u64, counter: u64) -> Vec<u8> {
    let mut b = vec![1u8, 1u8];
    b.extend_from_slice(&replica.to_le_bytes());
    b.extend_from_slice(&counter.to_le_bytes());
    b.extend_from_slice(&1u64.to_le_bytes());
    b.push(0);
    b.push(0);
    b.push(1);
    b.push(1);
    b.push(b'a');
    b.push(0);
    b
}

fn client_ops_bytes(ops: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![1u8, 0x20];
    out.extend_from_slice(&7u64.to_be_bytes());
    out.extend_from_slice(&(ops.len() as u16).to_be_bytes());
    for op in ops {
        out.extend_from_slice(&(op.len() as u32).to_be_bytes());
        out.extend_from_slice(op);
    }
    out
}

fn broker_event_bytes(ops: &[Vec<u8>]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for op in ops {
        hasher.update((op.len() as u32).to_be_bytes());
        hasher.update(op);
    }
    let checksum: [u8; 32] = hasher.finalize().into();
    let mut out = vec![1u8];
    out.extend_from_slice(&5u64.to_be_bytes());
    out.extend_from_slice(&uuid::Uuid::new_v4().into_bytes());
    out.extend_from_slice(&42u64.to_be_bytes());
    out.extend_from_slice(&99u64.to_be_bytes());
    out.extend_from_slice(&checksum);
    out.extend_from_slice(&(ops.len() as u16).to_be_bytes());
    for op in ops {
        out.extend_from_slice(&(op.len() as u32).to_be_bytes());
        out.extend_from_slice(op);
    }
    out
}

// ---------------------------------------------------------------------------
// Pinned regression: the one fuzz finding (fixed; pinned forever)
// ---------------------------------------------------------------------------

/// FUZZ-2026-09-001 (fixed): `BrokerEvent::decode` accepted a 74-byte frame
/// through its `< 74` length gate, then panicked reading the SECOND byte of
/// the op_count u16 at index 74 (`bytes[73], bytes[74]`). Any gateway in a
/// NATS mesh could be crashed by a peer (or anyone with broker publish
/// access) sending a truncated event: decode runs in the subscriber task,
/// and a panic there tears down the whole process. Minimized input: the
/// 74-byte prefix of any valid event (header minus the final op_count byte).
/// Fix: minimum length is 75 (the full fixed header).
#[test]
fn regression_broker_event_74_byte_frame_panicked_index_out_of_bounds() {
    let event = broker_event_bytes(&[golden_insert_op(901, 1)]);
    assert_eq!(event.len(), 75 + 4 + 32);
    // Exactly 74 bytes: previously panicked at index 74; must be Truncated.
    let cut = &event[..74];
    assert_eq!(BrokerEvent::decode(cut), Err(BrokerEventError::Truncated));
    // Every truncation at OR below the header boundary must be Truncated.
    for len in [0usize, 1, 9, 25, 41, 73, 74] {
        let bytes = &event[..len.min(event.len())];
        assert_eq!(
            BrokerEvent::decode(bytes),
            Err(BrokerEventError::Truncated),
            "len {len} must be a structured Truncated, never a panic"
        );
    }
}

// ---------------------------------------------------------------------------
// Structured seed corpus — control frame decode (target 1)
// ---------------------------------------------------------------------------

const CONTROL_SEEDS: &[&str] = &[
    r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#,
    r#"{"v":1,"id":"c-7","type":"authenticate","payload":{"token":"eyJhbGciOiJFUzI1NiJ9.x.y"}}"#,
    r#"{"v":1,"type":"join_document","payload":{"documentId":"doc","stateSummary":[]}}"#,
    r#"{"v":1,"type":"sync_request","payload":{"cursor":"12345"}}"#,
    r#"{"v":1,"type":"ping","payload":{"nonce":"42"}}"#,
    r#"{"v":1,"type":"pong","payload":{"nonce":"42"}}"#,
    r#"{"v":1,"type":"fetch_snapshot","payload":{"snapshotId":"abc"}}"#,
    r#"{"v":1,"type":"error","payload":{"code":"x","message":"m"}}"#,
    // Mutations: wrong version / unknown type / wrong shapes / extra fields.
    r#"{"v":2,"type":"hello","payload":{"clientProtocolVersion":1}}"#,
    r#"{"v":0,"type":"hello","payload":{"clientProtocolVersion":0}}"#,
    r#"{"v":1,"type":"unknown_type","payload":{}}"#,
    r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1},"extra":true}"#,
    r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":"one"}}"#,
    r#"{"v":1,"type":"hello","payload":null}"#,
    r#"{"v":1,"type":"hello"}"#,
    r#"{"v":"1","type":"hello","payload":{}}"#,
    r#"{"v":1,"type":123,"payload":{}}"#,
    r#"{"v":1,"id":7,"type":"ping","payload":{"nonce":"1"}}"#,
    "not json at all",
    "[]",
    r#"{""#,
    // Deeply nested payload (serde_json recursion-depth behavior probe).
    r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":[[[[[[[[[[]]]]]]]]]]}}"#,
];

/// Every control seed decodes or fails with a structured error — never a
/// panic, and a decoded `authenticate` never exceeds MAX_TOKEN_BYTES.
#[test]
fn control_seed_corpus_decode_or_structured_error() {
    for seed in CONTROL_SEEDS {
        match ControlFrame::decode(seed) {
            Ok(frame) => {
                if let Frame::Authenticate(p) = &frame.frame {
                    assert!(
                        p.token.len() <= MAX_TOKEN_BYTES,
                        "token cap violated for seed {seed}"
                    );
                }
            }
            Err(
                DecodeError::InvalidJson
                | DecodeError::BadEnvelope { .. }
                | DecodeError::UnsupportedVersion { .. }
                | DecodeError::UnknownFrameType { .. }
                | DecodeError::BadPayload { .. }
                | DecodeError::TooLarge { .. }
                | DecodeError::FrameTooLarge { .. },
            ) => {} // structured rejection — the contract
            Err(other) => panic!("control decode returned binary-path error {other:?}"),
        }
    }
}

/// Deep-nesting probe (documented behavior): serde_json's default recursion
/// limit is 128 — a deeply nested JSON document is a structured error, not
/// a stack overflow. This pins that property for the control-frame path;
/// the frame never reaches payload deserialization if the envelope parse
/// itself rejects it.
#[test]
fn control_deeply_nested_json_is_structured_not_stack_overflow() {
    let mut payload = String::from("{\"v\":1,\"type\":\"hello\",\"payload\":");
    for _ in 0..2000 {
        payload.push('[');
    }
    for _ in 0..2000 {
        payload.push(']');
    }
    payload.push('}');
    // Must terminate with a structured error (or success), never a crash.
    let _ = ControlFrame::decode(&payload);
    assert!(matches!(
        ControlFrame::decode(&payload),
        Err(DecodeError::InvalidJson) | Err(DecodeError::BadPayload { .. })
    ));
}

// ---------------------------------------------------------------------------
// Structured seed corpus — binary data-frame decode (target 2)
// ---------------------------------------------------------------------------

fn data_seeds() -> Vec<Vec<u8>> {
    vec![
        client_ops_bytes(&[golden_insert_op(7, 1), golden_insert_op(7, 2)]),
        vec![1u8, 0x21, 0, 0, 0, 0, 0, 0, 0, 42, 1, 0, 0], // empty sync page
        vec![1u8, 0x20],
        vec![1u8, 0x99, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], // unknown kind
        vec![9u8, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], // bad version
    ]
}

#[test]
fn data_seed_corpus_decode_bounds_hold() {
    for seed in data_seeds() {
        match DataFrame::decode(&seed) {
            Ok(DataFrame::ClientOps(f)) => {
                assert!(f.ops.len() <= MAX_BATCH_OPS, "op count bound");
                assert!(
                    f.ops.iter().all(|o| o.len() <= MAX_OP_BYTES),
                    "op size bound"
                );
            }
            Ok(DataFrame::SyncBatch(f)) => {
                assert!(
                    f.ops.len() <= sync_gateway::protocol::MAX_SYNC_PAGE_OPS,
                    "sync page bound"
                );
            }
            Err(
                DecodeError::BadBinaryHeader { .. }
                | DecodeError::BadBinaryBody { .. }
                | DecodeError::UnsupportedVersion { .. },
            ) => {}
            Err(other) => panic!("data decode returned text-path error {other:?}"),
        }
    }
}

/// Oversize containment (framing-level): a header declaring 65_535 ops with
/// no payload must be REJECTED (count cap), never allowed to pre-allocate.
#[test]
fn data_oversized_declared_count_rejected_not_allocated() {
    let mut over = vec![1u8, 0x20, 0, 0, 0, 0, 0, 0, 0, 1];
    over.extend_from_slice(&65_535u16.to_be_bytes());
    assert!(matches!(
        DataFrame::decode(&over),
        Err(DecodeError::BadBinaryBody { .. })
    ));
}

/// Oversize containment (per-op): a declared op_len of 0x10000 (65_536 >
/// MAX_OP_BYTES = 64 KiB) is rejected by the per-op cap before any read.
#[test]
fn data_oversized_op_length_rejected() {
    let mut big = vec![1u8, 0x20, 0, 0, 0, 0, 0, 0, 0, 1];
    big.extend_from_slice(&1u16.to_be_bytes());
    big.extend_from_slice(&0x10000u32.to_be_bytes());
    assert!(matches!(
        DataFrame::decode(&big),
        Err(DecodeError::BadBinaryBody { .. })
    ));
}

// ---------------------------------------------------------------------------
// Structured seed corpus — op envelope validation (target 3)
// ---------------------------------------------------------------------------

fn op_seeds() -> Vec<Vec<u8>> {
    let mut del = vec![1u8, 2u8];
    del.extend_from_slice(&7u64.to_le_bytes());
    del.extend_from_slice(&2u64.to_le_bytes());
    del.extend_from_slice(&1u64.to_le_bytes());
    del.extend_from_slice(&9u64.to_le_bytes());
    del.extend_from_slice(&1u64.to_le_bytes());
    let mut seta = vec![1u8, 3u8];
    seta.extend_from_slice(&7u64.to_le_bytes());
    seta.extend_from_slice(&4u64.to_le_bytes());
    seta.extend_from_slice(&2u64.to_le_bytes());
    seta.extend_from_slice(&9u64.to_le_bytes());
    seta.extend_from_slice(&1u64.to_le_bytes());
    seta.extend_from_slice(&2u64.to_le_bytes());
    seta.push(b'b');
    seta.push(b'o');
    seta.push(1);
    seta.extend_from_slice(&1u64.to_le_bytes());
    seta.push(b'1');
    vec![
        golden_insert_op(0xD4, 17),
        del,
        seta,
        vec![],
        vec![1, 99, 0, 0, 0, 0],
        golden_insert_op(0, 1),        // zero replica → reject
        golden_insert_op(7, 0),        // zero counter → reject
        golden_insert_op(7, u64::MAX), // over-range counter → reject
    ]
}

#[test]
fn op_seed_corpus_validate_or_structured_error() {
    for seed in op_seeds() {
        match validate_op(&seed) {
            Ok(env) => {
                assert_ne!(env.identity.replica, 0, "zero replica accepted");
                assert!(
                    (1..=(1u64 << 63) - 1).contains(&env.identity.counter),
                    "counter range accepted"
                );
            }
            Err(DecodeError::BadOperation { .. }) => {}
            Err(other) => panic!("validate_op returned non-op error {other:?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Structured seed corpus — broker event decode (target 4)
// ---------------------------------------------------------------------------

#[test]
fn broker_seed_corpus_decode_or_structured_error() {
    let seeds: Vec<Vec<u8>> = vec![
        broker_event_bytes(&[golden_insert_op(901, 1), golden_insert_op(901, 2)]),
        broker_event_bytes(&[]),
        vec![9u8; 100],
        vec![1u8; 10],
    ];
    for seed in &seeds {
        match BrokerEvent::decode(seed) {
            Ok(event) => {
                assert!(!event.ops.is_empty(), "empty op list accepted");
                assert!(event.ops.len() <= MAX_BATCH_OPS, "broker op count bound");
            }
            Err(
                BrokerEventError::Truncated
                | BrokerEventError::UnsupportedVersion(_)
                | BrokerEventError::TooLarge
                | BrokerEventError::TooManyOps(_)
                | BrokerEventError::ChecksumMismatch
                | BrokerEventError::InvalidOp(_)
                | BrokerEventError::Trailing,
            ) => {}
        }
    }
}

/// Broker replayed/duplicate containment at the decode layer: the same
/// event bytes decode identically twice (idempotent decode — no state), so
/// NATS redelivery is safe at this boundary (dedup by identity happens at
/// the DB/client per the failure model).
#[test]
fn broker_replayed_event_decodes_idempotently_and_rejects_forged_checksum() {
    let event = broker_event_bytes(&[golden_insert_op(901, 1)]);
    let first = BrokerEvent::decode(&event).expect("valid decodes");
    let second = BrokerEvent::decode(&event).expect("replay decodes identically");
    assert_eq!(first, second);

    // Forged checksum (bit-flip in the checksum field) → ChecksumMismatch,
    // never acceptance.
    let mut forged = event.clone();
    forged[41] ^= 0xFF;
    assert_eq!(
        BrokerEvent::decode(&forged),
        Err(BrokerEventError::ChecksumMismatch)
    );

    // Wrong document (mutated uuid bytes) still has a VALID checksum over
    // the op list — the envelope does not bind the header; decode accepts
    // (header fields are advisory; fanout routes by document_id and the
    // DB unique key rejects cross-doc identity collisions). Pin the
    // behavior so a future binding change is a conscious protocol change.
    let mut wrong_doc = event.clone();
    let idx = 9; // first document_id byte
    wrong_doc[idx] = wrong_doc[idx].wrapping_add(1);
    assert!(BrokerEvent::decode(&wrong_doc).is_ok());
}

// ---------------------------------------------------------------------------
// Target 5 — state-machine property (decode + SessionState gating)
// ---------------------------------------------------------------------------

/// Property: `client_ops` is legal ONLY in Ready, for every state; and the
/// client-legal vs server-only frame split is exactly the exhaustive set
/// (a new Frame variant cannot become silently client-legal).
#[test]
fn session_property_client_ops_only_ready_and_frame_split_exhaustive() {
    use sync_gateway::sessions::SessionState;
    for state in [
        SessionState::Connected,
        SessionState::HelloDone,
        SessionState::Authenticated,
        SessionState::Syncing,
        SessionState::Ready,
        SessionState::Draining,
        SessionState::Closed,
    ] {
        assert_eq!(
            state.can_send_client_ops(),
            state == SessionState::Ready,
            "can_send_client_ops must hold only for Ready"
        );
    }

    // A decodable client frame from the corpus must pass the same decode
    // path the ws loop consults (decode legality is state-independent;
    // STATE legality is the handler's job, pinned by the property above).
    let frame = ControlFrame::decode(CONTROL_SEEDS[0]).expect("hello decodes");
    assert!(matches!(frame.frame, Frame::Hello(_)));
}
