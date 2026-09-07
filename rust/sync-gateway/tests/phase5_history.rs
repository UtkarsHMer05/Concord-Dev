//! Version history + restore tests (P5-M034..M036). Live DB + real
//! worker; skipped when either is unavailable (same conventions as
//! phase5_recovery.rs).
//!
//! Proves: the revision lifecycle + ACL matrix (H3/H4), reconstruction
//! determinism vs an independent worker-fold oracle (H2), empty-start
//! and snapshot-covered boundaries, history safety across pruning
//! (H2/H6 spirit), snapshot-anchored restore semantics (H5) including
//! anchor reuse and pruned-target refusal, and that restore
//! bookkeeping never blocks the op log (R7/H6 spirit).

use std::time::Duration;

use sync_gateway::config::Config;
use sync_gateway::db::migrations::run_migrations;
use sync_gateway::db::pool::Db;
use sync_gateway::db::repo::{GatewayRepo, UserId};
use sync_gateway::db::snapshots::SnapshotRepo;
use sync_gateway::maintenance::history::{revision_kind, RevisionService};
use sync_gateway::maintenance::{prune_to_boundary, HistoryError, JobRepo, SnapshotPipeline};
use sync_gateway::protocol::envelope::validate_op;
use sync_gateway::protocol::golden;
use sync_gateway::worker::WorkerPool;
use uuid::Uuid;

const TEST_URL: &str = "postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test";

async fn test_db() -> Option<Db> {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: TEST_URL.into(),
        clerk_issuer: "https://fun-blowfish-5798.clerk.accounts.dev".into(),
        allowed_origins: vec![],
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
    };
    match Db::connect(&config).await {
        Ok(db) => {
            run_migrations(&db).await.expect("migrations");
            Some(db)
        }
        Err(_) => {
            eprintln!("SKIP: concord_test DB unreachable");
            None
        }
    }
}

fn live_worker_pool() -> Option<WorkerPool> {
    let mut root = std::env::current_dir().expect("cwd");
    for _ in 0..3 {
        for rel in [
            "build/native/concord-worker",
            "build/native/worker/concord-worker",
        ] {
            let mut path = root.clone();
            path.push(rel);
            if path.is_file() {
                return Some(WorkerPool::new(path, Duration::from_secs(120)));
            }
        }
        if !root.pop() {
            break;
        }
    }
    eprintln!("SKIP: concord-worker binary not built");
    None
}

fn ops_at(count: usize, counter_base: u64, replica: u64) -> Vec<Vec<u8>> {
    let builders = [
        golden::golden_insert_op,
        golden::golden_delimiter_op,
        golden::golden_delete_op,
    ];
    (0..count)
        .map(|i| {
            let mut base = builders[i % builders.len()]();
            base[2..10].copy_from_slice(&replica.to_le_bytes());
            base[10..18].copy_from_slice(&(counter_base + i as u64).to_le_bytes());
            validate_op(&base).expect("valid");
            base
        })
        .collect()
}

async fn ingest(repo: &GatewayRepo, user: UserId, doc: Uuid, payloads: &[Vec<u8>]) -> i64 {
    let envelopes = payloads
        .iter()
        .map(|p| validate_op(p).expect("valid op"))
        .collect::<Vec<_>>();
    repo.ingest_batch(user, doc, &envelopes)
        .await
        .expect("ingest")
        .durable_cursor
}

/// Fixture with an org, an OWNER, an EDITOR, a VIEWER, and a stranger
/// (no relationship), plus one document owned by the owner. Returns
/// every identity so the ACL matrix tests can use them directly.
struct Fixture {
    owner: UserId,
    editor: UserId,
    viewer: UserId,
    stranger: UserId,
    doc: Uuid,
}

