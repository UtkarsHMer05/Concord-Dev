//! Gateway error architecture (P3-M008 extension).
//!
//! Domain errors map to safe protocol error codes at the boundary (P3-M030);
//! detailed context stays in server logs, never in client-facing frames.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum GatewayError {
    #[error("configuration error: {0}")]
    Config(#[from] crate::config::ConfigError),

    #[error("database pool error: {0}")]
    DbPool(#[from] deadpool_postgres::PoolError),

    #[error("database query error: {0}")]
    Db(#[from] tokio_postgres::Error),

    #[error("database unavailable")]
    DatabaseUnavailable,

    #[error("authentication error: {0}")]
    Authn(String),

    #[error("authorization error: {0}")]
    Authz(String),

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("malformed input: {0}")]
    Malformed(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("internal error: {0}")]
    Internal(String),
}

impl GatewayError {
    /// Whether a retry of the underlying operation is likely to succeed.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            GatewayError::DbPool(_) | GatewayError::Db(_) | GatewayError::DatabaseUnavailable
        )
    }
}
