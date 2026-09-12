//! Phase 5 snapshot-repository tests (P5-M012/M013).
//!
//! Runs against the isolated `concord_test` database (same conventions as
//! phase5_migrations.rs / db_integration.rs); skipped when the DB is
//! unreachable. Run with `--test-threads=1` (tests share one database).
//!
//! Verifies:
//! - lifecycle happy path building → verifying → finalized, and the reads
//!   recovery uses (`latest_finalized`, `get_by_snapshot_id`);
//! - every ILLEGAL state transition is refused by the SQL guard (returns
//!   false, row unchanged);
//! - FINALIZED immutability: payload bytes never change, and re-finalizing
//!   is impossible;
//! - the M013 integrity matrix (fail-closed, one corruption ⇒ one error
//!   variant);
//! - `latest_finalized_before` inclusive boundary semantics;
//! - the (document, coverage_seq, attempt) uniqueness constraint;
//! - the DEC-035 wrapper round-trip.

use uuid::Uuid;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::snapshots::{
    status, validate_integrity, wrapper, SnapshotIntegrityError, SnapshotRepo, SnapshotRow,
    STATE_DIGEST_PREFIX, SUPPORTED_FORMAT_VERSION,
};

const TEST_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";

async fn test_db() -> Option<Db> {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_URL.into(),
        clerk_issuer: "https://fun-blowfish-5798.clerk.accounts.dev".into(),
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
    match Db::connect(&config).await {
        Ok(db) => Some(db),
        Err(_) => {
            eprintln!("SKIP: concord_test DB unreachable");
            None
        }
    }
}

/// Per-test fixture: one organization/user/document (FK target) plus one
/// pending maintenance job, cleaned up at test end. Unique per test run —
/// no shared mutable state (op-log style convention).
struct Fixture {
    org: Uuid,
    user: Uuid,
    document: Uuid,
    job: Uuid,
}

async fn seed_fixture(db: &Db, name: &str) -> Fixture {
    let mut client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let user = Uuid::new_v4();
    let document = Uuid::new_v4();
    let job = Uuid::new_v4();
    // FIXED fixture SQL — format! over locally generated uuids only,
    // never over untrusted input (same convention as phase5_migrations.rs).
    let sql = format!(
        "INSERT INTO organizations (id, clerk_organization_id, name)
           VALUES ('{org}', 'org_{org}', '{name}');
         INSERT INTO users (id, clerk_user_id)
           VALUES ('{user}', '{name}_user_{user}');
         INSERT INTO documents (id, owner_user_id, title)
           VALUES ('{document}', '{user}', '{name}');
         INSERT INTO maintenance_jobs (job_id, kind, document_id, state)
           VALUES ('{job}', 'snapshot_build', '{document}', 'pending');"
    );
    let tx = client.transaction().await.expect("tx");
    tx.batch_execute(&sql).await.expect("seed fixture");
    tx.commit().await.expect("commit fixture");
    Fixture {
        org,
        user,
        document,
        job,
    }
}

async fn cleanup_fixture(db: &Db, f: &Fixture) {
    // crdt_snapshots/maintenance_jobs cascade on document; users/orgs are
    // removed explicitly. Fixture ids are unique, so cleanup is surgical.
    let client = db.get().await.expect("pool");
    for sql in [
        format!("DELETE FROM documents WHERE id = '{}'", f.document),
        format!("DELETE FROM users WHERE id = '{}'", f.user),
        format!("DELETE FROM organizations WHERE id = '{}'", f.org),
    ] {
        let _ = client.execute(&sql, &[]).await;
    }
}

/// Deterministic wrapper payload via the repo's own wrapper encoder.
fn wrapper_payload(document: Uuid, coverage_seq: u64, op_count: u64, inner: &[u8]) -> Vec<u8> {
    wrapper::encode_wrapper(document, coverage_seq, op_count, inner)
}

fn digest_for(inner: &[u8]) -> String {
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest;
    hasher.update(inner);
    format!("{STATE_DIGEST_PREFIX}{}", hex::encode(hasher.finalize()))
}