async fn fixture(db: &Db) -> Fixture {
    let client = db.get().await.expect("pool");
    let org = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let editor = Uuid::new_v4();
    let viewer = Uuid::new_v4();
    let stranger = Uuid::new_v4();
    let doc = Uuid::new_v4();
    client
        .batch_execute(&format!(
            "INSERT INTO organizations (id, clerk_organization_id, name)
               VALUES ('{org}', 'org_{org}', 'p5-hist-test');
             INSERT INTO users (id, clerk_user_id)
               VALUES ('{owner}', 'p5h_own_{owner}'),
                      ('{editor}', 'p5h_edt_{editor}'),
                      ('{viewer}', 'p5h_vew_{viewer}'),
                      ('{stranger}', 'p5h_str_{stranger}');
             INSERT INTO documents (id, owner_user_id, title)
               VALUES ('{doc}', '{owner}', 'p5-history');
             INSERT INTO document_user_permissions (document_id, user_id, role)
               VALUES ('{doc}', '{editor}', 'EDITOR'),
                      ('{doc}', '{viewer}', 'VIEWER');"
        ))
        .await
        .expect("fixture");
    Fixture {
        owner: UserId(owner),
        editor: UserId(editor),
        viewer: UserId(viewer),
        stranger: UserId(stranger),
        doc,
    }
}

async fn cleanup(db: &Db, f: &Fixture) {
    let client = db.get().await.expect("pool");
    let _ = client
        .batch_execute(&format!(
            "DELETE FROM crdt_revisions WHERE document_id = '{}';
             DELETE FROM crdt_snapshots WHERE document_id = '{}';
             DELETE FROM maintenance_jobs WHERE document_id = '{}';
             DELETE FROM crdt_operations WHERE document_id = '{}';
             UPDATE documents SET compaction_floor_seq = NULL,
                 compaction_floor_snapshot_id = NULL WHERE id = '{}';
             DELETE FROM documents WHERE id = '{}';
             DELETE FROM users WHERE id IN ('{}', '{}', '{}', '{}');",
            f.doc,
            f.doc,
            f.doc,
            f.doc,
            f.doc,
            f.doc,
            f.owner.0,
            f.editor.0,
            f.viewer.0,
            f.stranger.0
        ))
        .await;
}

async fn purge_jobs(db: &Db) {
    // This suite enqueues snapshot hints; jobs claimed by an earlier
    // suite run would be re-executed by the scheduler elsewhere. The
    // suite runs serialized against the shared test DB (the harness's
    // --test-threads=1 + fileParallelism policy).
    let client = db.get().await.expect("pool");
    let _ = client.execute("DELETE FROM maintenance_jobs", &[]).await;
}

fn service(db: &Db, workers: &WorkerPool) -> RevisionService {
    RevisionService::new(
        GatewayRepo::new(db.clone()),
        SnapshotRepo::new(db.clone()),
        workers.clone(),
        JobRepo::new(db.clone()),
    )
}

