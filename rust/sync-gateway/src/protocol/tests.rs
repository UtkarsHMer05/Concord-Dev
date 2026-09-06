//! Codec tests for control + data frames (P3-M011 Level A/B).
//!
//! Round-trips, strict-decode rejections, and bounded-input behavior.

use super::control::*;
use super::data::*;
use super::envelope::OpIdentity;
use super::error::{error_code_from_str, DecodeError, EncodeError, ProtocolError};
use super::limits::{MAX_BATCH_OPS, MAX_OP_BYTES};
use super::WIRE_VERSION;

// ---------------------------------------------------------------------------
// Control frames
// ---------------------------------------------------------------------------

#[test]
fn control_round_trip_every_frame_type() {
    let frames = vec![
        ControlFrame {
            id: Some("c-1".into()),
            frame: Frame::Hello(Hello {
                client_protocol_version: 1,
            }),
        },
        ControlFrame {
            id: None,
            frame: Frame::HelloAck(HelloAck {
                protocol_version: 1,
                connection_id: "conn-42".into(),
            }),
        },
        ControlFrame {
            id: None,
            frame: Frame::Authenticate(Authenticate {
                token: "eyJtest".into(),
            }),
        },
        ControlFrame {
            id: None,
            frame: Frame::Authenticated(Authenticated {
                user_id: "u-1".into(),
                clerk_user_id: "user_abc".into(),
                org_id: Some("org-9".into()),
            }),
        },
        ControlFrame {
            id: Some("j".into()),
            frame: Frame::JoinDocument(JoinDocument {
                document_id: "doc-1".into(),
                state_summary: vec![SummaryEntry {
                    replica_id: "7".into(),
                    sequence: "99".into(),
                }],
            }),
        },
        ControlFrame {
            id: Some("j".into()),
            frame: Frame::JoinAccepted(JoinAccepted {
                document_id: "doc-1".into(),
                role: Role::Editor,
                durable_cursor: "12345".into(),
            }),
        },
        ControlFrame {
            id: None,
            frame: Frame::SyncRequest(SyncRequest { cursor: "0".into() }),
        },
        ControlFrame {
            id: None,
            frame: Frame::SyncDone(SyncDone {}),
        },
        ControlFrame {
            id: Some("b7".into()),
            frame: Frame::DurableAck(DurableAck {
                batch_id: "7".into(),
                op_ids: vec!["7:1".into(), "7:2".into()],
            }),
        },
        ControlFrame {
            id: None,
            frame: Frame::Ping(Ping {
                nonce: "314".into(),
            }),
        },
        ControlFrame {
            id: None,
            frame: Frame::Pong(Pong {
                nonce: "314".into(),
            }),
        },
        ControlFrame {
            id: None,
            frame: Frame::Error(ErrorFrame {
                code: "forbidden".into(),
                message: "no access".into(),
                request_id: None,
            }),
        },
        ControlFrame {
            id: None,
            frame: Frame::ServerDraining(ServerDraining {
                reason: "shutdown".into(),
                grace_ms: 5000,
            }),
        },
    ];
    for f in frames {
        let text = f.encode();
        let back = ControlFrame::decode(&text).expect("round trip");
        assert_eq!(back, f, "round trip failed for {text}");
    }
}

#[test]
fn control_encode_is_the_documented_shape() {
    let text = ControlFrame {
        id: Some("r1".into()),
        frame: Frame::Hello(Hello {
            client_protocol_version: 1,
        }),
    }
    .encode();
    // Envelope key order and field names are the wire contract (TS mirror).
    assert_eq!(
        text,
        r#"{"v":1,"id":"r1","type":"hello","payload":{"clientProtocolVersion":1}}"#
    );
}

