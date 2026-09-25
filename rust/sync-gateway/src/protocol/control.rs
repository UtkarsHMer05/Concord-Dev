//! Control frames: typed JSON text messages (P3-M011, PROTOCOL §9.2/§9.4).
//!
//! One envelope `{v, type, id?, payload}`; each frame type has a strict
//! payload struct. Decode is strict: unknown versions/types and shape
//! violations are `DecodeError`s; there is deliberately no "extra fields
//! ignored" path (serde denies unknown fields) so protocol drift is
//! caught, not silently tolerated.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::error::DecodeError;
use super::limits::MAX_TOKEN_BYTES;
use super::WIRE_VERSION;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/// A decoded control frame with its optional correlation id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ControlFrame {
    /// Correlation id echoed verbatim in the matching reply (may be absent).
    pub id: Option<String>,
    /// The typed frame payload.
    pub frame: Frame,
}

/// Every control frame payload, discriminated by Rust's enum (the wire
/// discriminator is the envelope `type` string).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum Frame {
    #[serde(rename = "hello")]
    Hello(Hello),
    #[serde(rename = "hello_ack")]
    HelloAck(HelloAck),
    #[serde(rename = "authenticate")]
    Authenticate(Authenticate),
    #[serde(rename = "authenticated")]
    Authenticated(Authenticated),
    #[serde(rename = "join_document")]
    JoinDocument(JoinDocument),
    #[serde(rename = "join_accepted")]
    JoinAccepted(JoinAccepted),
    #[serde(rename = "sync_request")]
    SyncRequest(SyncRequest),
    #[serde(rename = "sync_done")]
    SyncDone(SyncDone),
    #[serde(rename = "snapshot_resync_required")]
    SnapshotResyncRequired(SnapshotResyncRequired),
    #[serde(rename = "fetch_snapshot")]
    FetchSnapshot(FetchSnapshot),
    #[serde(rename = "snapshot_payload")]
    SnapshotPayload(SnapshotPayload),
    #[serde(rename = "durable_ack")]
    DurableAck(DurableAck),
    #[serde(rename = "ping")]
    Ping(Ping),
    #[serde(rename = "pong")]
    Pong(Pong),
    #[serde(rename = "error")]
    Error(ErrorFrame),
    #[serde(rename = "server_draining")]
    ServerDraining(ServerDraining),
    #[serde(rename = "presence")]
    Presence(PresenceState),
    #[serde(rename = "presence_update")]
    PresenceUpdate(PresenceUpdate),
    #[serde(rename = "presence_leave")]
    PresenceLeave(PresenceLeave),
}

// ---------------------------------------------------------------------------
// Payload types (field order and names are the wire contract — mirrored
// in TypeScript; golden fixtures pin them)
// ---------------------------------------------------------------------------

/// c→s: version negotiation opener. Must be the first frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hello {
    pub client_protocol_version: u32,
}

/// s→c: accepted version + unique connection id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelloAck {
    pub protocol_version: u32,
    pub connection_id: String,
}

/// c→s: Clerk session JWT (never in a URL query string; PROTOCOL §9.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authenticate {
    pub token: String,
}

/// s→c: principal derived ONLY from the verified token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authenticated {
    pub user_id: String,
    pub clerk_user_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
}

/// c→s: join a document room, carrying the client's state summary
/// (per-replica counters as decimal strings; u64-safe for JS).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinDocument {
    pub document_id: String,
    pub state_summary: Vec<SummaryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SummaryEntry {
    pub replica_id: String,
    pub sequence: String,
}

/// s→c: join result with server-computed role + durable high-water mark.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JoinAccepted {
    pub document_id: String,
    pub role: Role,
    pub durable_cursor: String,
}

/// Effective role, always computed server-side from PostgreSQL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Editor,
    Commenter,
    Viewer,
}

impl Role {
    pub fn can_edit(self) -> bool {
        matches!(self, Role::Owner | Role::Editor)
    }
}

/// c→s: request catch-up ops strictly after this server-seq cursor
/// (decimal string). Cursor 0 = full history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncRequest {
    pub cursor: String,
}

/// s→c: catch-up finished; connection becomes READY.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncDone {}

