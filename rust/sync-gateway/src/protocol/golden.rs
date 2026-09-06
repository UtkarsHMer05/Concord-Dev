//! Golden fixture generator + parity harness (P3-M012).
//!
//! Golden vectors pin the EXACT wire bytes for every frame family so any
//! drift between the Rust codec and the TypeScript mirror is caught by
//! tests on both sides. Rust is the generator (source of truth); the
//! fixtures are committed under `fixtures/protocol/v1/` and consumed by
//! `tests/protocol/golden.test.ts`.
//!
//! Regenerating intentionally (protocol change) is a versioned protocol
//! change: bump WIRE_VERSION per PROTOCOL §7 forward-evolution rules, and
//! regenerate with `cargo test golden -- --ignored` then re-run the TS
//! parity suite in the same commit.

use std::path::PathBuf;

use serde::Serialize;

use super::control::*;
use super::data::*;
use super::envelope::{validate_op, OpIdentity};
use super::ProtocolError;

#[derive(Serialize)]
struct TextFixture {
    name: &'static str,
    /// Exact wire text (Rust codec output).
    wire: String,
}

#[derive(Serialize)]
struct BinaryFixture {
    name: &'static str,
    /// Exact wire bytes as lowercase hex.
    hex: String,
    /// Op identities extracted by validated decode, in order.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    identities: Vec<String>,
}

#[derive(Serialize)]
struct ErrorFixture {
    name: &'static str,
    code: &'static str,
    fatal: bool,
}

#[derive(Serialize)]
struct EnvelopeFixture {
    name: &'static str,
    /// Canonical Phase 2 operation bytes (hex).
    op_hex: String,
    /// Identity the gateway must extract.
    identity: String,
}

#[derive(Serialize)]
struct FixtureFile {
    wire_version: u32,
    generated_by: &'static str,
    text_frames: Vec<TextFixture>,
    binary_frames: Vec<BinaryFixture>,
    error_codes: Vec<ErrorFixture>,
    op_envelopes: Vec<EnvelopeFixture>,
}

/// Build a minimal canonical insert op (hand-encoded, pinned bytes).
pub fn golden_insert_op() -> Vec<u8> {
    let mut b = vec![1u8, 1u8];
    b.extend_from_slice(&0xD4u64.to_le_bytes()); // origin replica
    b.extend_from_slice(&17u64.to_le_bytes()); // counter
    b.extend_from_slice(&9u64.to_le_bytes()); // lamport
    b.push(0); // left = None (sequence start)
    b.push(0); // right = None (sequence end)
    b.push(1); // kind = text
    b.push(1); // scalar len
    b.push(b'h'); // scalar 'h'
    b.push(0); // no initial attrs
    b
}

/// Build a minimal canonical delimiter insert (paragraph start).
pub fn golden_delimiter_op() -> Vec<u8> {
    let mut b = vec![1u8, 1u8];
    b.extend_from_slice(&0xD4u64.to_le_bytes());
    b.extend_from_slice(&18u64.to_le_bytes());
    b.extend_from_slice(&10u64.to_le_bytes());
    b.push(1); // left = (0xD4, 17)
    b.extend_from_slice(&0xD4u64.to_le_bytes());
    b.extend_from_slice(&17u64.to_le_bytes());
    b.push(0); // right = None
    b.push(2); // kind = delimiter
    b.push(1); // one initial attr
    b.extend_from_slice(&4u64.to_le_bytes()); // "type"
    b.extend_from_slice(b"type");
    b.push(1); // value present
    b.extend_from_slice(&9u64.to_le_bytes()); // "paragraph"
    b.extend_from_slice(b"paragraph");
    b
}

/// Build a canonical delete op.
pub fn golden_delete_op() -> Vec<u8> {
    let mut b = vec![1u8, 2u8];
    b.extend_from_slice(&0xE2u64.to_le_bytes());
    b.extend_from_slice(&5u64.to_le_bytes());
    b.extend_from_slice(&11u64.to_le_bytes());
    b.extend_from_slice(&0xD4u64.to_le_bytes()); // target replica
    b.extend_from_slice(&17u64.to_le_bytes()); // target counter
    b
}