/// =========================================================================
/// 1. Revision lifecycle + ACL matrix (M034; H3/H4)
/// =========================================================================
#[tokio::test]
async fn revision_lifecycle_and_acl_matrix() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let f = fixture(&db).await;
    purge_jobs(&db).await;
    let svc = service(&db, &workers);

    // Ingest ops so boundaries are real.
    let b1 = ingest(&svc.repo, f.owner, f.doc, &ops_at(4, 100, 0xEE01)).await;
    assert!(b1 > 0);

    // --- named: EDITOR ok (H4), records the actor + boundary.
    let named_by_editor = svc
        .create_revision(
            f.doc,
            f.editor,
            revision_kind::NAMED,
            Some("Before refactor"),
            None,
        )
        .await
        .expect("EDITOR may create a named revision");
    assert_eq!(named_by_editor.kind, "named");
    assert_eq!(named_by_editor.label.as_deref(), Some("Before refactor"));
    assert_eq!(
        named_by_editor.target_seq, b1,
        "None boundary = durable high-water"
    );
    assert_eq!(named_by_editor.created_by, Some(f.editor.0));

    // --- named: VIEWER denied; no-access stranger denied; uniformly
    //     Forbidden (indistinguishable-not-found convention).
    for actor in [f.viewer, f.stranger] {
        let err = svc
            .create_revision(f.doc, actor, revision_kind::NAMED, Some("no"), None)
            .await
            .expect_err("VIEWER/stranger must be denied");
        assert!(matches!(err, HistoryError::Forbidden), "got {err:?}");
    }

    // --- named requires a label: typed error up front AND the DB
    //     CHECK is the final authority (verified via the raw insert).
    let err = svc
        .create_revision(f.doc, f.owner, revision_kind::NAMED, None, None)
        .await
        .expect_err("label required");
    assert!(matches!(err, HistoryError::LabelRequired), "got {err:?}");
    {
        let client = db.get().await.expect("pool");
        let result = client
            .execute(
                "INSERT INTO crdt_revisions (revision_id, document_id, target_seq, kind)
                 VALUES ($1, $2, $3, 'named')",
                &[&Uuid::new_v4(), &f.doc, &b1],
            )
            .await;
        assert!(
            result.is_err(),
            "DB CHECK crdt_revisions_named_label_present must reject a label-less named row"
        );
    }

    // --- auto_checkpoint: internal entry point works, actor-facing
    //     create_revision refuses the internal kinds.
    let auto = svc
        .create_auto_checkpoint(f.doc, Some(b1), Some("auto @ t0"), Some(f.owner))
        .await
        .expect("internal auto checkpoint");
    assert_eq!(auto.kind, "auto_checkpoint");
    assert_eq!(auto.target_seq, b1);
    let err = svc
        .create_revision(
            f.doc,
            f.owner,
            revision_kind::AUTO_CHECKPOINT,
            Some("x"),
            Some(b1),
        )
        .await
        .expect_err("internal kinds must not flow through the actor API");
    assert!(matches!(err, HistoryError::Forbidden), "got {err:?}");
    let err = svc
        .create_revision(f.doc, f.owner, revision_kind::RESTORE_EVENT, None, Some(b1))
        .await
        .expect_err("restore_event is internal-only");
    assert!(matches!(err, HistoryError::Forbidden), "got {err:?}");

    // --- named revision enqueued a snapshot_build HINT at the boundary.
    {
        let client = db.get().await.expect("pool");
        let row = client
            .query_one(
                "SELECT COUNT(*) AS n FROM maintenance_jobs
                 WHERE document_id = $1 AND kind = 'snapshot_build'
                   AND target_seq = $2 AND state = 'pending'",
                &[&f.doc, &b1],
            )
            .await
            .expect("job count");
        let n: i64 = row.get("n");
        assert_eq!(n, 1, "one coalesced snapshot hint for the boundary");
    }

    // --- listing: newest first, all kinds visible.
    let b2 = ingest(&svc.repo, f.owner, f.doc, &ops_at(4, 200, 0xEE02)).await;
    let _ = svc
        .create_revision(
            f.doc,
            f.owner,
            revision_kind::NAMED,
            Some("Second"),
            Some(b2),
        )
        .await
        .expect("owner names a revision at an explicit boundary");

    // VIEWER may list (H3: any read role).
    let listed = svc
        .list_revisions(f.doc, f.viewer, 50)
        .await
        .expect("VIEWER may list revisions");
    assert_eq!(listed.len(), 3, "two named + one auto_checkpoint");
    // Newest first: created_at DESC (with id DESC tiebreak — the two
    // same-boundary rows can share a timestamp).
    assert!(
        listed[0].created_at >= listed[1].created_at
            && listed[1].created_at >= listed[2].created_at,
        "list must be ordered newest first"
    );
    assert_eq!(listed[0].label.as_deref(), Some("Second"));
    // Every listed row references a boundary, never a payload column
    // (H1: summaries carry kind/label/target only).
    assert!(listed.iter().all(|r| r.target_seq > 0));

    // Stranger denied (uniform Forbidden).
    let err = svc
        .list_revisions(f.doc, f.stranger, 50)
        .await
        .expect_err("no access must deny listing");
    assert!(matches!(err, HistoryError::Forbidden), "got {err:?}");

    // --- revision_content ACL: VIEWER ok, stranger denied.
    let content = svc
        .revision_content(f.doc, f.viewer, named_by_editor.revision_id)
        .await
        .expect("VIEWER may view a historical reconstruction");
    assert!(content.state_digest.starts_with("sha256:"));
    let err = svc
        .revision_content(f.doc, f.stranger, named_by_editor.revision_id)
        .await
        .expect_err("stranger denied content");
    assert!(matches!(err, HistoryError::Forbidden), "got {err:?}");

    // Unknown revision id: typed not-found (no existence leak — the
    // error is the same for a wrong-document revision).
    let err = svc
        .revision_content(f.doc, f.owner, Uuid::new_v4())
        .await
        .expect_err("unknown revision");
    assert!(matches!(err, HistoryError::RevisionNotFound), "got {err:?}");

    cleanup(&db, &f).await;
}