/// A plain BUILDING row created through the repo API.
async fn make_building(
    repo: &SnapshotRepo,
    f: &Fixture,
    coverage_seq: i64,
    attempt: i32,
) -> sync_gateway::db::snapshots::SnapshotAttempt {
    let inner = format!("snap-at-{coverage_seq}").into_bytes();
    let payload = wrapper_payload(f.document, coverage_seq as u64, 42, &inner);
    repo.create_attempt(
        f.document,
        coverage_seq,
        42,
        f.job,
        attempt,
        &digest_for(&inner),
        r#"{"items":0}"#,
        &payload,
    )
    .await
    .expect("create attempt")
}

// ---------------------------------------------------------------------------
// 1. Lifecycle happy path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn lifecycle_building_to_finalized_happy_path() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("apply");
    let f = seed_fixture(&db, "happy").await;
    let repo = SnapshotRepo::new(db.clone());

    let attempt = make_building(&repo, &f, 100, 1).await;
    assert_eq!(attempt.attempt, 1);

    let row = repo
        .get_by_snapshot_id(attempt.snapshot_id)
        .await
        .expect("fetch building")
        .expect("row present");
    assert_eq!(row.status, status::BUILDING);
    assert_eq!(row.coverage_seq, 100);
    assert_eq!(row.covered_op_count, 42);
    assert_eq!(row.format_version, SUPPORTED_FORMAT_VERSION);
    assert_eq!(row.payload_size, row.payload.len() as i64);
    assert_eq!(row.finalized_at, None);
    // Not finalized yet: latest_finalized must NOT see it (recovery reads
    // FINALIZED only).
    assert!(repo.latest_finalized(f.document).await.unwrap().is_none());

    assert!(repo
        .transition_building_to_verifying(attempt.snapshot_id)
        .await
        .expect("transition"));
    let row = repo
        .get_by_snapshot_id(attempt.snapshot_id)
        .await
        .unwrap()
        .expect("row");
    assert_eq!(row.status, status::VERIFYING);
    assert!(repo.latest_finalized(f.document).await.unwrap().is_none());

    assert!(repo
        .finalize(attempt.snapshot_id, None)
        .await
        .expect("finalize"));
    let row = repo
        .get_by_snapshot_id(attempt.snapshot_id)
        .await
        .unwrap()
        .expect("row");
    assert_eq!(row.status, status::FINALIZED);
    assert!(row.finalized_at.is_some(), "finalized_at must be stamped");

    // latest_finalized returns it and get_by_snapshot_id matches exactly.
    let latest = repo
        .latest_finalized(f.document)
        .await
        .expect("latest")
        .expect("finalized row");
    assert_eq!(latest.snapshot_id, attempt.snapshot_id);
    assert_eq!(latest, row);

    // The row must pass the full M013 gate.
    let validated = validate_integrity(&latest, f.document).expect("valid row");
    assert_eq!(validated.coverage_seq, 100);
    assert_eq!(validated.covered_op_count, 42);
    assert_eq!(
        validated.inner,
        "snap-at-100".to_string().into_bytes(),
        "inner payload must be the untouched C++ snapshot bytes"
    );

    cleanup_fixture(&db, &f).await;
}

// ---------------------------------------------------------------------------
// 2. Guard matrix: illegal transitions return false, row unchanged
// ---------------------------------------------------------------------------