fn fixtures() -> FixtureFile {
    let text_frames = vec![
        TextFixture {
            name: "hello",
            wire: ControlFrame {
                id: Some("req-1".into()),
                frame: Frame::Hello(Hello { client_protocol_version: 1 }),
            }
            .encode(),
        },
        TextFixture {
            name: "hello_ack",
            wire: ControlFrame {
                id: Some("req-1".into()),
                frame: Frame::HelloAck(HelloAck {
                    protocol_version: 1,
                    connection_id: "conn-0f1e2d3c".into(),
                }),
            }
            .encode(),
        },
        TextFixture {
            name: "authenticate",
            wire: ControlFrame {
                id: None,
                frame: Frame::Authenticate(Authenticate { token: "eyJhbGciOiJSUzI1NiJ9.test-token".into() }),
            }
            .encode(),
        },
        TextFixture {
            name: "authenticated",
            wire: ControlFrame {
                id: None,
                frame: Frame::Authenticated(Authenticated {
                    user_id: "5f0e9a4b-0000-4000-8000-000000000001".into(),
                    clerk_user_id: "user_2testAAAA".into(),
                    org_id: Some("7c1d8e5f-0000-4000-8000-000000000002".into()),
                }),
            }
            .encode(),
        },
        TextFixture {
            name: "join_document",
            wire: ControlFrame {
                id: Some("j-7".into()),
                frame: Frame::JoinDocument(JoinDocument {
                    document_id: "3a2b1c0d-0000-4000-8000-000000000003".into(),
                    state_summary: vec![
                        SummaryEntry { replica_id: "212".into(), sequence: "40".into() },
                        SummaryEntry { replica_id: "340".into(), sequence: "7".into() },
                    ],
                }),
            }
            .encode(),
        },
        TextFixture {
            name: "join_accepted",
            wire: ControlFrame {
                id: Some("j-7".into()),
                frame: Frame::JoinAccepted(JoinAccepted {
                    document_id: "3a2b1c0d-0000-4000-8000-000000000003".into(),
                    role: Role::Editor,
                    durable_cursor: "9223372036854775".into(),
                }),
            }
            .encode(),
        },
        TextFixture {
            name: "sync_request",
            wire: ControlFrame {
                id: None,
                frame: Frame::SyncRequest(SyncRequest { cursor: "9223372036854775".into() }),
            }
            .encode(),
        },
        TextFixture {
            name: "sync_done",
            wire: ControlFrame { id: None, frame: Frame::SyncDone(SyncDone {}) }.encode(),
        },
        TextFixture {
            name: "durable_ack",
            wire: ControlFrame {
                id: Some("b-42".into()),
                frame: Frame::DurableAck(DurableAck {
                    batch_id: "42".into(),
                    op_ids: vec!["212:41".into(), "212:42".into()],
                }),
            }
            .encode(),
        },
        TextFixture {
            name: "ping",
            wire: ControlFrame { id: None, frame: Frame::Ping(Ping { nonce: "314159".into() }) }.encode(),
        },
        TextFixture {
            name: "pong",
            wire: ControlFrame { id: None, frame: Frame::Pong(Pong { nonce: "314159".into() }) }.encode(),
        },
        TextFixture {
            name: "error",
            wire: ControlFrame {
                id: Some("j-7".into()),
                frame: Frame::Error(ErrorFrame {
                    code: "forbidden".into(),
                    message: "no access to this document".into(),
                    request_id: Some("j-7".into()),
                }),
            }
            .encode(),
        },
        TextFixture {
            name: "server_draining",
            wire: ControlFrame {
                id: None,
                frame: Frame::ServerDraining(ServerDraining { reason: "shutdown".into(), grace_ms: 5000 }),
            }
            .encode(),
        },
    ];

    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let ops = vec![golden_insert_op(), golden_delimiter_op(), golden_delete_op()];

    let client_ops = ClientOps { batch_id: 42, ops: ops.clone(), identities: Vec::new() };
    let sync_batch = SyncBatch { next_cursor: 99, has_more: true, ops: ops.clone() };

    let binary_frames = vec![
        BinaryFixture {
            name: "client_ops",
            hex: hex(&DataFrame::ClientOps(client_ops).encode().expect("encode")),
            identities: ops
                .iter()
                .map(|o| validate_op(o).expect("valid").identity.to_wire())
                .collect(),
        },
        BinaryFixture {
            name: "sync_batch",
            hex: hex(&DataFrame::SyncBatch(sync_batch).encode().expect("encode")),
            identities: Vec::new(),
        },
    ];

    let error_codes = [
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
    ]
    .iter()
    .map(|c| ErrorFixture { name: "code", code: c.as_str(), fatal: c.is_fatal() })
    .collect();

    let op_envelopes = vec![
        EnvelopeFixture {
            name: "insert_text",
            op_hex: hex(&golden_insert_op()),
            identity: OpIdentity { replica: 0xD4, counter: 17 }.to_wire(),
        },
        EnvelopeFixture {
            name: "insert_delimiter",
            op_hex: hex(&golden_delimiter_op()),
            identity: OpIdentity { replica: 0xD4, counter: 18 }.to_wire(),
        },
        EnvelopeFixture {
            name: "delete",
            op_hex: hex(&golden_delete_op()),
            identity: OpIdentity { replica: 0xE2, counter: 5 }.to_wire(),
        },
    ];

    FixtureFile {
        wire_version: super::WIRE_VERSION,
        generated_by: "rust/sync-gateway/src/protocol/golden.rs",
        text_frames,
        binary_frames,
        error_codes,
        op_envelopes,
    }
}