/// =========================================================================
/// 2. Reconstruction determinism (M035; H2/R8)
/// =========================================================================
#[tokio::test]
async fn reconstruction_is_deterministic_against_independent_oracle() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let f = fixture(&db).await;
    purge_jobs(&db).await;
    let svc = service(&db, &workers);

    // Ops in two waves so the mid boundary is a real mid-log point.
    let wave1 = ops_at(6, 300, 0xEE11);
    let b_mid = ingest(&svc.repo, f.owner, f.doc, &wave1).await;
    let wave2 = ops_at(6, 400, 0xEE12);
    let b_head = ingest(&svc.repo, f.owner, f.doc, &wave2).await;
    assert!(b_mid < b_head);

    // A named revision at the MID boundary (ingest happened first).
    let rev = svc
        .create_revision(
            f.doc,
            f.owner,
            revision_kind::NAMED,
            Some("mid"),
            Some(b_mid),
        )
        .await
        .expect("named at mid boundary");

    // BEFORE any snapshot: empty-start reconstruction. Calling twice
    // must yield the IDENTICAL digest (H2).
    let first = svc
        .revision_content(f.doc, f.owner, rev.revision_id)
        .await
        .expect("first reconstruction");
    let second = svc
        .revision_content(f.doc, f.owner, rev.revision_id)
        .await
        .expect("second reconstruction");
    assert_eq!(
        first.state_digest, second.state_digest,
        "same revision => same digest, ALWAYS (H2)"
    );
    assert_eq!(first.covered_by_snapshot, None, "no snapshot exists yet");
    assert_eq!(first.boundary, b_mid);

    // Independent oracle: a manual worker fold of ALL ops <= target,
    // collected straight from catchup pages (not ops_between).
    let mut oracle_ops = Vec::new();
    let mut cursor = 0i64;
    loop {
        let page = svc
            .repo
            .catchup_page(f.doc, cursor, 100)
            .await
            .expect("page");
        if page.ops.is_empty() {
            break;
        }
        for (_, seq, payload) in page.ops {
            if seq <= b_mid {
                oracle_ops.push(payload);
            }
        }
        cursor = page.next_cursor;
        if !page.has_more {
            break;
        }
    }
    let oracle = workers.reconstruct(&oracle_ops).await.expect("oracle fold");
    assert_eq!(
        first.state_digest, oracle.digest,
        "service reconstruction must equal the independent worker fold"
    );

    // Target EXACTLY at a snapshot boundary: build + finalize a
    // snapshot at b_mid, reconstruct again — the snapshot must be
    // used (covered_by_snapshot = Some) and the digest unchanged.
    let pipeline =
        SnapshotPipeline::new(svc.repo.clone(), svc.snapshots.clone(), svc.workers.clone());
    let job = Uuid::new_v4();
    let (snap_id, _d, _v) = pipeline
        .build_at_boundary(f.doc, b_mid, job, 1)
        .await
        .expect("build");
    assert!(svc
        .snapshots
        .transition_building_to_verifying(snap_id)
        .await
        .expect("transition"));
    let _ = pipeline.verify(f.doc, snap_id).await.expect("verify");
    assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));

    let with_snapshot = svc
        .revision_content(f.doc, f.owner, rev.revision_id)
        .await
        .expect("reconstruction over a covering snapshot");
    assert_eq!(
        with_snapshot.covered_by_snapshot,
        Some(snap_id),
        "a snapshot taken exactly at the boundary covers it (INCLUSIVE)"
    );
    assert_eq!(
        with_snapshot.state_digest, first.state_digest,
        "snapshot-anchored and empty-start reconstruction agree (H2)"
    );

    // A target BEFORE the first op (boundary 0, the empty document) is
    // a valid reconstruction point.
    let empty = svc
        .create_auto_checkpoint(f.doc, Some(0), None, None)
        .await
        .expect("checkpoint at boundary 0");
    let empty_state = svc
        .revision_content(f.doc, f.owner, empty.revision_id)
        .await
        .expect("empty-boundary reconstruction");
    let empty_oracle = workers.reconstruct(&[]).await.expect("empty fold");
    assert_eq!(empty_state.state_digest, empty_oracle.digest);

    cleanup(&db, &f).await;
}

