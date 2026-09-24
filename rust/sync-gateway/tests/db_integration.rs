//! DB integration tests (P3-M014/015/017/018/019/020).
//!
//! Run against the Docker Postgres test database
//! (`postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test`),
//! isolated from the dev database. Skipped automatically when the test DB
//! is unreachable (documented gate requirement: docker compose up -d db).
//!
//! Fixtures: each test creates its own users/documents/ACLs in a dedicated
//! transaction scope and cleans up — no shared mutable state between tests.

use std::str::FromStr;

use sha2::{Digest, Sha256};
use uuid::Uuid;

use sync_gateway::config::Config;
use sync_gateway::db::authz::EffectiveRole;
use sync_gateway::db::migrations::{current_version, run_migrations};
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::GatewayRepo;
use sync_gateway::db::PoolHealth;
use sync_gateway::protocol::envelope::{validate_op, OpEnvelope};

const TEST_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";

fn test_url() -> String {
    std::env::var("DATABASE_TEST_URL").unwrap_or_else(|_| TEST_URL.into())
}

async fn test_db() -> Option<Db> {
    test_db_at(&test_url()).await
}

async fn test_db_at(database_url: &str) -> Option<Db> {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: database_url.into(),
        clerk_issuer: "https://fun-blowfish-5798.clerk.accounts.dev".into(),
        clerk_audience: None,
        clerk_authorized_party: None,
        require_internal_services: false,
        allowed_origins: vec![],
        trusted_proxy_cidrs: vec![],
        connect_rate_per_min: 240,
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 16,
        heartbeat_interval: std::time::Duration::from_secs(30),
        idle_timeout: std::time::Duration::from_secs(120),
        db_pool_size: 4,
        jwks_file: None,
        nats_url: None,
        nats_subject_prefix: "concord.test".to_string(),
        gateway_id: 1,
        redis_url: None,
        otel_enabled: false,
        otel_endpoint: "http://127.0.0.1:4317".into(),
        otel_sample_ratio: 1.0,
        otel_exporter: "otlp".into(),
        debug_op_ids: false,
        worker_binary: None,
    };
    Db::connect(&config).await.ok() // DB not running: skip (documented gate precondition)
}

/// Simultaneous first starts must serialize the registry DDL and migrations,
/// including when no gateway-owned table exists yet.
#[tokio::test]
async fn concurrent_first_start_migrations_are_idempotent() {
    let Some(admin) = test_db().await else {
        return;
    };
    let client = admin.get().await.expect("admin connection");
    let schema = format!("migration_race_{}", Uuid::new_v4().simple());
    // A separate schema keeps this cold-start regression independent of all
    // other tests. Only the application FK targets are needed by this runner.
    client
        .batch_execute(&format!(
            "CREATE SCHEMA {schema};
             CREATE TABLE {schema}.users (id UUID PRIMARY KEY);
             CREATE TABLE {schema}.documents (id UUID PRIMARY KEY);"
        ))
        .await
        .expect("isolated application schema");
    let url = format!("{}?options=-csearch_path%3D{schema}", test_url());
    let db = test_db_at(&url).await.expect("isolated pool");
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(4));
    let mut starts = Vec::new();
    for _ in 0..4 {
        let db = db.clone();
        let barrier = barrier.clone();
        starts.push(tokio::spawn(async move {
            barrier.wait().await;
            run_migrations(&db).await
        }));
    }
    let mut errors = Vec::new();
    for start in starts {
        match start.await {
            Ok(Ok(())) => {}
            result => errors.push(format!("{result:?}")),
        }
    }
    let version = current_version(&db).await;
    let rows = db
        .get()
        .await
        .expect("isolated connection")
        .query(
            "SELECT version FROM gateway_schema_migrations ORDER BY version",
            &[],
        )
        .await;
    client
        .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .expect("clean up isolated schema");
    assert!(
        errors.is_empty(),
        "concurrent migration failures: {errors:?}"
    );
    assert_eq!(version.expect("current version"), 5);
    let versions: Vec<i32> = rows
        .expect("registry rows")
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(
        versions,
        vec![1, 2, 3, 4, 5],
        "each migration is recorded once"
    );
}