/// s→c (P5-M031): the client's cursor precedes the document's
/// compaction floor — delta catch-up is impossible; the client must
/// fetch and import the covering server snapshot, then resume delta
/// catch-up from the snapshot's boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotResyncRequired {
    /// Compaction floor (u64 as decimal string, client-safe).
    pub boundary: String,
    /// The covering snapshot's public id.
    pub snapshot_id: String,
    /// SHA-256 hex over the wrapper payload bytes the client will
    /// fetch (out-of-band integrity check; STORAGE.md §3.1).
    pub snapshot_checksum: String,
    /// Wrapper format version (decimal string).
    pub snapshot_format_version: String,
    /// Ops the covering snapshot represents (decimal string).
    pub coverage_op_count: String,
}

/// c→s (P5-M031): fetch a snapshot by id (the resync payload exchange
/// rides the same authenticated WS session; the payload itself is
/// delivered as the frame's fields, base64-encoded wrapper bytes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FetchSnapshot {
    pub snapshot_id: String,
}

/// s→c (P5-M031): the requested snapshot, validated server-side before
/// send (format, document association, checksum) — the client still
/// re-validates independently (defense in depth, M031.3).
///
/// `payload_size` carries the wrapper's exact byte length (SEC5-3 fix):
/// the client's `size_mismatch` defense compares the declared size to
/// the decoded payload BEFORE hashing, so the check is live on this
/// transport, not only on a future HTTP envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotPayload {
    pub snapshot_id: String,
    pub format_version: String,
    pub coverage_seq: String,
    pub covered_op_count: String,
    pub state_digest: String,
    pub checksum: String,
    pub payload_base64: String,
    /// Wrapper byte length (u64 as decimal string).
    pub payload_size: String,
}

/// s→c: the batch met the documented persistence contract (ACK_DURABLE,
/// FAILURE_MODEL §1) — PostgreSQL commit under stable identity, atomic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableAck {
    pub batch_id: String,
    pub op_ids: Vec<String>,
}

/// Heartbeat (either direction; nonce as decimal string, u64-safe).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ping {
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Pong {
    pub nonce: String,
}

/// Safe error frame (PROTOCOL §9.8): code vocabulary only; messages never
/// contain SQL details, stack traces, or internal identifiers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ErrorFrame {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

/// s→c: graceful drain notice (P3-M041).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerDraining {
    pub reason: String,
    pub grace_ms: u32,
}

/// Which side of a CRDT item a presence caret/selection endpoint sits on
/// (mirrors `CrdtAnchorPoint.side` on the client). Bounded enum keeps the
/// `Frame` `Eq` derive valid — presence state is opaque, not `serde_json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresenceSide {
    Before,
    After,
}

/// c→s (Feature 2, ephemeral/NON-durable): the sender's live caret/selection,
/// anchored to CRDT item ids ("r:c") so it stays glued to the right text while
/// peers edit concurrently. Relayed to room peers; NEVER persisted and never
/// authorization truth. Legal only in READY. `*_item` is None when the caret
/// cannot be anchored to a live item (e.g. empty document).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresenceState {
    pub replica_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_item: Option<String>,
    pub anchor_side: PresenceSide,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_item: Option<String>,
    pub head_side: PresenceSide,
}

/// s→c: one peer's relayed presence. `connection_id` and `user_id` are stamped
/// by the gateway from the authenticated session (unforgeable); `replica_id`
/// and the anchor are the sender's low-trust hints (color + position only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresenceUpdate {
    pub connection_id: String,
    pub user_id: String,
    pub replica_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_item: Option<String>,
    pub anchor_side: PresenceSide,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_item: Option<String>,
    pub head_side: PresenceSide,
}

/// s→c: a peer left the room; drop its caret immediately (peers also expire on
/// a client-side TTL when a sender goes silent without a clean leave).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresenceLeave {
    pub connection_id: String,
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