/// =========================================================================
/// 3. History safety across pruning (M035 vs M030; H2/H6)
/// =========================================================================
#[tokio::test]
async fn reconstruction_survives_pruning_when_covered() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let f = fixture(&db).await;
    purge_jobs(&db).await;
    let svc = service(&db, &workers);

    // Wave 1 at the revision boundary; wave 2 above it.
    let wave1 = ops_at(6, 500, 0xEE21);
    let b_rev = ingest(&svc.repo, f.owner, f.doc, &wave1).await;
    let rev = svc
        .create_revision(
            f.doc,
            f.owner,
            revision_kind::NAMED,
            Some("pre-prune"),
            Some(b_rev),
        )
        .await
        .expect("named revision");

    let wave2 = ops_at(4, 600, 0xEE22);
    let b_head = ingest(&svc.repo, f.owner, f.doc, &wave2).await;

    // Snapshot at the REVISION boundary, then prune BELOW the head but
    // ABOVE the revision boundary — wait: pruning to b_head deletes
    // everything <= b_head INCLUDING the revision's ops. The revision
    // stays reconstructable because its covering snapshot remains.
    let pipeline =
        SnapshotPipeline::new(svc.repo.clone(), svc.snapshots.clone(), svc.workers.clone());
    let job = Uuid::new_v4();
    let (snap_id, _d, _v) = pipeline
        .build_at_boundary(f.doc, b_head, job, 1)
        .await
        .expect("build at head");
    assert!(svc
        .snapshots
        .transition_building_to_verifying(snap_id)
        .await
        .expect("transition"));
    let _ = pipeline.verify(f.doc, snap_id).await.expect("verify");
    assert!(pipeline.finalize(snap_id, None).await.expect("finalize"));

    // Pre-prune digest (ops still present).
    let pre = svc
        .revision_content(f.doc, f.owner, rev.revision_id)
        .await
        .expect("pre-prune reconstruction");
    assert!(pre.state_digest.starts_with("sha256:"));

    // Prune to the head: the revision's own ops are deleted; the
    // covering snapshot at the head includes them implicitly. The
    // revision boundary is BELOW the floor — reconstruction must still
    // work: latest_finalized_before(b_rev) finds the head snapshot?
    // NO: coverage_seq (b_head) > b_rev, so it cannot anchor it. The
    // honest pruned-target semantics are exercised in the restore
    // tests; HERE we prune only BELOW the revision boundary instead:
    // the covering snapshot must be AT/BELOW the boundary. Rebuild the
    // scenario with a snapshot at the REVISION boundary.
    let _ = (b_head, snap_id);
    let job2 = Uuid::new_v4();
    let (snap_rev, _d2, _v2) = pipeline
        .build_at_boundary(f.doc, b_rev, job2, 1)
        .await
        .expect("build at revision boundary");
    assert!(svc
        .snapshots
        .transition_building_to_verifying(snap_rev)
        .await
        .expect("transition"));
    let _ = pipeline.verify(f.doc, snap_rev).await.expect("verify");
    assert!(pipeline.finalize(snap_rev, None).await.expect("finalize"));

    // Prune to the revision boundary: ops <= b_rev are deleted, the
    // snapshot at b_rev covers the revision state exactly.
    let deleted = prune_to_boundary(&db, &svc.snapshots, f.doc, b_rev, 4)
        .await
        .expect("prune below the revision boundary");
    assert_eq!(deleted, wave1.len() as i64, "revision ops pruned");
    let post = svc
        .revision_content(f.doc, f.owner, rev.revision_id)
        .await
        .expect("post-prune reconstruction must work (history safety)");
    assert_eq!(
        pre.state_digest, post.state_digest,
        "digest before and after pruning must be IDENTICAL (H2/H6)"
    );
    assert_eq!(post.covered_by_snapshot, Some(snap_rev));

    // The pruned ops are truly gone from the log (proves the snapshot
    // really carried the reconstruction, not the log).
    let remaining = svc.repo.catchup_page(f.doc, 0, 100).await.expect("page");
    assert_eq!(remaining.ops.len(), wave2.len());

    cleanup(&db, &f).await;
}