#[tokio::test]
async fn v5_quarantines_existing_client_replicas_and_preserves_operations() {
    let Some(admin) = test_db().await else { return };
    let client = admin.get().await.expect("admin connection");
    let schema = format!("replica_quarantine_{}", Uuid::new_v4().simple());
    let document = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "CREATE SCHEMA {schema};
             CREATE TABLE {schema}.users (id UUID PRIMARY KEY);
             CREATE TABLE {schema}.documents (id UUID PRIMARY KEY);
             CREATE TABLE {schema}.crdt_operations (
                 document_id UUID NOT NULL, replica_id BIGINT NOT NULL);
             CREATE TABLE {schema}.crdt_replica_owners (
                 document_id UUID NOT NULL, replica_id BIGINT NOT NULL,
                 user_id UUID NOT NULL, PRIMARY KEY (document_id, replica_id));
             CREATE TABLE {schema}.gateway_schema_migrations (
                 version INTEGER PRIMARY KEY, name TEXT NOT NULL,
                 applied_at TIMESTAMPTZ NOT NULL DEFAULT now());"
        ))
        .await
        .expect("isolated v4 schema");
    client
        .execute(
            &format!("INSERT INTO {schema}.documents VALUES ($1)"),
            &[&document],
        )
        .await
        .expect("seed document");
    client
        .execute(
            &format!(
                "INSERT INTO {schema}.crdt_operations (document_id, replica_id)
                 VALUES ($1, 9101), ($1, 1380275028), ($1, 1398362947)"
            ),
            &[&document],
        )
        .await
        .expect("seed v4 operation history");
    client
        .batch_execute(&format!(
            "INSERT INTO {schema}.gateway_schema_migrations (version, name)
             SELECT version, 'v' || version FROM generate_series(1, 4) AS s(version)"
        ))
        .await
        .expect("seed v4 migration registry");

    let url = format!("{}?options=-csearch_path%3D{schema}", test_url());
    let db = test_db_at(&url).await.expect("isolated pool");
    run_migrations(&db).await.expect("apply v5");
    let client = db.get().await.expect("isolated connection");
    let legacy_ids: Vec<i64> = client
        .query(
            "SELECT replica_id FROM crdt_legacy_replicas ORDER BY replica_id",
            &[],
        )
        .await
        .expect("quarantined replicas")
        .iter()
        .map(|row| row.get(0))
        .collect();
    let operation_count: i64 = client
        .query_one("SELECT COUNT(*) FROM crdt_operations", &[])
        .await
        .expect("operation count")
        .get(0);
    let version = current_version(&db).await.expect("migration version");
    admin
        .get()
        .await
        .expect("admin connection")
        .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .expect("cleanup isolated schema");

    assert_eq!(legacy_ids, vec![9_101], "maintenance replicas stay exempt");
    assert_eq!(operation_count, 3, "v5 leaves the durable log intact");
    assert_eq!(version, 5);
}

/// Canonical minimal insert op bytes (matches protocol::envelope tests).
fn make_op(replica: u64, counter: u64) -> OpEnvelope {
    let mut b = vec![1u8, 1u8];
    b.extend_from_slice(&replica.to_le_bytes());
    b.extend_from_slice(&counter.to_le_bytes());
    b.extend_from_slice(&1u64.to_le_bytes()); // lamport
    b.push(0);
    b.push(0); // anchors None
    b.push(1); // text
    b.push(1);
    b.push(b'a');
    b.push(0); // no attrs
    validate_op(&b).expect("test op is valid")
}

/// Fixture: a user (+ optional org membership + document + ACL role).
struct Fixture {
    user: Uuid,
    document: Uuid,
}

async fn seed_user(db: &Db, clerk_id: &str, org_member_of: Option<Uuid>) -> Uuid {
    let client = db.get().await.expect("pool");
    let row = client
        .query_one(
            "INSERT INTO users (clerk_user_id) VALUES ($1)
             ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
             RETURNING id",
            &[&clerk_id],
        )
        .await
        .expect("seed user");
    let user: Uuid = row.get("id");
    if let Some(org) = org_member_of {
        client
            .execute(
                "INSERT INTO organization_memberships (organization_id, user_id, role)
                 VALUES ($1, $2, 'member')
                 ON CONFLICT DO NOTHING",
                &[&org, &user],
            )
            .await
            .expect("seed membership");
    }
    user
}