impl ControlFrame {
    /// Decode one text message into a typed control frame. Strict: the
    /// input must be fully consumed, the version must be supported, the
    /// type must be known, and the payload shape must match exactly.
    pub fn decode(text: &str) -> Result<Self, DecodeError> {
        // Two-phase: parse the envelope shape first so unknown versions
        // and unknown types report precisely.
        let raw: serde_json::Value =
            serde_json::from_str(text).map_err(|_| DecodeError::InvalidJson)?;

        let obj = raw.as_object().ok_or_else(|| DecodeError::BadEnvelope {
            reason: "not a JSON object".into(),
        })?;

        for required in ["v", "type", "payload"] {
            if !obj.contains_key(required) {
                return Err(DecodeError::BadEnvelope {
                    reason: format!("missing envelope field '{required}'"),
                });
            }
        }
        let extra: Vec<&String> = obj
            .keys()
            .filter(|k| !matches!(k.as_str(), "v" | "type" | "payload" | "id"))
            .collect();
        if !extra.is_empty() {
            return Err(DecodeError::BadEnvelope {
                reason: format!("unexpected extra envelope fields: {extra:?}"),
            });
        }

        let version = obj["v"].as_u64().ok_or_else(|| DecodeError::BadEnvelope {
            reason: "'v' must be an integer".into(),
        })?;
        if version != WIRE_VERSION as u64 {
            return Err(DecodeError::UnsupportedVersion {
                version: version as u32,
            });
        }

        let frame_type = obj["type"]
            .as_str()
            .ok_or_else(|| DecodeError::BadEnvelope {
                reason: "'type' must be a string".into(),
            })?
            .to_owned();

        let id = match obj.get("id") {
            None => None,
            Some(v) => Some(
                v.as_str()
                    .ok_or_else(|| DecodeError::BadEnvelope {
                        reason: "'id' must be a string".into(),
                    })?
                    .to_owned(),
            ),
        };

        let payload = &obj["payload"];
        let frame = match frame_type.as_str() {
            "hello" => Frame::Hello(strict_payload::<Hello>(payload)?),
            "hello_ack" => Frame::HelloAck(strict_payload::<HelloAck>(payload)?),
            "authenticate" => Frame::Authenticate(strict_payload::<Authenticate>(payload)?),
            "authenticated" => Frame::Authenticated(strict_payload::<Authenticated>(payload)?),
            "join_document" => Frame::JoinDocument(strict_payload::<JoinDocument>(payload)?),
            "join_accepted" => Frame::JoinAccepted(strict_payload::<JoinAccepted>(payload)?),
            "sync_request" => Frame::SyncRequest(strict_payload::<SyncRequest>(payload)?),
            "sync_done" => Frame::SyncDone(strict_payload::<SyncDone>(payload)?),
            "snapshot_resync_required" => {
                Frame::SnapshotResyncRequired(strict_payload::<SnapshotResyncRequired>(payload)?)
            }
            "fetch_snapshot" => Frame::FetchSnapshot(strict_payload::<FetchSnapshot>(payload)?),
            "snapshot_payload" => {
                Frame::SnapshotPayload(strict_payload::<SnapshotPayload>(payload)?)
            }
            "durable_ack" => Frame::DurableAck(strict_payload::<DurableAck>(payload)?),
            "ping" => Frame::Ping(strict_payload::<Ping>(payload)?),
            "pong" => Frame::Pong(strict_payload::<Pong>(payload)?),
            "error" => Frame::Error(strict_payload::<ErrorFrame>(payload)?),
            "server_draining" => Frame::ServerDraining(strict_payload::<ServerDraining>(payload)?),
            "presence" => Frame::Presence(strict_payload::<PresenceState>(payload)?),
            "presence_update" => Frame::PresenceUpdate(strict_payload::<PresenceUpdate>(payload)?),
            "presence_leave" => Frame::PresenceLeave(strict_payload::<PresenceLeave>(payload)?),
            other => {
                return Err(DecodeError::UnknownFrameType {
                    frame_type: other.to_owned(),
                });
            }
        };

        // Defense-in-depth wire cap (PROTOCOL §9.11): reject oversized
        // bearer tokens before they reach the auth layer.
        if let Frame::Authenticate(p) = &frame {
            if p.token.len() > MAX_TOKEN_BYTES {
                return Err(DecodeError::TooLarge { what: "token" });
            }
        }

        Ok(Self { id, frame })
    }

