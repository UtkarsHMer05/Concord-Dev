//! Concord Realtime Sync Gateway — lib surface.
//!
//! Phases: P3-M008..M050. The library exposes the gateway modules so the
//! binary (`main.rs`) stays thin and integration tests can drive the server.

pub mod auth;
pub mod broker;
pub mod bus;
pub mod config;
pub mod db;
pub mod ephemeral;
pub mod error;
pub mod http;
pub mod protocol;
pub mod sessions;
pub mod telemetry;
pub mod ws;

/// The wire protocol version spoken by this gateway (PROTOCOL §9.1).
pub const WIRE_PROTOCOL_VERSION: u32 = 1;