async fn seed_document(db: &Db, owner: Uuid, org: Option<Uuid>) -> Uuid {
    let client = db.get().await.expect("pool");
    let id = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO documents (id, owner_user_id, organization_id, title, initial_content)
             VALUES ($1, $2, $3, 'it-doc', '')",
            &[&id, &owner, &org],
        )
        .await
        .expect("seed document");
    id
}

async fn seed_acl(db: &Db, document: Uuid, user: Uuid, role: &str) {
    let client = db.get().await.expect("pool");
    client
        .execute(
            "INSERT INTO document_user_permissions (document_id, user_id, role)
             VALUES ($1, $2, $3::text::document_role)
             ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role",
            &[&document, &user, &role],
        )
        .await
        .expect("seed acl");
}

async fn cleanup(db: &Db, fixture: &Fixture) {
    let client = db.get().await.expect("pool");
    let _ = client
        .execute("DELETE FROM documents WHERE id = $1", &[&fixture.document])
        .await;
    let _ = client
        .execute("DELETE FROM users WHERE id = $1", &[&fixture.user])
        .await;
}

// ---------------------------------------------------------------------------
// M014 — pool + health
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pool_connects_and_reports_health() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    assert_eq!(db.health().await, PoolHealth::Healthy);
}

#[tokio::test]
async fn pool_fails_fast_on_unreachable_db() {
    let config = Config {
        database_url: "postgres://nobody:nopass@127.0.0.1:59999/nope".into(),
        ..test_config()
    };
    let err = Db::connect(&config).await;
    assert!(err.is_err(), "unreachable DB must fail startup");
}

fn test_config() -> Config {
    Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: test_url(),
        clerk_issuer: "https://fun-blowfish-5798.clerk.accounts.dev".into(),
        clerk_audience: None,
        clerk_authorized_party: None,
        require_internal_services: false,
        allowed_origins: vec![],
        trusted_proxy_cidrs: vec![],
        connect_rate_per_min: 240,
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 16,
        heartbeat_interval: std::time::Duration::from_secs(30),
        idle_timeout: std::time::Duration::from_secs(120),
        db_pool_size: 2,
        jwks_file: None,
        nats_url: None,
        nats_subject_prefix: "concord.test".to_string(),
        gateway_id: 1,
        redis_url: None,
        otel_enabled: false,
        otel_endpoint: "http://127.0.0.1:4317".into(),
        otel_sample_ratio: 1.0,
        otel_exporter: "otlp".into(),
        debug_op_ids: false,
        worker_binary: None,
    }
}

// ---------------------------------------------------------------------------
// M017 — migrations: empty → applied → idempotent re-run
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migrations_apply_and_are_idempotent() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db).await.expect("first apply");
    let v1 = current_version(&db).await.expect("version");
    assert!(v1 >= 1, "at least migration 1 applied");
    // Idempotent: re-running is a no-op and keeps the version stable.
    run_migrations(&db).await.expect("re-apply");
    let v2 = current_version(&db).await.expect("version after re-apply");
    assert_eq!(v1, v2);
}

#[tokio::test]
async fn migration_constraints_exist() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db).await.expect("apply");
    let client = db.get().await.expect("pool");
    // Unique index on (document_id, operation_id) — the durable idempotency key.
    let row = client
        .query_one(
            "SELECT COUNT(*) AS n FROM pg_indexes
             WHERE indexname = 'crdt_operations_identity_uq'
                OR indexname = 'crdt_operations_document_catchup_idx'",
            &[],
        )
        .await
        .expect("index query");
    let n: i64 = row.get("n");
    assert!(n >= 2, "op-log indexes must exist (found {n})");
}

