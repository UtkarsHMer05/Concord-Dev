//! Bounded PostgreSQL pool + health (P3-M014).
//!
//! Startup behavior is explicit: `Db::connect` verifies the database is
//! reachable (one round-trip) and fails fast otherwise; the gateway never
//! starts in an ambiguous DB state. Pool size is bounded by config.
//! Readiness (M021) distinguishes "process alive" from "DB usable" via
//! `PoolHealth`.

use deadpool_postgres::{Manager, Pool};
use tokio_postgres::NoTls;

use crate::config::Config;

/// Wrapped bounded pool with explicit startup and health semantics.
#[derive(Clone)]
pub struct Db {
    pool: Pool,
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db")
            .field("max_size", &self.pool.status().max_size)
            .field("available", &self.pool.status().available)
            .finish()
    }
}

/// Readiness-relevant health of the database dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolHealth {
    Healthy,
    Unhealthy,
}

#[derive(Debug, thiserror::Error)]
pub enum PoolError {
    #[error("database configuration rejected: {0}")]
    Config(String),
    #[error("database unreachable at startup: {0}")]
    Unreachable(String),
    #[error("pool exhausted: {0}")]
    Exhausted(String),
    #[error("database error: {0}")]
    Query(#[from] tokio_postgres::Error),
}

impl Db {
    /// Builds the pool and verifies connectivity once. Fails fast when the
    /// database is unavailable — the gateway does not start "maybe".
    pub async fn connect(config: &Config) -> Result<Self, PoolError> {
        let url = parse_url(&config.database_url)?;
        let mgr = Manager::new(url, NoTls);
        let pool = Pool::builder(mgr)
            .max_size(config.db_pool_size as usize)
            .build()
            .map_err(|e| PoolError::Config(e.to_string()))?;

        // Startup round-trip: confirms credentials + connectivity.
        let client = pool
            .get()
            .await
            .map_err(|e| PoolError::Unreachable(e.to_string()))?;
        client
            .simple_query("SELECT 1")
            .await
            .map_err(|e| PoolError::Unreachable(e.to_string()))?;
        drop(client);

        Ok(Self { pool })
    }

    /// Leases a connection for one query scope.
    pub async fn get(&self) -> Result<deadpool_postgres::Client, PoolError> {
        self.pool
            .get()
            .await
            .map_err(|e| PoolError::Exhausted(e.to_string()))
    }

    /// Liveness probe for readiness (cheap, no table access).
    pub async fn health(&self) -> PoolHealth {
        match self.pool.get().await {
            Err(_) => PoolHealth::Unhealthy,
            Ok(client) => match client.simple_query("SELECT 1").await {
                Ok(_) => PoolHealth::Healthy,
                Err(_) => PoolHealth::Unhealthy,
            },
        }
    }
}

fn parse_url(url: &str) -> Result<tokio_postgres::Config, PoolError> {
    // URL-form config parsing is built into tokio-postgres; passwords with
    // special characters must be percent-encoded by the operator (standard
    // postgres URL semantics). The value is never logged.
    url.parse::<tokio_postgres::Config>()
        .map_err(|e| PoolError::Config(format!("invalid DATABASE_URL: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_url_rejected_without_network() {
        // Bad port forms are config errors at parse time.
        let err = parse_url("postgres://u:p@127.0.0.1:notaport/db");
        assert!(
            matches!(err, Err(PoolError::Config(_))),
            "bad port must be a config error, got {err:?}"
        );
        let err = parse_url("postgres://host:99999/db");
        assert!(
            matches!(err, Err(PoolError::Config(_))),
            "port overflow must be a config error, got {err:?}"
        );
        // NOTE: a literal-percent host like "%zz" parses (libpq does not
        // percent-decode hosts); it fails later at TCP connect time — that
        // startup behavior is covered by Db::connect integration tests.
    }

    #[test]
    fn valid_urls_parse() {
        parse_url("postgres://u:p@127.0.0.1:5433/concord").expect("valid URL parses");
        parse_url("postgresql://u:p@localhost:5432/db?sslmode=disable").expect("valid URL parses");
    }
}