#[tokio::test]
async fn guards_reject_illegal_transitions() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("apply");
    let f = seed_fixture(&db, "guards").await;
    let repo = SnapshotRepo::new(db.clone());

    // finalize from 'building' (skipping verifying) must fail.
    let a = make_building(&repo, &f, 10, 1).await;
    assert!(
        !repo.finalize(a.snapshot_id, None).await.unwrap(),
        "finalize from building must be refused"
    );
    assert_eq!(
        repo.get_by_snapshot_id(a.snapshot_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        status::BUILDING,
        "row must be untouched"
    );

    // building → verifying twice: second is refused.
    assert!(repo
        .transition_building_to_verifying(a.snapshot_id)
        .await
        .unwrap());
    assert!(
        !repo
            .transition_building_to_verifying(a.snapshot_id)
            .await
            .unwrap(),
        "second building→verifying must be refused"
    );
    assert_eq!(
        repo.get_by_snapshot_id(a.snapshot_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        status::VERIFYING
    );

    // mark_superseded on a non-finalized row must fail.
    assert!(
        !repo.mark_superseded(a.snapshot_id).await.unwrap(),
        "supersede from verifying must be refused"
    );
    assert_eq!(
        repo.get_by_snapshot_id(a.snapshot_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        status::VERIFYING
    );

    // fail() from verifying succeeds...
    assert!(repo
        .fail(a.snapshot_id, "guard-matrix: verifying→failed")
        .await
        .unwrap());
    assert_eq!(
        repo.get_by_snapshot_id(a.snapshot_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        status::FAILED
    );
    // ...and is terminal: fail() again (from failed) is refused.
    assert!(
        !repo.fail(a.snapshot_id, "second fail").await.unwrap(),
        "fail from failed must be refused"
    );
    // finalize from failed is refused (FAILED is terminal for the attempt).
    assert!(!repo.finalize(a.snapshot_id, None).await.unwrap());
    // supersede from failed is refused too.
    assert!(!repo.mark_superseded(a.snapshot_id).await.unwrap());

    // fail() from building succeeds (build-time failures are expected).
    let b = make_building(&repo, &f, 20, 1).await;
    assert!(repo
        .fail(b.snapshot_id, "guard-matrix: building→failed")
        .await
        .unwrap());
    assert_eq!(
        repo.get_by_snapshot_id(b.snapshot_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        status::FAILED
    );

    // fail() from finalized is refused (FINALIZED never leaves the
    // finalized/supersede path).
    let c = make_building(&repo, &f, 30, 1).await;
    repo.transition_building_to_verifying(c.snapshot_id)
        .await
        .unwrap();
    assert!(repo.finalize(c.snapshot_id, None).await.unwrap());
    assert!(
        !repo.fail(c.snapshot_id, "must refuse").await.unwrap(),
        "fail from finalized must be refused"
    );
    assert_eq!(
        repo.get_by_snapshot_id(c.snapshot_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        status::FINALIZED
    );

    // Unknown snapshot id: every guard returns false (no row matched).
    let ghost = Uuid::new_v4();
    assert!(!repo.transition_building_to_verifying(ghost).await.unwrap());
    assert!(!repo.finalize(ghost, None).await.unwrap());
    assert!(!repo.fail(ghost, "ghost").await.unwrap());
    assert!(!repo.mark_superseded(ghost).await.unwrap());

    cleanup_fixture(&db, &f).await;
}

// ---------------------------------------------------------------------------
// 3. FINALIZED immutability
// ---------------------------------------------------------------------------

#[tokio::test]
async fn finalized_rows_are_immutable() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("apply");
    let f = seed_fixture(&db, "immutable").await;
    let repo = SnapshotRepo::new(db.clone());

    let a = make_building(&repo, &f, 50, 1).await;
    repo.transition_building_to_verifying(a.snapshot_id)
        .await
        .unwrap();
    assert!(repo.finalize(a.snapshot_id, None).await.unwrap());
    let before = repo
        .get_by_snapshot_id(a.snapshot_id)
        .await
        .unwrap()
        .expect("row");

    // No lifecycle API mutates a finalized row: every non-supersede
    // transition refuses.
    assert!(!repo
        .transition_building_to_verifying(a.snapshot_id)
        .await
        .unwrap());
    assert!(!repo.finalize(a.snapshot_id, None).await.unwrap());
    assert!(!repo.fail(a.snapshot_id, "no").await.unwrap());

    // Re-fetch: payload bytes (and all metadata) are identical.
    let after = repo
        .get_by_snapshot_id(a.snapshot_id)
        .await
        .unwrap()
        .expect("row");
    assert_eq!(
        before.payload, after.payload,
        "payload must be bit-identical"
    );
    assert_eq!(before, after, "the whole row must be unchanged");

    // Defense in depth: a raw guarded UPDATE re-running the finalize
    // statement affects zero rows — the status guard itself prevents
    // re-finalize, independent of this API surface.
    let client = db.get().await.expect("pool");
    let rows = client
        .execute(
            "UPDATE crdt_snapshots
                SET status = 'finalized', finalized_at = now()
             WHERE snapshot_id = $1 AND status = 'verifying'",
            &[&a.snapshot_id],
        )
        .await
        .expect("raw guarded update runs");
    assert_eq!(rows, 0, "re-finalize must match zero rows");

    // payload mutation attempt is additionally blocked by the v2 CHECK
    // (payload_size = OCTET_LENGTH(payload)) — demonstrated by refusing at
    // the type level here: there is no API path to even express it.
    let still = repo.latest_finalized(f.document).await.unwrap().unwrap();
    assert_eq!(still.payload, before.payload);
    assert_eq!(still.payload_size, before.payload_size);
    assert_eq!(still.payload_checksum, before.payload_checksum);

    // supersede (retention-only) is the ONE allowed marking; payload and
    // checksum still unchanged afterwards.
    assert!(repo.mark_superseded(a.snapshot_id).await.unwrap());
    let superseded = repo
        .get_by_snapshot_id(a.snapshot_id)
        .await
        .unwrap()
        .expect("row");
    assert_eq!(superseded.status, status::SUPERSEDED);
    assert_eq!(
        superseded.payload, before.payload,
        "supersede is marking-only"
    );
    assert_eq!(superseded.payload_checksum, before.payload_checksum);
    // After supersede, latest_finalized no longer returns it (recovery
    // reads FINALIZED only).
    assert!(repo.latest_finalized(f.document).await.unwrap().is_none());

    cleanup_fixture(&db, &f).await;
}

// ---------------------------------------------------------------------------
// 4. M013 integrity matrix (pure in-memory rows — no DB needed)
// ---------------------------------------------------------------------------

fn pristine_row(document: Uuid) -> SnapshotRow {
    let inner = b"cpp-v1-snapshot-bytes-string".to_vec();
    let payload = wrapper::encode_wrapper(document, 77, 9, &inner);
    let checksum = {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(&payload);
        hex::encode(h.finalize())
    };
    SnapshotRow {
        snapshot_id: Uuid::new_v4(),
        document_id: document,
        format_version: SUPPORTED_FORMAT_VERSION,
        coverage_seq: 77,
        covered_op_count: 9,
        state_digest: digest_for(&inner),
        state_summary: r#"{"items":3}"#.into(),
        payload: payload.clone(),
        payload_size: payload.len() as i64,
        payload_checksum: checksum,
        status: status::FINALIZED.into(),
        job_id: Some(Uuid::new_v4()),
        attempt: 1,
        created_at: std::time::SystemTime::now(),
        finalized_at: Some(std::time::SystemTime::now()),
    }
}

#[test]
fn integrity_matrix_valid_row_passes() {
    let document = Uuid::new_v4();
    let row = pristine_row(document);
    let v = validate_integrity(&row, document).expect("pristine row validates");
    assert_eq!(v.document_id, document);
    assert_eq!(v.coverage_seq, 77);
    assert_eq!(v.covered_op_count, 9);
    assert_eq!(v.inner, b"cpp-v1-snapshot-bytes-string".to_vec());
}

#[test]
fn integrity_matrix_one_bit_flip_is_checksum_mismatch() {
    let document = Uuid::new_v4();
    let mut row = pristine_row(document);
    // Flip ONE bit in the middle of the inner payload region.
    let mid = row.payload.len() - 3;
    row.payload[mid] ^= 0x01;
    // (payload_size stays consistent — the corruption must be caught by
    // the CHECKSUM, proving S4: one-bit flip ⇒ reject.)
    match validate_integrity(&row, document) {
        Err(SnapshotIntegrityError::ChecksumMismatch { .. }) => {}
        other => panic!("expected ChecksumMismatch, got {other:?}"),
    }
}

#[test]
fn integrity_matrix_truncated_payload_is_size_mismatch() {
    let document = Uuid::new_v4();
    let mut row = pristine_row(document);
    // Truncate the stored payload but keep the (now-wrong) declared size —
    // the declared-size check fires first.
    row.payload.truncate(row.payload.len() - 2);
    match validate_integrity(&row, document) {
        Err(SnapshotIntegrityError::SizeMismatch { .. }) => {}
        other => panic!("expected SizeMismatch, got {other:?}"),
    }
}

#[test]
fn integrity_matrix_wrong_document_is_document_mismatch() {
    let document = Uuid::new_v4();
    let row = pristine_row(document);
    match validate_integrity(&row, Uuid::new_v4()) {
        Err(SnapshotIntegrityError::DocumentMismatch { .. }) => {}
        other => panic!("expected DocumentMismatch, got {other:?}"),
    }
}

#[test]
fn integrity_matrix_unsupported_row_format_is_rejected() {
    let document = Uuid::new_v4();
    let mut row = pristine_row(document);
    row.format_version = SUPPORTED_FORMAT_VERSION + 1;
    match validate_integrity(&row, document) {
        Err(SnapshotIntegrityError::UnsupportedFormat { .. }) => {}
        other => panic!("expected UnsupportedFormat, got {other:?}"),
    }
}

#[test]
fn integrity_matrix_wrapper_row_metadata_mismatch_is_rejected() {
    let document = Uuid::new_v4();
    // Corrupt the ROW's coverage_seq (payload still self-consistent) —
    // the wrapper/row agreement check must fire (row/payload swap defense).
    let mut row = pristine_row(document);
    row.coverage_seq = 78;
    match validate_integrity(&row, document) {
        Err(SnapshotIntegrityError::MetadataMismatch { field, .. }) => {
            assert_eq!(field, "coverage_seq");
        }
        other => panic!("expected MetadataMismatch, got {other:?}"),
    }
    // Same for covered_op_count.
    let mut row = pristine_row(document);
    row.covered_op_count = 10;
    match validate_integrity(&row, document) {
        Err(SnapshotIntegrityError::MetadataMismatch { field, .. }) => {
            assert_eq!(field, "covered_op_count");
        }
        other => panic!("expected MetadataMismatch, got {other:?}"),
    }
}

#[test]
fn integrity_matrix_trailing_wrapper_bytes_are_rejected() {
    let document = Uuid::new_v4();
    let mut row = pristine_row(document);
    // Append trailing bytes; declared size and checksum are recomputed to
    // stay internally consistent, so ONLY the wrapper structure check can
    // catch this (inner_len must equal remaining bytes exactly).
    row.payload.push(0xFF);
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(&row.payload);
    row.payload_checksum = hex::encode(h.finalize());
    row.payload_size = row.payload.len() as i64;
    match validate_integrity(&row, document) {
        Err(SnapshotIntegrityError::MalformedWrapper { .. }) => {}
        other => panic!("expected MalformedWrapper, got {other:?}"),
    }
}

#[test]
fn integrity_matrix_wrong_digest_prefix_is_rejected() {
    let document = Uuid::new_v4();
    let mut row = pristine_row(document);
    row.state_digest = "blake3:deadbeef".into();
    match validate_integrity(&row, document) {
        Err(SnapshotIntegrityError::InvalidDigestMetadata { .. }) => {}
        other => panic!("expected InvalidDigestMetadata, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// 5. latest_finalized_before boundary semantics (inclusive <=)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn latest_finalized_before_boundaries() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("apply");
    let f = seed_fixture(&db, "boundaries").await;
    let repo = SnapshotRepo::new(db.clone());

    for seq in [10, 20, 30] {
        let a = make_building(&repo, &f, seq, 1).await;
        repo.transition_building_to_verifying(a.snapshot_id)
            .await
            .unwrap();
        assert!(repo.finalize(a.snapshot_id, None).await.unwrap());
    }

    async fn at(repo: &SnapshotRepo, document: Uuid, seq: i64) -> i64 {
        repo.latest_finalized_before(document, seq)
            .await
            .unwrap()
            .map(|r| r.coverage_seq)
            .unwrap_or(-1)
    }
    assert_eq!(
        at(&repo, f.document, 25).await,
        20,
        "boundary 25 must pick seq 20"
    );
    assert_eq!(
        at(&repo, f.document, 10).await,
        10,
        "inclusive boundary: seq 10 covers exactly 10"
    );
    assert!(
        repo.latest_finalized_before(f.document, 5)
            .await
            .unwrap()
            .is_none(),
        "no finalized snapshot covers boundary 5"
    );
    assert_eq!(
        at(&repo, f.document, 100).await,
        30,
        "high boundary picks the newest"
    );

    // list_historical returns all three, newest coverage first.
    let listed = repo.list_historical(f.document, 10).await.unwrap();
    assert_eq!(
        listed.iter().map(|r| r.coverage_seq).collect::<Vec<_>>(),
        vec![30, 20, 10]
    );
    assert!(listed.iter().all(|r| r.status == status::FINALIZED));

    cleanup_fixture(&db, &f).await;
}

// ---------------------------------------------------------------------------
// 6. Attempt uniqueness (schema constraint via the repo API)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn duplicate_document_boundary_attempt_is_rejected() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("apply");
    let f = seed_fixture(&db, "attempts").await;
    let repo = SnapshotRepo::new(db.clone());

    let first = make_building(&repo, &f, 42, 3).await;
    assert_eq!(first.attempt, 3);

    // Same (document, coverage_seq, attempt) ⇒ unique violation (23505).
    let inner = b"second-try".to_vec();
    let payload = wrapper_payload(f.document, 42, 8, &inner);
    let err = repo
        .create_attempt(
            f.document,
            42,
            8,
            f.job,
            3,
            &digest_for(&inner),
            r#"{"items":0}"#,
            &payload,
        )
        .await
        .expect_err("duplicate attempt must be rejected by the schema");
    match err {
        sync_gateway::db::snapshots::SnapshotRepoError::Pg(ref e)
            if e.code() == Some(&tokio_postgres::error::SqlState::UNIQUE_VIOLATION) => {}
        other => panic!("expected unique-violation Pg error, got {other:?}"),
    }

    // A DIFFERENT attempt number for the same boundary is fine (retry path).
    let retry = make_building(&repo, &f, 42, 4).await;
    assert_eq!(retry.attempt, 4);
    // And a different boundary reuses attempt 1 freely.
    let _ = make_building(&repo, &f, 43, 1).await;

    cleanup_fixture(&db, &f).await;
}

// ---------------------------------------------------------------------------
// 7. create_attempt refuses self-inconsistent input (fail-closed writes)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_attempt_rejects_metadata_mismatch_before_insert() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("apply");
    let f = seed_fixture(&db, "create-guard").await;
    let repo = SnapshotRepo::new(db.clone());

    // Wrapper for a DIFFERENT document must not be insertable under f.document.
    let inner = b"x".to_vec();
    let payload = wrapper_payload(Uuid::new_v4(), 10, 1, &inner);
    let err = repo
        .create_attempt(
            f.document,
            10,
            1,
            f.job,
            1,
            &digest_for(&inner),
            r#"{}"#,
            &payload,
        )
        .await
        .expect_err("wrapper/args document mismatch must be refused");
    assert!(matches!(
        err,
        sync_gateway::db::snapshots::SnapshotRepoError::Integrity(
            SnapshotIntegrityError::MetadataMismatch {
                field: "document_id"
            }
        )
    ));

    // Bad digest prefix is refused too.
    let payload = wrapper_payload(f.document, 10, 1, &inner);
    let err = repo
        .create_attempt(
            f.document,
            10,
            1,
            f.job,
            1,
            "not-a-digest",
            r#"{}"#,
            &payload,
        )
        .await
        .expect_err("invalid digest prefix must be refused");
    assert!(matches!(
        err,
        sync_gateway::db::snapshots::SnapshotRepoError::Integrity(
            SnapshotIntegrityError::InvalidDigestMetadata { .. }
        )
    ));

    // Nothing was persisted by the refused calls.
    assert!(
        repo.list_historical(f.document, 100)
            .await
            .unwrap()
            .is_empty(),
        "refused creates must leave zero rows"
    );

    cleanup_fixture(&db, &f).await;
}

// ---------------------------------------------------------------------------
// 8. DEC-035 wrapper round-trip
// ---------------------------------------------------------------------------

#[test]
fn wrapper_round_trip_is_exact() {
    let document = Uuid::new_v4();
    let inner: Vec<u8> = (0u8..=255).cycle().take(1000).collect();
    let payload = wrapper::encode_wrapper(document, 12_345, 6_789, &inner);
    let parts = wrapper::decode_wrapper(&payload).expect("round-trip decode");
    assert_eq!(parts.format_version, wrapper::WRAPPER_FORMAT_VERSION);
    assert_eq!(parts.document_id, document);
    assert_eq!(parts.coverage_seq, 12_345);
    assert_eq!(parts.covered_op_count, 6_789);
    assert_eq!(parts.inner, inner);
    // Empty inner is legal (a boundary-0 snapshot has nothing to carry).
    let empty = wrapper::encode_wrapper(document, 0, 0, b"");
    let parts = wrapper::decode_wrapper(&empty).expect("empty inner decodes");
    assert_eq!(parts.inner, Vec::<u8>::new());
}

#[test]
fn wrapper_rejects_structural_corruption() {
    let document = Uuid::new_v4();
    let payload = wrapper::encode_wrapper(document, 5, 2, b"inner");

    // Header truncation.
    let err = wrapper::decode_wrapper(&payload[..10]).unwrap_err();
    assert!(matches!(
        err,
        SnapshotIntegrityError::MalformedWrapper { .. }
    ));

    // Inner truncation.
    let err = wrapper::decode_wrapper(&payload[..payload.len() - 1]).unwrap_err();
    assert!(matches!(
        err,
        SnapshotIntegrityError::MalformedWrapper { .. }
    ));

    // Trailing bytes.
    let mut trailing = payload.clone();
    trailing.push(0x00);
    let err = wrapper::decode_wrapper(&trailing).unwrap_err();
    assert!(matches!(
        err,
        SnapshotIntegrityError::MalformedWrapper { .. }
    ));

    // Wrong wrapper version.
    let mut wrong_version = payload.clone();
    wrong_version[0] = wrapper::WRAPPER_FORMAT_VERSION + 1;
    let err = wrapper::decode_wrapper(&wrong_version).unwrap_err();
    assert!(matches!(
        err,
        SnapshotIntegrityError::UnsupportedFormat { .. }
    ));

    // Hostile inner_len (u64::MAX) must fail closed via overflow check,
    // never slice-panic.
    let mut hostile = payload[..41].to_vec();
    hostile[33..41].copy_from_slice(&u64::MAX.to_le_bytes());
    let err = wrapper::decode_wrapper(&hostile).unwrap_err();
    assert!(matches!(
        err,
        SnapshotIntegrityError::MalformedWrapper { .. }
    ));
}

// ---------------------------------------------------------------------------
// 9. End-to-end: DB row round-trips through validate_integrity
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stored_row_validates_end_to_end() {
    let Some(db) = test_db().await else { return };
    run_migrations(&db).await.expect("apply");
    let f = seed_fixture(&db, "e2e").await;
    let repo = SnapshotRepo::new(db.clone());

    let inner = b"the-cpp-snapshot".to_vec();
    let payload = wrapper_payload(f.document, 64, 7, &inner);
    let a = repo
        .create_attempt(
            f.document,
            64,
            7,
            f.job,
            1,
            &digest_for(&inner),
            r#"{"kind":"auto_checkpoint"}"#,
            &payload,
        )
        .await
        .unwrap();
    repo.transition_building_to_verifying(a.snapshot_id)
        .await
        .unwrap();
    assert!(repo.finalize(a.snapshot_id, None).await.unwrap());

    let row = repo.latest_finalized(f.document).await.unwrap().unwrap();
    // state_summary round-trips through the jsonb column. Postgres renders
    // jsonb canonically (key order + spacing), so compare SEMANTICALLY:
    // parse both sides rather than string-compare.
    let summary: serde_json::Value = serde_json::from_str(&row.state_summary).unwrap();
    assert_eq!(
        summary,
        serde_json::json!({"kind": "auto_checkpoint"}),
        "state_summary must survive the jsonb round-trip"
    );
    // The stored payload is bit-identical to what was encoded.
    assert_eq!(row.payload, payload);
    // And the full gate passes on the DB-fetched row.
    let validated = validate_integrity(&row, f.document).expect("stored row validates");
    assert_eq!(validated.inner, inner);

    cleanup_fixture(&db, &f).await;
}