// ---------------------------------------------------------------------------
// M015 — authorization matrix (table-driven across all roles)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn authorization_matrix_owner_editor_commenter_viewer_noaccess() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db).await.expect("apply");
    let repo = GatewayRepo::new(db.clone());

    // Owner + no-access user.
    let owner = seed_user(&db, &format!("it-owner-{}", Uuid::new_v4()), None).await;
    let stranger = seed_user(&db, &format!("it-stranger-{}", Uuid::new_v4()), None).await;
    let doc = seed_document(&db, owner, None).await;

    // Editor / commenter / viewer via direct ACL.
    let editor = seed_user(&db, &format!("it-editor-{}", Uuid::new_v4()), None).await;
    let commenter = seed_user(&db, &format!("it-cm-{}", Uuid::new_v4()), None).await;
    let viewer = seed_user(&db, &format!("it-viewer-{}", Uuid::new_v4()), None).await;
    seed_acl(&db, doc, editor, "EDITOR").await;
    seed_acl(&db, doc, commenter, "COMMENTER").await;
    seed_acl(&db, doc, viewer, "VIEWER").await;

    // Org member (no direct grant) → EDITOR.
    let org_row = db.get().await.expect("pool");
    let org: Uuid = org_row
        .query_one(
            "INSERT INTO organizations (clerk_organization_id, name)
             VALUES ($1, 'it-org') RETURNING id",
            &[&format!("org_it_{}", Uuid::new_v4().simple())],
        )
        .await
        .expect("org")
        .get("id");
    let org_doc = seed_document(&db, owner, Some(org)).await;
    let org_member = seed_user(&db, &format!("it-orgm-{}", Uuid::new_v4()), Some(org)).await;

    let cases = [
        (owner, doc, Some(EffectiveRole::Owner)),
        (editor, doc, Some(EffectiveRole::Editor)),
        (commenter, doc, Some(EffectiveRole::Commenter)),
        (viewer, doc, Some(EffectiveRole::Viewer)),
        (stranger, doc, None),
        (org_member, org_doc, Some(EffectiveRole::Editor)),
        (stranger, Uuid::new_v4(), None), // nonexistent doc = no leak
    ];
    for (user, document, expected) in cases {
        let access = repo
            .document_access(sync_gateway::db::repo::UserId(user), document)
            .await;
        let got = access.expect("query ok").map(|a| a.role);
        assert_eq!(got, expected, "user {user} doc {document}");
    }

    // Capabilities: viewer/commenter cannot ingest (WriteDenied).
    let op = make_op(901, 1);
    let denied = repo
        .ingest_batch(sync_gateway::db::repo::UserId(viewer), doc, &[op])
        .await;
    assert!(matches!(
        denied,
        Err(sync_gateway::db::repo::RepoError::WriteDenied)
    ));

    // Cleanup.
    let client = db.get().await.expect("pool");
    let docs = vec![doc, org_doc];
    let users = vec![owner, stranger, editor, commenter, viewer, org_member];
    let _ = client
        .execute("DELETE FROM documents WHERE id = ANY($1)", &[&docs])
        .await;
    let _ = client
        .execute("DELETE FROM users WHERE id = ANY($1)", &[&users])
        .await;
    let _ = client
        .execute("DELETE FROM organizations WHERE id = $1", &[&org])
        .await;
}

// ---------------------------------------------------------------------------
// M018/M019 — idempotent ingestion + concurrency race + ACK truth
// ---------------------------------------------------------------------------

#[tokio::test]
async fn duplicate_ingest_never_creates_second_row() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db).await.expect("apply");
    let repo = GatewayRepo::new(db.clone());
    let owner = seed_user(&db, &format!("it-dup-owner-{}", Uuid::new_v4()), None).await;
    let doc = seed_document(&db, owner, None).await;
    let uid = sync_gateway::db::repo::UserId(owner);

    let ops = [make_op(902, 1), make_op(902, 2), make_op(902, 3)];

    // First send: all new.
    let first = repo.ingest_batch(uid, doc, &ops).await.expect("ingest");
    assert_eq!(first.newly_inserted.len(), 3);
    assert!(first.duplicates.is_empty());
    assert!(
        first.durable_cursor > 0,
        "durable cursor exists only after commit"
    );

    // Retry the identical batch (FAILURE_MODEL §2.1): duplicates resolve to
    // existing rows, deterministic ACK-worthy result.
    let second = repo
        .ingest_batch(uid, doc, &ops)
        .await
        .expect("retry ingest");
    assert!(second.newly_inserted.is_empty(), "no second rows");
    assert_eq!(second.duplicates.len(), 3, "all resolve as duplicates");
    assert_eq!(second.all_ids, first.all_ids, "identity-stable");

    // Exactly one durable row per identity.
    let client = db.get().await.expect("pool");
    let count: i64 = client
        .query_one(
            "SELECT COUNT(*) AS n FROM crdt_operations WHERE document_id = $1",
            &[&doc],
        )
        .await
        .expect("count")
        .get("n");
    assert_eq!(count, 3, "one durable row per operation identity");

    cleanup(
        &db,
        &Fixture {
            user: owner,
            document: doc,
        },
    )
    .await;
}

