//! Redis ephemeral tier: presence + distributed rate limiting
//! (P4-M021/M022/M023/M024; DEC-033).
//!
//! STRICT RULES (non-negotiable #3/#12):
//! - No document content, ACLs, or operation payloads ever touch Redis.
//! - Every key is namespaced (`concord:<ns>:`) and TTL-carrying where
//!   staleness matters (presence, hints). Expiry is the authority;
//!   cleanup is best-effort.
//! - Redis loss NEVER crashes the gateway or corrupts durable state:
//!   presence degrades to absent; rate limiting falls back to LOCAL
//!   per-gateway token buckets (documented fail-open choice — availability
//!   over strictness, with local caps still bounding abuse per gateway).

pub mod presence;
pub mod ratelimit;

pub use presence::PresenceStore;
pub use ratelimit::{RateLimitOutcome, RateLimiter};

use std::time::Duration;

/// Errors: structured; failures mean "degraded", not "crash".
#[derive(Debug, thiserror::Error)]
pub enum EphemeralError {
    #[error("redis unavailable")]
    Unavailable,
    #[error("redis operation failed")]
    Operation,
}

/// Redis connection parameters (URL + namespace) for both stores.
#[derive(Clone)]
pub struct RedisConfig {
    pub url: String,
    pub namespace: String,
}

/// Shared Redis connection manager with bounded reconnect semantics
/// (M021: connection-manager auto-reconnects; timeouts cap every op).
/// Cheap-clone handle (the manager multiplexes internally).
#[derive(Clone)]
pub struct RedisHandle {
    client: redis::aio::ConnectionManager,
    namespace: String,
}

impl RedisHandle {
    /// Connect once with a timeout; errors are explicit (caller starts
    /// degraded, never crashes).
    pub async fn connect(config: &RedisConfig) -> Result<Self, EphemeralError> {
        let client =
            redis::Client::open(config.url.as_str()).map_err(|_| EphemeralError::Unavailable)?;
        let conn = tokio::time::timeout(
            Duration::from_secs(5),
            redis::aio::ConnectionManager::new(client),
        )
        .await
        .map_err(|_| EphemeralError::Unavailable)?
        .map_err(|_| EphemeralError::Unavailable)?;
        Ok(Self {
            client: conn,
            namespace: config.namespace.clone(),
        })
    }

    pub fn namespaced(&self, key: &str) -> String {
        format!("concord:{}:{}", self.namespace, key)
    }

    /// Cloned manager handle for bounded per-op commands (M021).
    pub fn manager(&self) -> redis::aio::ConnectionManager {
        self.client.clone()
    }

    pub fn ns(&self) -> &str {
        &self.namespace
    }
}