    /// Encode a control frame to its wire text. Infallible for frames the
    /// gateway constructs; panics only on programmer-constructed nonsense.
    pub fn encode(&self) -> String {
        let (type_name, payload) = match &self.frame {
            Frame::Hello(p) => ("hello", serde_json::to_value(p)),
            Frame::HelloAck(p) => ("hello_ack", serde_json::to_value(p)),
            Frame::Authenticate(p) => ("authenticate", serde_json::to_value(p)),
            Frame::Authenticated(p) => ("authenticated", serde_json::to_value(p)),
            Frame::JoinDocument(p) => ("join_document", serde_json::to_value(p)),
            Frame::JoinAccepted(p) => ("join_accepted", serde_json::to_value(p)),
            Frame::SyncRequest(p) => ("sync_request", serde_json::to_value(p)),
            Frame::SyncDone(p) => ("sync_done", serde_json::to_value(p)),
            Frame::SnapshotResyncRequired(p) => {
                ("snapshot_resync_required", serde_json::to_value(p))
            }
            Frame::FetchSnapshot(p) => ("fetch_snapshot", serde_json::to_value(p)),
            Frame::SnapshotPayload(p) => ("snapshot_payload", serde_json::to_value(p)),
            Frame::DurableAck(p) => ("durable_ack", serde_json::to_value(p)),
            Frame::Ping(p) => ("ping", serde_json::to_value(p)),
            Frame::Pong(p) => ("pong", serde_json::to_value(p)),
            Frame::Error(p) => ("error", serde_json::to_value(p)),
            Frame::ServerDraining(p) => ("server_draining", serde_json::to_value(p)),
            Frame::Presence(p) => ("presence", serde_json::to_value(p)),
            Frame::PresenceUpdate(p) => ("presence_update", serde_json::to_value(p)),
            Frame::PresenceLeave(p) => ("presence_leave", serde_json::to_value(p)),
        };
        let payload = payload.expect("serializing a gateway-constructed payload cannot fail");
        let mut envelope = serde_json::Map::new();
        envelope.insert("v".into(), WIRE_VERSION.into());
        if let Some(id) = &self.id {
            envelope.insert("id".into(), id.clone().into());
        }
        envelope.insert("type".into(), type_name.into());
        envelope.insert("payload".into(), payload);
        serde_json::to_string(&serde_json::Value::Object(envelope))
            .expect("envelope serialization cannot fail")
    }
}

/// Strict payload decode: must be a JSON object matching the payload type
/// exactly (every payload struct is `deny_unknown_fields`).
fn strict_payload<T: DeserializeOwned>(payload: &serde_json::Value) -> Result<T, DecodeError> {
    if !payload.is_object() {
        return Err(DecodeError::BadPayload {
            reason: "payload must be a JSON object".into(),
        });
    }
    serde_json::from_value(payload.clone()).map_err(|e| DecodeError::BadPayload {
        reason: e.to_string(),
    })
}

#[cfg(test)]
mod presence_tests {
    use super::*;

    fn roundtrip(frame: Frame) -> Frame {
        let wire = ControlFrame { id: None, frame }.encode();
        ControlFrame::decode(&wire).expect("decode").frame
    }

    #[test]
    fn presence_state_roundtrips_with_optional_items() {
        let full = Frame::Presence(PresenceState {
            replica_id: "42".into(),
            anchor_item: Some("7:3".into()),
            anchor_side: PresenceSide::Before,
            head_item: Some("7:9".into()),
            head_side: PresenceSide::After,
        });
        assert_eq!(roundtrip(full.clone()), full);

        // Unanchored caret (empty doc): items omitted on the wire.
        let bare = Frame::Presence(PresenceState {
            replica_id: "42".into(),
            anchor_item: None,
            anchor_side: PresenceSide::Before,
            head_item: None,
            head_side: PresenceSide::Before,
        });
        assert_eq!(roundtrip(bare.clone()), bare);
    }

    #[test]
    fn presence_relay_frames_roundtrip() {
        let update = Frame::PresenceUpdate(PresenceUpdate {
            connection_id: "conn-1".into(),
            user_id: "5f0e9a4b-0000-4000-8000-000000000001".into(),
            replica_id: "42".into(),
            anchor_item: Some("7:3".into()),
            anchor_side: PresenceSide::After,
            head_item: None,
            head_side: PresenceSide::Before,
        });
        assert_eq!(roundtrip(update.clone()), update);
        let leave = Frame::PresenceLeave(PresenceLeave {
            connection_id: "conn-1".into(),
        });
        assert_eq!(roundtrip(leave.clone()), leave);
    }

    #[test]
    fn presence_rejects_unknown_fields_and_bad_side() {
        let extra = r#"{"v":1,"type":"presence","payload":{"replicaId":"1","anchorSide":"before","headSide":"before","bogus":1}}"#;
        assert!(ControlFrame::decode(extra).is_err());
        let bad_side = r#"{"v":1,"type":"presence","payload":{"replicaId":"1","anchorSide":"sideways","headSide":"before"}}"#;
        assert!(ControlFrame::decode(bad_side).is_err());
    }
}