#[tokio::test]
async fn concurrent_duplicate_ingest_is_idempotent() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db).await.expect("apply");
    let repo = GatewayRepo::new(db.clone());
    let owner = seed_user(&db, &format!("it-race-owner-{}", Uuid::new_v4()), None).await;
    let doc = seed_document(&db, owner, None).await;
    let uid = sync_gateway::db::repo::UserId(owner);

    let ops: Vec<OpEnvelope> = (1..=8).map(|c| make_op(903, c)).collect();

    // Two identical batches race (FAILURE_MODEL §2.1 concurrency clause):
    // the unique index must keep exactly one row per identity.
    let repo2 = repo.clone();
    let ops2 = ops.clone();
    let (a, b) = tokio::join!(
        repo.ingest_batch(uid, doc, &ops),
        repo2.ingest_batch(uid, doc, &ops2),
    );
    let _ = a.expect("race A ok");
    let _ = b.expect("race B ok");

    let client = db.get().await.expect("pool");
    let count: i64 = client
        .query_one(
            "SELECT COUNT(*) AS n FROM crdt_operations WHERE document_id = $1",
            &[&doc],
        )
        .await
        .expect("count")
        .get("n");
    assert_eq!(
        count, 8,
        "concurrent identical retries: exactly one row each"
    );

    cleanup(
        &db,
        &Fixture {
            user: owner,
            document: doc,
        },
    )
    .await;
}