/// =========================================================================
/// 4. Restore (M036; H5) — OWNER only, anchor + audit, pruned refusal
/// =========================================================================
#[tokio::test]
async fn restore_requires_owner_and_anchors_the_target() {
    let Some(db) = test_db().await else { return };
    let Some(workers) = live_worker_pool() else {
        return;
    };
    let f = fixture(&db).await;
    purge_jobs(&db).await;
    let svc = service(&db, &workers);

    let wave1 = ops_at(6, 700, 0xEE31);
    let b_t = ingest(&svc.repo, f.owner, f.doc, &wave1).await;
    let source = svc
        .create_revision(
            f.doc,
            f.owner,
            revision_kind::NAMED,
            Some("restore point"),
            Some(b_t),
        )
        .await
        .expect("source revision");
    let wave2 = ops_at(4, 800, 0xEE32);
    let _b_now = ingest(&svc.repo, f.owner, f.doc, &wave2).await;

    // EDITOR denied restore (H5).
    let err = svc
        .restore_revision(f.doc, f.editor, source.revision_id)
        .await
        .expect_err("EDITOR must not restore");
    assert!(matches!(err, HistoryError::Forbidden), "got {err:?}");
    // Strangers too (deny-by-default).
    let err = svc
        .restore_revision(f.doc, f.stranger, source.revision_id)
        .await
        .expect_err("stranger must not restore");
    assert!(matches!(err, HistoryError::Forbidden), "got {err:?}");

    // OWNER restores the unpruned target.
    let outcome = svc
        .restore_revision(f.doc, f.owner, source.revision_id)
        .await
        .expect("OWNER restores");
    assert_eq!(outcome.boundary, b_t);
    assert!(outcome.target_state_digest.starts_with("sha256:"));
    assert!(outcome.current_state_digest.starts_with("sha256:"));
    assert!(
        !outcome.reused_existing_snapshot,
        "first restore builds the anchor"
    );

    // The anchor is a FINALIZED snapshot at exactly the boundary.
    let anchor = svc
        .snapshots
        .get_by_snapshot_id(outcome.anchor_snapshot_id)
        .await
        .expect("anchor row")
        .expect("anchor exists");
    assert_eq!(anchor.status, "finalized");
    assert_eq!(anchor.coverage_seq, b_t);

    // The restore_event row records actor + source + snapshot.
    let ev = &outcome.restore_event;
    assert_eq!(ev.kind, "restore_event");
    assert_eq!(ev.restore_source_revision, Some(source.revision_id));
    assert_eq!(ev.target_seq, b_t);
    assert_eq!(ev.snapshot_id, Some(outcome.anchor_snapshot_id));
    assert_eq!(ev.created_by, Some(f.owner.0), "restore records the actor");

    // Restore twice at the same boundary: the existing finalized
    // snapshot at the exact boundary is REUSED (same snapshot_id, no
    // duplicate attempt rows at attempt=1).
    let before: i64 = {
        let client = db.get().await.expect("pool");
        client
            .query_one(
                "SELECT COUNT(*) AS n FROM crdt_snapshots
                 WHERE document_id = $1 AND coverage_seq = $2 AND attempt = 1",
                &[&f.doc, &b_t],
            )
            .await
            .expect("attempt count")
            .get("n")
    };
    let second = svc
        .restore_revision(f.doc, f.owner, source.revision_id)
        .await
        .expect("second restore (idempotent anchor reuse)");
    assert!(second.reused_existing_snapshot);
    assert_eq!(
        second.anchor_snapshot_id, outcome.anchor_snapshot_id,
        "second restore reuses the same finalized anchor"
    );
    assert_eq!(second.target_state_digest, outcome.target_state_digest);
    let after: i64 = {
        let client = db.get().await.expect("pool");
        client
            .query_one(
                "SELECT COUNT(*) AS n FROM crdt_snapshots
                 WHERE document_id = $1 AND coverage_seq = $2 AND attempt = 1",
                &[&f.doc, &b_t],
            )
            .await
            .expect("attempt count")
            .get("n")
    };
    assert_eq!(before, after, "no duplicate attempt rows at the boundary");

    // Restore-of-a-restore (H8 spirit): the restore_event itself can be
    // a restore source — it is just another boundary-referencing row.
    let third = svc
        .restore_revision(f.doc, f.owner, ev.revision_id)
        .await
        .expect("restore of a restore_event");
    assert_eq!(third.boundary, b_t);
    assert_eq!(
        third.restore_event.restore_source_revision,
        Some(ev.revision_id)
    );

    // Restore of a PRUNED target errors RestoreTargetPruned.
    let pruned_boundary = b_t;
    let deleted = prune_to_boundary(&db, &svc.snapshots, f.doc, pruned_boundary, 4)
        .await
        .expect("prune to the restore boundary (covered by the anchor)");
    assert!(deleted >= 1, "covered rows pruned");
    let err = svc
        .restore_revision(f.doc, f.owner, source.revision_id)
        .await
        .expect_err("pruned target must refuse");
    assert!(
        matches!(err, HistoryError::RestoreTargetPruned { boundary, floor }
            if boundary == b_t && floor == b_t),
        "got {err:?}"
    );

    // H5 negative IDOR: a revision id from ANOTHER document is not
    // found (never leaks cross-document state).
    let err = svc
        .restore_revision(f.doc, f.owner, Uuid::new_v4())
        .await
        .expect_err("unknown source");
    assert!(matches!(err, HistoryError::RevisionNotFound), "got {err:?}");

    // =================================================================
    // 5. No-acknowledged-edit-loss (R7/H6 spirit): after restore
    //    bookkeeping, a NEW op ingests fine and is queryable.
    // =================================================================
    let tail = ops_at(2, 900, 0xEE33);
    let after_restore = ingest(&svc.repo, f.owner, f.doc, &tail).await;
    let page = svc.repo.catchup_page(f.doc, 0, 100).await.expect("page");
    assert!(
        page.ops.iter().any(|(id, _, _)| id == "56763:901")
            || page
                .ops
                .iter()
                .any(|(id, _, _)| id.starts_with(&format!("{}", 0xEE33))),
        "the new op is queryable after restore (replica {:#x})",
        0xEE33
    );
    assert!(after_restore > 0);
    let listed = svc
        .list_revisions(f.doc, f.owner, 50)
        .await
        .expect("listing still works after restore + new ops");
    // Audit trail: 1 named source + 3 restore_events (initial, second,
    // restore-of-restore) = 4 rows, all retained (H6: restore never
    // touches history).
    assert_eq!(listed.len(), 4, "audit trail fully retained");

    cleanup(&db, &f).await;
}
