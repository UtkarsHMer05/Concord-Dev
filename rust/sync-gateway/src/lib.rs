//! Concord Realtime Sync Gateway — lib surface.
//!
//! Phases: P3-M008..M050, P5 (snapshots/recovery). The library exposes
//! the gateway modules so the binary (`main.rs`) stays thin and
//! integration tests can drive the server.

pub mod auth;
pub mod broker;
pub mod build_info;
pub mod bus;
pub mod config;
pub mod db;
pub mod ephemeral;
pub mod error;
pub mod http;
pub mod maintenance;
pub mod observability;
pub mod protocol;
pub mod sessions;
pub mod telemetry;
pub mod worker;
pub mod ws;

/// Release version of this gateway (workspace package version, mirrored
/// from package.json / the CMake project VERSION — one release identity).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The wire protocol version spoken by this gateway (PROTOCOL §9.1).
/// A SEPARATE wire contract — never bump it together with VERSION.
pub const WIRE_PROTOCOL_VERSION: u32 = 1;