#[tokio::test]
async fn independent_gateways_resolve_duplicate_and_conflicting_identity_races() {
    let Some(db_a) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db_a).await.expect("apply");
    let db_b = test_db_at(&test_url()).await.expect("second gateway pool");
    let repo_a = GatewayRepo::new(db_a.clone());
    let repo_b = GatewayRepo::new(db_b);
    let owner = seed_user(
        &db_a,
        &format!("it-independent-owner-{}", Uuid::new_v4()),
        None,
    )
    .await;
    let doc = seed_document(&db_a, owner, None).await;
    let uid = sync_gateway::db::repo::UserId(owner);

    let identical = make_op(9_104, 1);
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
    let (a, b) = tokio::join!(
        async {
            barrier.wait().await;
            repo_a
                .ingest_batch(uid, doc, std::slice::from_ref(&identical))
                .await
        },
        async {
            barrier.wait().await;
            repo_b
                .ingest_batch(uid, doc, std::slice::from_ref(&identical))
                .await
        },
    );
    let a = a.expect("gateway A duplicate race");
    let b = b.expect("gateway B duplicate race");
    assert_eq!(a.newly_inserted.len() + b.newly_inserted.len(), 1);
    assert_eq!(a.duplicates.len() + b.duplicates.len(), 1);
    assert_eq!(
        a.all_ids, b.all_ids,
        "duplicate ACK resolves to the same identity"
    );

    let mut collision_a = make_op(9_105, 1);
    let mut collision_b = make_op(9_105, 1);
    let scalar = collision_a.bytes.len() - 2;
    collision_a.bytes[scalar] = b'b';
    collision_b.bytes[scalar] = b'c';
    assert_eq!(collision_a.identity, collision_b.identity);
    assert_ne!(collision_a.bytes, collision_b.bytes);
    let extra_a = make_op(9_106, 1);
    let extra_b = make_op(9_107, 1);
    let batch_a = [collision_a.clone(), extra_a.clone()];
    let batch_b = [collision_b.clone(), extra_b.clone()];
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
    let (a, b) = tokio::join!(
        async {
            barrier.wait().await;
            repo_a.ingest_batch(uid, doc, &batch_a).await
        },
        async {
            barrier.wait().await;
            repo_b.ingest_batch(uid, doc, &batch_b).await
        },
    );
    let (winning_payload, winning_extra, losing_extra, losing_replica) = match (a, b) {
        (Ok(result), Err(sync_gateway::db::repo::RepoError::IdentityConflict)) => {
            assert_eq!(result.newly_inserted.len(), 2);
            (
                collision_a.bytes,
                extra_a.identity.to_wire(),
                extra_b.identity.to_wire(),
                9_107i64,
            )
        }
        (Err(sync_gateway::db::repo::RepoError::IdentityConflict), Ok(result)) => {
            assert_eq!(result.newly_inserted.len(), 2);
            (
                collision_b.bytes,
                extra_b.identity.to_wire(),
                extra_a.identity.to_wire(),
                9_106i64,
            )
        }
        (a, b) => panic!("expected one commit and one identity conflict, got {a:?} / {b:?}"),
    };

    let client = db_a.get().await.expect("pool");
    let rows = client
        .query(
            "SELECT operation_id, payload FROM crdt_operations WHERE document_id = $1",
            &[&doc],
        )
        .await
        .expect("durable operations");
    assert_eq!(
        rows.len(),
        3,
        "the rejected batch leaves no partial operation"
    );
    let collision_id = collision_a.identity.to_wire();
    let stored_collision = rows
        .iter()
        .find(|row| row.get::<_, String>("operation_id") == collision_id)
        .expect("one committed payload for the colliding identity");
    assert_eq!(
        stored_collision.get::<_, Vec<u8>>("payload"),
        winning_payload
    );
    let stored_ids: Vec<String> = rows.iter().map(|row| row.get("operation_id")).collect();
    assert!(stored_ids.contains(&winning_extra));
    assert!(!stored_ids.contains(&losing_extra));
    let losing_owner_count: i64 = client
        .query_one(
            "SELECT COUNT(*) FROM crdt_replica_owners
             WHERE document_id = $1 AND replica_id = $2",
            &[&doc, &losing_replica],
        )
        .await
        .expect("losing replica owner count")
        .get(0);
    assert_eq!(
        losing_owner_count, 0,
        "the failed batch rolls back its replica claim"
    );

    cleanup(
        &db_a,
        &Fixture {
            user: owner,
            document: doc,
        },
    )
    .await;
}