#[test]
fn control_decode_rejects_hostile_shapes() {
    // Not JSON.
    assert!(matches!(
        ControlFrame::decode("not json"),
        Err(DecodeError::InvalidJson)
    ));
    // Missing fields.
    assert!(matches!(
        ControlFrame::decode(r#"{"type":"hello","payload":{}}"#),
        Err(DecodeError::BadEnvelope { .. })
    ));
    // Wrong version.
    assert!(matches!(
        ControlFrame::decode(r#"{"v":2,"type":"hello","payload":{"clientProtocolVersion":1}}"#),
        Err(DecodeError::UnsupportedVersion { version: 2 })
    ));
    // Unknown type.
    assert!(matches!(
        ControlFrame::decode(r#"{"v":1,"type":"h4x0r","payload":{}}"#),
        Err(DecodeError::UnknownFrameType { .. })
    ));
    // Extra envelope field.
    assert!(matches!(
        ControlFrame::decode(
            r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1},"extra":1}"#
        ),
        Err(DecodeError::BadEnvelope { .. })
    ));
    // Extra payload field (deny_unknown_fields).
    assert!(matches!(
        ControlFrame::decode(
            r#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1,"x":2}}"#
        ),
        Err(DecodeError::BadPayload { .. })
    ));
    // Payload is not an object.
    assert!(matches!(
        ControlFrame::decode(r#"{"v":1,"type":"hello","payload":[1]}"#),
        Err(DecodeError::BadPayload { .. })
    ));
    // Missing payload field.
    assert!(matches!(
        ControlFrame::decode(r#"{"v":1,"type":"join_document","payload":{"documentId":"d"}}"#),
        Err(DecodeError::BadPayload { .. })
    ));
}

#[test]
fn control_decode_rejects_oversized_token() {
    let big = "x".repeat(32 * 1024 + 1);
    let text = format!(r#"{{"v":1,"type":"authenticate","payload":{{"token":"{big}"}}}}"#);
    assert!(matches!(
        ControlFrame::decode(&text),
        Err(DecodeError::BadPayload { .. }) | Err(DecodeError::TooLarge { .. })
    ));
}

#[test]
fn error_codes_round_trip_through_strings() {
    for code in [
        ProtocolError::Unauthorized,
        ProtocolError::Forbidden,
        ProtocolError::UnsupportedProtocolVersion,
        ProtocolError::UnknownFrameType,
        ProtocolError::InvalidState,
        ProtocolError::MalformedFrame,
        ProtocolError::PayloadTooLarge,
        ProtocolError::RateLimited,
        ProtocolError::DatabaseUnavailable,
        ProtocolError::ServerDraining,
        ProtocolError::InternalError,
    ] {
        assert_eq!(error_code_from_str(code.as_str()), Some(code));
    }
    assert_eq!(error_code_from_str("nope"), None);
    assert!(ProtocolError::Unauthorized.is_fatal());
    assert!(!ProtocolError::InvalidState.is_fatal());
}

// ---------------------------------------------------------------------------
// Data frames
// ---------------------------------------------------------------------------

fn sample_client_ops(batch_id: u64, ops: &[Vec<u8>]) -> ClientOps {
    ClientOps {
        batch_id,
        ops: ops.to_vec(),
        identities: Vec::new(),
    }
}

#[test]
fn data_round_trip_client_ops() {
    let f = sample_client_ops(0xAABB, &[vec![1, 2, 3], vec![4, 5], vec![9; 300]]);
    let bytes = DataFrame::ClientOps(f.clone()).encode().expect("encode");
    let back = DataFrame::decode(&bytes).expect("decode");
    assert_eq!(back, DataFrame::ClientOps(f));
}

#[test]
fn data_round_trip_sync_batch() {
    let f = SyncBatch {
        next_cursor: 987654321,
        has_more: true,
        ops: vec![vec![1, 1, 1], vec![7, 7]],
    };
    let bytes = DataFrame::SyncBatch(f.clone()).encode().expect("encode");
    let back = DataFrame::decode(&bytes).expect("decode");
    assert_eq!(back, DataFrame::SyncBatch(f));
    // Header spot-check: version, kind, big-endian cursor.
    assert_eq!(bytes[0], WIRE_VERSION as u8);
    assert_eq!(bytes[1], BATCH_KIND_SYNC);
    assert_eq!(&bytes[2..10], &987654321u64.to_be_bytes());
    assert_eq!(bytes[10], 1);
}

#[test]
fn data_decode_rejects_hostile_inputs() {
    // Truncated.
    assert!(matches!(
        DataFrame::decode(&[]),
        Err(DecodeError::BadBinaryHeader { .. })
    ));
    assert!(matches!(
        DataFrame::decode(&[1]),
        Err(DecodeError::BadBinaryHeader { .. })
    ));
    // Bad version.
    assert!(matches!(
        DataFrame::decode(&[9, BATCH_KIND_CLIENT_OPS]),
        Err(DecodeError::UnsupportedVersion { .. })
    ));
    // Unknown kind.
    assert!(matches!(
        DataFrame::decode(&[1, 0x7f]),
        Err(DecodeError::BadBinaryHeader { .. })
    ));
    // Count exceeds MAX_BATCH_OPS (u16 caps count at 65535; craft via count
    // field with zero ops after — decode must reject count > limit first).
    let mut b = vec![1u8, BATCH_KIND_CLIENT_OPS];
    b.extend_from_slice(&0u64.to_be_bytes());
    b.extend_from_slice(&2000u16.to_be_bytes()); // > 1024
    assert!(matches!(
        DataFrame::decode(&b),
        Err(DecodeError::BadBinaryBody { .. })
    ));
    // Oversized op_len.
    let mut b = vec![1u8, BATCH_KIND_CLIENT_OPS];
    b.extend_from_slice(&0u64.to_be_bytes());
    b.extend_from_slice(&1u16.to_be_bytes());
    b.extend_from_slice(&(MAX_OP_BYTES as u32 + 1).to_be_bytes());
    assert!(matches!(
        DataFrame::decode(&b),
        Err(DecodeError::BadBinaryBody { .. })
    ));
    // Trailing bytes.
    let good = DataFrame::ClientOps(sample_client_ops(1, &[vec![1, 2]]))
        .encode()
        .expect("encode");
    let mut with_trailing = good.clone();
    with_trailing.push(0xee);
    assert!(matches!(
        DataFrame::decode(&with_trailing),
        Err(DecodeError::BadBinaryBody { .. })
    ));
    // Empty op rejected.
    let mut b = vec![1u8, BATCH_KIND_CLIENT_OPS];
    b.extend_from_slice(&0u64.to_be_bytes());
    b.extend_from_slice(&1u16.to_be_bytes());
    b.extend_from_slice(&0u32.to_be_bytes());
    assert!(matches!(
        DataFrame::decode(&b),
        Err(DecodeError::BadBinaryBody { .. })
    ));
    // Bad has_more flag on sync kind.
    let mut b = vec![1u8, BATCH_KIND_SYNC];
    b.extend_from_slice(&0u64.to_be_bytes());
    b.push(7);
    b.extend_from_slice(&0u16.to_be_bytes());
    assert!(matches!(
        DataFrame::decode(&b),
        Err(DecodeError::BadBinaryHeader { .. })
    ));
}

#[test]
fn data_encode_enforces_limits() {
    let too_many = ClientOps {
        batch_id: 0,
        ops: vec![vec![1]; MAX_BATCH_OPS + 1],
        identities: Vec::new(),
    };
    assert!(matches!(
        DataFrame::ClientOps(too_many).encode(),
        Err(EncodeError::BatchTooManyOps { .. })
    ));
    let too_big = ClientOps {
        batch_id: 0,
        ops: vec![vec![7; 64 * 1024]; 200],
        identities: Vec::new(),
    };
    assert!(matches!(
        DataFrame::ClientOps(too_big).encode(),
        Err(EncodeError::BatchTooLarge { .. })
    ));
    let op_too_big = SyncBatch {
        next_cursor: 0,
        has_more: false,
        ops: vec![vec![7; MAX_OP_BYTES + 1]],
    };
    assert!(matches!(
        DataFrame::SyncBatch(op_too_big).encode(),
        Err(EncodeError::OpTooLarge { .. })
    ));
}

#[test]
fn op_identity_wire_form() {
    let id = OpIdentity {
        replica: 42,
        counter: 17,
    };
    assert_eq!(id.to_wire(), "42:17");
    assert_eq!(OpIdentity::from_wire("42:17"), Some(id));
    assert_eq!(OpIdentity::from_wire("garbage"), None);
    assert_eq!(OpIdentity::from_wire("42:17:9"), None);
}
