//! PostgreSQL layer: bounded pool, migrations, repositories (P3-M014+).
//!
//! - Pool: `deadpool-postgres` (bounded, explicit sizing, fail-fast on
//!   startup), query timeouts at call sites, structured errors — never
//!   string-concatenated SQL (all queries are static + parameterized).
//! - Migrations: an embedded, idempotent runner with its own
//!   `gateway_schema_migrations` registry — separate from Drizzle's
//!   `__drizzle_migrations` (Phase 1 owns that one); the two registries
//!   never collide.
//! - Authorization: ONE canonical policy layer mirroring Phase 1's
//!   `src/server/auth/authorization.ts` effective-role precedence
//!   (owner > direct ACL > org-member EDITOR > deny), evaluated in SQL and
//!   mapped in Rust.

pub mod authz;
pub mod migrations;
pub mod pool;
pub mod repo;
pub mod snapshots;

pub use authz::{DocumentAccess, EffectiveRole};
pub use migrations::{run_migrations, MigrationError};
pub use pool::{Db, PoolHealth};
pub use repo::GatewayRepo;
pub use snapshots::{
    validate_integrity, SnapshotIntegrityError, SnapshotRepo, SnapshotRepoError, SnapshotRow,
    ValidatedSnapshot, SUPPORTED_FORMAT_VERSION,
};

use std::time::Duration;

/// Query/statement timeout for gateway DB calls (M014: explicit timeouts).
pub const DB_QUERY_TIMEOUT: Duration = Duration::from_secs(10);