#[tokio::test]
async fn conflicting_identity_and_cross_user_replica_claims_are_rejected() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db).await.expect("apply");
    let owner = seed_user(&db, &format!("it-collision-owner-{}", Uuid::new_v4()), None).await;
    let editor = seed_user(
        &db,
        &format!("it-collision-editor-{}", Uuid::new_v4()),
        None,
    )
    .await;
    let doc = seed_document(&db, owner, None).await;
    seed_acl(&db, doc, editor, "EDITOR").await;
    let repo = GatewayRepo::new(db.clone());
    let repo2 = GatewayRepo::new(test_db_at(&test_url()).await.expect("second gateway pool"));

    // Server-generated REST/SYSC operations use reserved identities and
    // must not claim a client replica owner row.
    for replica in [0x5245_5354, 0x5359_5343] {
        repo.ingest_batch(
            sync_gateway::db::repo::UserId(owner),
            doc,
            &[make_op(replica, 1)],
        )
        .await
        .expect("server maintenance operation");
    }
    let maintenance_owners: i64 = db
        .get()
        .await
        .expect("pool")
        .query_one(
            "SELECT COUNT(*) FROM crdt_replica_owners
             WHERE document_id = $1 AND replica_id = ANY($2)",
            &[&doc, &vec![0x5245_5354i64, 0x5359_5343i64]],
        )
        .await
        .expect("maintenance owner count")
        .get(0);
    assert_eq!(maintenance_owners, 0);

    let op = make_op(9_101, 1);
    repo.ingest_batch(
        sync_gateway::db::repo::UserId(owner),
        doc,
        std::slice::from_ref(&op),
    )
    .await
    .expect("initial ingest");

    let mut changed = op.clone();
    let scalar = changed.bytes.len() - 2;
    changed.bytes[scalar] = b'b';
    let conflict = repo
        .ingest_batch(sync_gateway::db::repo::UserId(owner), doc, &[changed])
        .await;
    assert!(matches!(
        conflict,
        Err(sync_gateway::db::repo::RepoError::IdentityConflict)
    ));

    let stolen = repo
        .ingest_batch(
            sync_gateway::db::repo::UserId(editor),
            doc,
            &[make_op(9_101, 2)],
        )
        .await;
    assert!(matches!(
        stolen,
        Err(sync_gateway::db::repo::RepoError::ReplicaOwnedByAnotherUser)
    ));

    let first_claim = [make_op(9_102, 1)];
    let second_claim = [make_op(9_102, 2)];
    let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(2));
    let (a, b) = tokio::join!(
        async {
            barrier.wait().await;
            repo.ingest_batch(sync_gateway::db::repo::UserId(owner), doc, &first_claim)
                .await
        },
        async {
            barrier.wait().await;
            repo2
                .ingest_batch(sync_gateway::db::repo::UserId(editor), doc, &second_claim)
                .await
        },
    );
    let a_won = a.is_ok();
    let b_won = b.is_ok();
    assert_eq!(a_won as u8 + b_won as u8, 1, "one gateway owns the replica");
    let loser = if a_won { b } else { a };
    assert!(matches!(
        loser,
        Err(sync_gateway::db::repo::RepoError::ReplicaOwnedByAnotherUser)
    ));
    let claim_owner: Uuid = db
        .get()
        .await
        .expect("pool")
        .query_one(
            "SELECT user_id FROM crdt_replica_owners WHERE document_id = $1 AND replica_id = 9_102",
            &[&doc],
        )
        .await
        .expect("replica owner")
        .get(0);
    assert_eq!(claim_owner, if a_won { owner } else { editor });

    cleanup(
        &db,
        &Fixture {
            user: owner,
            document: doc,
        },
    )
    .await;
    db.get()
        .await
        .expect("pool")
        .execute("DELETE FROM users WHERE id = $1", &[&editor])
        .await
        .expect("cleanup editor");
}

#[tokio::test]
async fn quarantined_legacy_replica_is_readable_but_rejects_new_writes() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db).await.expect("apply");
    let owner = seed_user(&db, &format!("it-legacy-owner-{}", Uuid::new_v4()), None).await;
    let editor = seed_user(&db, &format!("it-legacy-editor-{}", Uuid::new_v4()), None).await;
    let doc = seed_document(&db, owner, None).await;
    seed_acl(&db, doc, editor, "EDITOR").await;

    // Model an operation row without an authenticated author, then apply the
    // v5 quarantine marker as if the row predated that migration.
    let replica = 9_103;
    let legacy = make_op(replica, 1);
    let checksum = format!("{:x}", Sha256::digest(&legacy.bytes));
    db.get()
        .await
        .expect("pool")
        .execute(
            "INSERT INTO crdt_operations
                (document_id, operation_id, replica_id, replica_sequence,
                 payload, payload_version, payload_checksum)
             VALUES ($1, $2, $3, $4, $5, 1, $6)",
            &[
                &doc,
                &legacy.identity.to_wire(),
                &(replica as i64),
                &(legacy.identity.counter as i64),
                &legacy.bytes,
                &checksum,
            ],
        )
        .await
        .expect("seed legacy operation");
    db.get()
        .await
        .expect("pool")
        .execute(
            "INSERT INTO crdt_legacy_replicas (document_id, replica_id)
             VALUES ($1, $2)",
            &[&doc, &(replica as i64)],
        )
        .await
        .expect("mark legacy identity quarantined");

    let repo = GatewayRepo::new(db.clone());
    for actor in [owner, editor] {
        let rejected = repo
            .ingest_batch(
                sync_gateway::db::repo::UserId(actor),
                doc,
                &[make_op(replica, 2)],
            )
            .await;
        assert!(matches!(
            rejected,
            Err(sync_gateway::db::repo::RepoError::LegacyReplicaQuarantined)
        ));
    }
    let page = repo
        .catchup_page(doc, 0, 10)
        .await
        .expect("legacy catch-up");
    assert_eq!(page.ops.len(), 1, "legacy operations remain readable");
    let owner_count: i64 = db
        .get()
        .await
        .expect("pool")
        .query_one(
            "SELECT COUNT(*) FROM crdt_replica_owners
             WHERE document_id = $1 AND replica_id = $2",
            &[&doc, &(replica as i64)],
        )
        .await
        .expect("legacy owner count")
        .get(0);
    assert_eq!(owner_count, 0);

    cleanup(
        &db,
        &Fixture {
            user: owner,
            document: doc,
        },
    )
    .await;
    db.get()
        .await
        .expect("pool")
        .execute("DELETE FROM users WHERE id = $1", &[&editor])
        .await
        .expect("cleanup editor");
}