/// Repo-root fixtures path (works from `rust/` cargo invocations).
pub fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/protocol/v1/golden.json")
}

/// Writes the golden fixture file (generator mode).
#[test]
#[ignore = "generator: run with `cargo test golden -- --ignored` on intentional protocol changes"]
fn regenerate_golden_fixtures() {
    let file = fixtures();
    let json = serde_json::to_string_pretty(&file).expect("serialize fixtures");
    let path = fixture_path();
    std::fs::write(&path, json).expect("write fixture file");
    println!("wrote {}", path.display());
}

/// Parity check against the COMMITTED fixtures: the Rust codec must still
/// produce byte-identical output. If this fails after an intentional
/// protocol change, regenerate (see module docs) and bump the version.
#[test]
fn golden_text_frames_round_trip() {
    let file = fixtures();
    for fixture in &file.text_frames {
        let decoded = ControlFrame::decode(&fixture.wire)
            .unwrap_or_else(|e| panic!("fixture {} failed decode: {e:?}", fixture.name));
        assert_eq!(
            decoded.encode(),
            fixture.wire,
            "fixture {} is not a fixed point of encode/decode",
            fixture.name
        );
    }
}

#[test]
fn golden_binary_frames_match_committed_bytes() {
    let file = fixtures();
    let committed: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(fixture_path())
            .expect("committed fixtures must exist; run the generator test once"),
    )
    .expect("fixture file is valid JSON");
    assert_eq!(
        committed["wire_version"].as_u64(),
        Some(super::WIRE_VERSION as u64),
        "committed fixture version drift"
    );
    for (i, fixture) in file.binary_frames.iter().enumerate() {
        let committed_hex = committed["binary_frames"][i]["hex"]
            .as_str()
            .expect("binary fixture hex present");
        assert_eq!(&fixture.hex, committed_hex, "binary fixture {} drifted", fixture.name);
    }
    for (i, fixture) in file.op_envelopes.iter().enumerate() {
        let committed_hex = committed["op_envelopes"][i]["op_hex"].as_str().expect("envelope hex");
        assert_eq!(&fixture.op_hex, committed_hex, "op envelope {} drifted", fixture.name);
        let committed_id = committed["op_envelopes"][i]["identity"].as_str().expect("identity");
        assert_eq!(&fixture.identity, committed_id, "op identity {} drifted", fixture.name);
    }
}
