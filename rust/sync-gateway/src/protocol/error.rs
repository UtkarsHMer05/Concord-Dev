//! Protocol decode/encode errors and wire error codes (P3-M030 codes).
//!
//! Decode errors are structured and exhaustive — no panics on hostile
//! input. Wire error codes are the safe, client-facing vocabulary
//! (PROTOCOL §9.8); internal details stay in server logs.

/// Structured decode failure for any inbound frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// The raw message (text or binary) exceeded the configured frame limit.
    FrameTooLarge { size: usize },
    /// A text frame was not valid UTF-8.
    InvalidUtf8,
    /// JSON syntax error in a control frame.
    InvalidJson,
    /// Envelope shape wrong (missing `v`/`type`/`payload`, or extra fields).
    BadEnvelope { reason: String },
    /// Envelope `v` is not a supported wire protocol version.
    UnsupportedVersion { version: u32 },
    /// `type` is not a known frame name.
    UnknownFrameType { frame_type: String },
    /// Payload did not match the shape required for the frame type.
    BadPayload { reason: String },
    /// A binary data frame header was malformed or truncated.
    BadBinaryHeader { reason: String },
    /// A binary data frame body violated framing (op length/count bounds,
    /// trailing bytes).
    BadBinaryBody { reason: String },
    /// A CRDT operation envelope failed structural validation (identity,
    /// bounds, exact-consume).
    BadOperation { reason: String },
    /// A bounded field exceeded its wire limit (token size etc.).
    TooLarge { what: &'static str },
}

/// Encode failure (always a programming/limit violation, never hostile
/// input — the gateway only encodes frames it constructed itself).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    BatchTooManyOps { count: usize },
    BatchTooLarge { bytes: usize },
    OpTooLarge { bytes: usize },
    Internal(&'static str),
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EncodeError::BatchTooManyOps { count } => {
                write!(
                    f,
                    "batch has {count} ops (max {})",
                    crate::protocol::MAX_BATCH_OPS
                )
            }
            EncodeError::BatchTooLarge { bytes } => write!(
                f,
                "batch payload {bytes} bytes exceeds {}",
                crate::protocol::limits::MAX_BATCH_PAYLOAD_BYTES
            ),
            EncodeError::OpTooLarge { bytes } => {
                write!(
                    f,
                    "operation {bytes} bytes exceeds {}",
                    crate::protocol::MAX_OP_BYTES
                )
            }
            EncodeError::Internal(reason) => write!(f, "internal encode error: {reason}"),
        }
    }
}

impl std::error::Error for EncodeError {}

/// Gateway error codes carried on the wire (PROTOCOL §9.8). Safe to send
/// to clients; the string form is exactly what appears in `error` frames.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    Unauthorized,
    Forbidden,
    UnsupportedProtocolVersion,
    UnknownFrameType,
    InvalidState,
    MalformedFrame,
    PayloadTooLarge,
    RateLimited,
    DatabaseUnavailable,
    ServerDraining,
    InternalError,
}

impl ProtocolError {
    /// Wire string for this code (matches TypeScript mirror exactly).
    pub fn as_str(self) -> &'static str {
        match self {
            ProtocolError::Unauthorized => "unauthorized",
            ProtocolError::Forbidden => "forbidden",
            ProtocolError::UnsupportedProtocolVersion => "unsupported_protocol_version",
            ProtocolError::UnknownFrameType => "unknown_frame_type",
            ProtocolError::InvalidState => "invalid_state",
            ProtocolError::MalformedFrame => "malformed_frame",
            ProtocolError::PayloadTooLarge => "payload_too_large",
            ProtocolError::RateLimited => "rate_limited",
            ProtocolError::DatabaseUnavailable => "database_unavailable",
            ProtocolError::ServerDraining => "server_draining",
            ProtocolError::InternalError => "internal_error",
        }
    }

    /// Whether this error should close the connection after being sent.
    pub fn is_fatal(self) -> bool {
        matches!(
            self,
            ProtocolError::Unauthorized
                | ProtocolError::UnsupportedProtocolVersion
                | ProtocolError::PayloadTooLarge
        )
    }
}

/// Parse a wire error-code string (used by tests + TS parity fixtures).
pub fn error_code_from_str(s: &str) -> Option<ProtocolError> {
    [
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
    .into_iter()
    .find(|code| code.as_str() == s)
}

/// Alias kept for readability at call sites.
pub fn error_code_to_str(code: ProtocolError) -> &'static str {
    code.as_str()
}