// ---------------------------------------------------------------------------
// M020 — catch-up pagination
// ---------------------------------------------------------------------------

#[tokio::test]
async fn catchup_pages_are_bounded_and_deterministic() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db).await.expect("apply");
    let repo = GatewayRepo::new(db.clone());
    let owner = seed_user(&db, &format!("it-catchup-owner-{}", Uuid::new_v4()), None).await;
    let doc = seed_document(&db, owner, None).await;
    let uid = sync_gateway::db::repo::UserId(owner);

    // Nontrivial history: 25 ops.
    let ops: Vec<OpEnvelope> = (1..=25).map(|c| make_op(904, c)).collect();
    repo.ingest_batch(uid, doc, &ops).await.expect("ingest");

    // Page through with limit 10: 10 + 10 + 5, no overlap, no gaps.
    let mut cursor: i64 = 0;
    let mut seen: Vec<String> = Vec::new();
    for expected_more in [true, true, false] {
        let page = repo.catchup_page(doc, cursor, 10).await.expect("page");
        assert_eq!(page.has_more, expected_more);
        assert!(page.ops.len() <= 10, "bounded page");
        assert!(!page.ops.is_empty(), "no premature end");
        for (op_id, _seq, payload) in &page.ops {
            seen.push(op_id.clone());
            assert!(!payload.is_empty());
        }
        cursor = page.next_cursor;
    }
    assert_eq!(seen.len(), 25, "all ops delivered exactly once");
    let unique: std::collections::HashSet<_> = seen.iter().cloned().collect();
    assert_eq!(unique.len(), 25, "no duplicates across pages");

    // Fresh full-history read for a new client (cursor 0 → 25 ops).
    let full = repo.catchup_page(doc, 0, 100).await.expect("full");
    assert_eq!(full.ops.len(), 25);

    cleanup(
        &db,
        &Fixture {
            user: owner,
            document: doc,
        },
    )
    .await;
}

// ---------------------------------------------------------------------------
// users resolution (M013→M015 wiring)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn resolve_user_maps_clerk_sub_to_uuid() {
    let Some(db) = test_db().await else {
        eprintln!("SKIP: concord_test DB unreachable");
        return;
    };
    run_migrations(&db).await.expect("apply");
    let repo = GatewayRepo::new(db.clone());
    let clerk_id = format!("user_it_{}", Uuid::new_v4().simple());
    let user = seed_user(&db, &clerk_id, None).await;
    let resolved = repo.resolve_user(&clerk_id).await.expect("resolve");
    assert_eq!(resolved.0, user);
    let missing = repo.resolve_user("user_never_provisioned_xyz").await;
    assert!(matches!(
        missing,
        Err(sync_gateway::db::repo::RepoError::UserNotProvisioned)
    ));
    let client = db.get().await.expect("pool");
    let _ = client
        .execute("DELETE FROM users WHERE id = $1", &[&user])
        .await;
}

// Silence unused import when tests skip on missing DB.
#[allow(dead_code)]
fn _uuid_from_str(s: &str) -> Uuid {
    Uuid::from_str(s).unwrap()
}
