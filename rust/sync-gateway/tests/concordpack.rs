//! One real PostgreSQL/native-worker check for signed-history portability,
//! offline trust, atomic retries, pruning, replica quarantine and provenance.
use serde_json::{json, Value};
use std::time::Duration;
use sync_gateway::config::Config;
use sync_gateway::db::repo::UserId;
use sync_gateway::db::{run_migrations, Db, GatewayRepo, SnapshotRepo};
use sync_gateway::maintenance::concordpack::{
    decode, encode, verify, PackError, PackService, TrustRecord,
};
use sync_gateway::maintenance::proofs::ProofSigner;
use sync_gateway::maintenance::{HistoryError, JobRepo, RevisionService, SnapshotPipeline};
use sync_gateway::protocol::{envelope::validate_op, golden};
use sync_gateway::worker::WorkerPool;
use uuid::Uuid;

#[tokio::test]
async fn signed_history_roundtrip_and_rejections() {
    let (db, worker) = test_dependencies().await;
    let repo = GatewayRepo::new(db.clone());
    let snapshots = SnapshotRepo::new(db.clone());
    let history = RevisionService::new(
        repo.clone(),
        snapshots.clone(),
        worker.clone(),
        JobRepo::new(db.clone()),
    );
    let packs = PackService {
        repo: repo.clone(),
        worker: worker.clone(),
    };
    let client = db.get().await.unwrap();
    let source = Uuid::new_v4();
    let owner = UserId(Uuid::new_v4());
    let destination_owner = UserId(Uuid::new_v4());
    for user in [owner, destination_owner] {
        client
            .execute(
                "INSERT INTO users(id,clerk_user_id) VALUES($1,$2)",
                &[&user.0, &format!("pack_{user:?}")],
            )
            .await
            .unwrap();
    }
    client
        .execute(
            "INSERT INTO documents(id,owner_user_id,title) VALUES($1,$2,'Portable RFC')",
            &[&source, &owner.0],
        )
        .await
        .unwrap();
    let ops: Vec<_> = (1u64..=6)
        .map(|counter| {
            let mut op = golden::golden_insert_op();
            op[2..10].copy_from_slice(&71u64.to_le_bytes());
            op[10..18].copy_from_slice(&counter.to_le_bytes());
            validate_op(&op).unwrap()
        })
        .collect();
    let first = repo
        .ingest_batch(owner, source, &ops[..3])
        .await
        .unwrap()
        .durable_cursor;
    let old = history
        .create_revision(source, owner, "named", Some("RFC baseline"), Some(first))
        .await
        .unwrap();
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), worker.clone());
    let (snapshot, _, _) = pipeline
        .build_at_boundary(source, first, Uuid::new_v4(), 1)
        .await
        .unwrap();
    assert!(snapshots
        .transition_building_to_verifying(snapshot)
        .await
        .unwrap());
    pipeline.verify(source, snapshot).await.unwrap();
    assert!(pipeline.finalize(snapshot, None).await.unwrap());
    let head = repo
        .ingest_batch(owner, source, &ops[3..])
        .await
        .unwrap()
        .durable_cursor;
    let current = history
        .create_revision(source, owner, "named", Some("RFC final"), Some(head))
        .await
        .unwrap();
    let signer = ProofSigner::from_seed([41; 32]);
    let allowed = vec![hex::encode(signer.public_key_bytes())];
    assert!(matches!(
        packs.export(source, owner, &ProofSigner::generate()).await,
        Err(PackError::Invalid("stable_signing_key_required"))
    ));
    assert!(matches!(
        packs.export(source, destination_owner, &signer).await,
        Err(PackError::Invalid("not_found"))
    ));
    let bytes = packs.export(source, owner, &signer).await.unwrap();
    let trust = TrustRecord {
        public_key: allowed[0].clone(),
        document_id: source,
        seq: head.to_string(),
        base_snapshot_seq: "0".into(),
        revision_id: Some(current.revision_id),
    };
    let checked = verify(&bytes, &trust, &worker).await.unwrap();
    assert_eq!(checked.archive.manifest.content.revisions.len(), 2);
    assert!(checked.historical_replicas.contains(&71));
    assert_eq!(
        checked
            .archive
            .manifest
            .content
            .provenance
            .as_ref()
            .unwrap()["replicaOrigins"][0]["actorId"],
        json!(owner.0)
    );
    for bad in [
        TrustRecord {
            public_key: hex::encode(ProofSigner::from_seed([42; 32]).public_key_bytes()),
            ..trust.clone()
        },
        TrustRecord {
            document_id: Uuid::new_v4(),
            ..trust.clone()
        },
        TrustRecord {
            seq: (head + 1).to_string(),
            ..trust.clone()
        },
        TrustRecord {
            base_snapshot_seq: first.to_string(),
            ..trust.clone()
        },
        TrustRecord {
            revision_id: Some(Uuid::new_v4()),
            ..trust.clone()
        },
    ] {
        assert!(verify(&bytes, &bad, &worker).await.is_err());
    }
    let mut corrupt = bytes.clone();
    *corrupt.last_mut().unwrap() ^= 1;
    assert!(verify(&corrupt, &trust, &worker).await.is_err());
    assert!(verify(&bytes[..bytes.len() - 1], &trust, &worker)
        .await
        .is_err());
    let mut bad = decode(&bytes, &trust).unwrap();
    bad.manifest.content.state_digest = format!("sha256:{}", "0".repeat(64));
    let forged = encode(bad.manifest.content, bad.snapshots, bad.operations, &signer).unwrap();
    assert!(matches!(
        verify(&forged, &trust, &worker).await,
        Err(PackError::Invalid("state_digest_mismatch"))
    ));
    assert!(matches!(
        packs
            .import(
                destination_owner,
                Uuid::new_v4(),
                "Restored RFC",
                &bytes,
                &trust,
                &[]
            )
            .await,
        Err(PackError::Invalid("untrusted_import_key"))
    ));
    let request = Uuid::new_v4();
    let result = packs
        .import(
            destination_owner,
            request,
            "Restored RFC",
            &bytes,
            &trust,
            &allowed,
        )
        .await
        .unwrap();
    let restored: Uuid = result["documentId"].as_str().unwrap().parse().unwrap();
    assert_ne!(restored, source);
    assert_eq!(result["workspace"], "personal");
    assert_eq!(
        packs
            .import(
                destination_owner,
                request,
                "Restored RFC",
                &bytes,
                &trust,
                &allowed
            )
            .await
            .unwrap(),
        result
    );
    assert!(matches!(
        packs
            .import(
                destination_owner,
                request,
                "Changed title",
                &bytes,
                &trust,
                &allowed
            )
            .await,
        Err(PackError::Invalid("request_id_conflicts"))
    ));
    assert!(matches!(
        packs
            .import(owner, request, "Restored RFC", &bytes, &trust, &allowed)
            .await,
        Err(PackError::Invalid("not_found"))
    ));
    assert!(repo
        .document_access(owner, restored)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        client
            .query_one(
                "SELECT count(*) AS n FROM document_user_permissions WHERE document_id=$1",
                &[&restored]
            )
            .await
            .unwrap()
            .get::<_, i64>("n"),
        0
    );
    let actual = repo
        .ops_between(restored, 0, i64::MAX, 100)
        .await
        .unwrap()
        .ops;
    for (row, original) in actual.iter().zip(&ops) {
        assert_eq!(row.0, original.identity.to_wire());
        assert_eq!(row.2, original.bytes);
    }
    assert!(actual[0].1 > head, "fresh database sequences");
    let provenance = packs.provenance(restored, destination_owner).await.unwrap();
    for revision in [&old, &current] {
        let mapped: Uuid = provenance["revisionMap"][revision.revision_id.to_string()]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let before = history
            .revision_content(source, owner, revision.revision_id)
            .await
            .unwrap();
        let after = history
            .revision_content(restored, destination_owner, mapped)
            .await
            .unwrap();
        assert_eq!(before.state_digest, after.state_digest);
        assert_eq!(before.visible_content, after.visible_content);
    }
    assert_eq!(client.query_one("SELECT count(*) AS n FROM crdt_revisions WHERE document_id=$1 AND created_by IS NOT NULL",&[&restored]).await.unwrap().get::<_,i64>("n"),0);
    // All restored historical identities are quarantined, including identities
    // present only in a snapshot after the durable prefix has been pruned.
    assert!(repo
        .ingest_batch(destination_owner, restored, &ops[..1])
        .await
        .is_err());

    // A transaction failure after all content inserts must leave no document,
    // operations, revisions, provenance, or audit row behind. Scope the trigger
    // to this test's UUID so other tests/data are unaffected.
    let failed_request = Uuid::new_v4();
    let trigger = format!("pack_fail_{}", failed_request.simple());
    client.batch_execute(&format!("CREATE FUNCTION {trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='{failed_request}'::uuid THEN RAISE EXCEPTION 'injected import failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER {trigger} BEFORE INSERT ON concordpack_imports FOR EACH ROW EXECUTE FUNCTION {trigger}();")).await.unwrap();
    assert!(packs
        .import(
            destination_owner,
            failed_request,
            "Must roll back",
            &bytes,
            &trust,
            &allowed
        )
        .await
        .is_err());
    client
        .batch_execute(&format!(
            "DROP TRIGGER {trigger} ON concordpack_imports; DROP FUNCTION {trigger}();"
        ))
        .await
        .unwrap();
    assert_eq!(client.query_one("SELECT count(*) AS n FROM documents WHERE owner_user_id=$1 AND title='Must roll back'",&[&destination_owner.0]).await.unwrap().get::<_,i64>("n"),0);
    let retried = packs
        .import(
            destination_owner,
            failed_request,
            "Must roll back",
            &bytes,
            &trust,
            &allowed,
        )
        .await
        .unwrap();
    assert!(retried["documentId"].is_string());

    // Fully compacted source: only a head snapshot remains. The head is still
    // durable; old unprotected revision metadata remains explicitly pruned.
    let (head_snapshot, _, _) = pipeline
        .build_at_boundary(source, head, Uuid::new_v4(), 1)
        .await
        .unwrap();
    assert!(snapshots
        .transition_building_to_verifying(head_snapshot)
        .await
        .unwrap());
    pipeline.verify(source, head_snapshot).await.unwrap();
    assert!(pipeline.finalize(head_snapshot, None).await.unwrap());
    client.execute("UPDATE documents SET compaction_floor_seq=$2,compaction_floor_snapshot_id=$3 WHERE id=$1",&[&source,&head,&head_snapshot]).await.unwrap();
    client
        .execute(
            "DELETE FROM crdt_operations WHERE document_id=$1",
            &[&source],
        )
        .await
        .unwrap();
    assert_eq!(repo.durable_cursor(source).await.unwrap(), head);
    let compacted = packs.export(source, owner, &signer).await.unwrap();
    let compact_trust = TrustRecord {
        base_snapshot_seq: head.to_string(),
        ..trust.clone()
    };
    let imported = packs
        .import(
            destination_owner,
            Uuid::new_v4(),
            "Compacted RFC",
            &compacted,
            &compact_trust,
            &allowed,
        )
        .await
        .unwrap();
    assert_eq!(imported["operationCount"], 0);
    let compact_doc = imported["documentId"].as_str().unwrap().parse().unwrap();
    let compact_cursor = repo.durable_cursor(compact_doc).await.unwrap();
    assert!(compact_cursor > 0);
    assert_eq!(
        history
            .reconstruct_at_boundary(compact_doc, compact_cursor)
            .await
            .unwrap()
            .0,
        checked.archive.manifest.content.state_digest
    );
    assert!(repo
        .ingest_batch(destination_owner, compact_doc, &ops[..1])
        .await
        .is_err());
    let checkpoint = history
        .create_revision(
            compact_doc,
            destination_owner,
            "named",
            Some("Imported head"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(checkpoint.target_seq, compact_cursor);
    let compact_provenance = packs
        .provenance(compact_doc, destination_owner)
        .await
        .unwrap();
    let retained_old: Uuid = compact_provenance["revisionMap"][old.revision_id.to_string()]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let restored_old = history
        .restore_revision(compact_doc, destination_owner, retained_old)
        .await
        .unwrap();
    assert!(restored_old.reused_existing_snapshot);
    let restored_checkpoint = history
        .create_revision(
            compact_doc,
            destination_owner,
            "named",
            Some("Restored checkpoint"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        history
            .revision_content(
                compact_doc,
                destination_owner,
                restored_checkpoint.revision_id
            )
            .await
            .unwrap()
            .visible_content,
        history
            .revision_content(compact_doc, destination_owner, retained_old)
            .await
            .unwrap()
            .visible_content
    );
    // Public historical previews still match the original signed checkpoint.
    assert_eq!(
        history
            .revision_content(compact_doc, destination_owner, retained_old)
            .await
            .unwrap()
            .state_digest,
        checked
            .archive
            .manifest
            .content
            .revisions
            .iter()
            .find(|r| r.revision_id == old.revision_id)
            .unwrap()
            .state_digest
            .as_deref()
            .unwrap()
    );
    // Remove the old protected snapshot; its revision is now unavailable,
    // never reconstructed by applying a missing prefix to an empty replica.
    client
        .execute(
            "DELETE FROM crdt_snapshots WHERE snapshot_id=$1",
            &[&snapshot],
        )
        .await
        .unwrap();
    assert!(matches!(
        history
            .revision_content(source, owner, old.revision_id)
            .await,
        Err(HistoryError::RestoreTargetPruned { .. })
    ));
    let pruned = packs.export(source, owner, &signer).await.unwrap();
    let inspected = verify(&pruned, &compact_trust, &worker).await.unwrap();
    assert!(inspected
        .archive
        .manifest
        .content
        .revisions
        .iter()
        .find(|r| r.revision_id == old.revision_id)
        .unwrap()
        .state_digest
        .is_none());

    // Executable + worker + two input files suffice with all service env
    // removed; no DB/Clerk/gateway configuration is read by the offline CLI.
    let temp = std::env::temp_dir().join(format!("concordpack-{}", Uuid::new_v4()));
    std::fs::create_dir(&temp).unwrap();
    std::fs::write(temp.join("archive.concordpack"), &bytes).unwrap();
    std::fs::write(temp.join("trust.json"), serde_json::to_vec(&trust).unwrap()).unwrap();
    let run = std::process::Command::new(env!("CARGO_BIN_EXE_concordpack-verify"))
        .env_clear()
        .args([
            "--bundle",
            "archive.concordpack",
            "--trust",
            "trust.json",
            "--worker",
        ])
        .arg(worker.binary_path().canonicalize().unwrap())
        .current_dir(&temp)
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let report: Value = serde_json::from_slice(&run.stdout).unwrap();
    assert_eq!(report["result"], "verified");
    std::fs::remove_dir_all(temp).unwrap();
    // Re-export includes the earlier trusted signed manifest and mappings.
    let exported = packs
        .export(restored, destination_owner, &signer)
        .await
        .unwrap();
    let restored_trust = TrustRecord {
        document_id: restored,
        seq: repo.durable_cursor(restored).await.unwrap().to_string(),
        revision_id: None,
        base_snapshot_seq: "0".into(),
        public_key: trust.public_key,
    };
    assert_eq!(
        verify(&exported, &restored_trust, &worker)
            .await
            .unwrap()
            .archive
            .manifest
            .content
            .provenance
            .unwrap()["sourceManifest"]["content"]["documentId"],
        json!(source)
    );
    for user in [owner, destination_owner] {
        client
            .execute("DELETE FROM documents WHERE owner_user_id=$1", &[&user.0])
            .await
            .unwrap();
        client
            .execute("DELETE FROM users WHERE id=$1", &[&user.0])
            .await
            .unwrap();
    }
}

async fn pending_snapshot_identity_check(
    packs: &PackService,
    owner: UserId,
    destination_owner: UserId,
    signer: &ProofSigner,
    allowed: &[String],
) {
    let repo = &packs.repo;
    let snapshots = SnapshotRepo::new(repo.db.clone());
    let pipeline = SnapshotPipeline::new(repo.clone(), snapshots.clone(), packs.worker.clone());
    let client = repo.db.get().await.unwrap();
    // A snapshot can retain causally early operations without advertising
    // their writer in its contiguous summary. Quarantine those identities and
    // their missing references too, even after all raw rows have been pruned.
    let pending_doc = Uuid::new_v4();
    client
        .execute(
            "INSERT INTO documents(id,owner_user_id,title) VALUES($1,$2,'Pending snapshot')",
            &[&pending_doc, &owner.0],
        )
        .await
        .unwrap();
    let mut pending = golden::golden_delete_op();
    pending[2..10].copy_from_slice(&93u64.to_le_bytes());
    pending[10..18].copy_from_slice(&1u64.to_le_bytes());
    pending[26..34].copy_from_slice(&94u64.to_le_bytes());
    pending[34..42].copy_from_slice(&1u64.to_le_bytes());
    let pending_head = repo
        .ingest_batch(owner, pending_doc, &[validate_op(&pending).unwrap()])
        .await
        .unwrap()
        .durable_cursor;
    let raw_archive = packs.export(pending_doc, owner, signer).await.unwrap();
    let raw_trust = TrustRecord {
        document_id: pending_doc,
        seq: pending_head.to_string(),
        base_snapshot_seq: "0".into(),
        revision_id: None,
        public_key: allowed[0].clone(),
    };
    let raw_checked = verify(&raw_archive, &raw_trust, &packs.worker)
        .await
        .unwrap();
    assert!(raw_checked.historical_replicas.contains(&93));
    assert!(raw_checked.historical_replicas.contains(&94));
    let (pending_snapshot, _, _) = pipeline
        .build_at_boundary(pending_doc, pending_head, Uuid::new_v4(), 1)
        .await
        .unwrap();
    assert!(snapshots
        .transition_building_to_verifying(pending_snapshot)
        .await
        .unwrap());
    pipeline
        .verify(pending_doc, pending_snapshot)
        .await
        .unwrap();
    assert!(pipeline.finalize(pending_snapshot, None).await.unwrap());
    client.execute("UPDATE documents SET compaction_floor_seq=$2,compaction_floor_snapshot_id=$3 WHERE id=$1",&[&pending_doc,&pending_head,&pending_snapshot]).await.unwrap();
    client
        .execute(
            "DELETE FROM crdt_operations WHERE document_id=$1",
            &[&pending_doc],
        )
        .await
        .unwrap();
    let pending_archive = packs.export(pending_doc, owner, signer).await.unwrap();
    let pending_trust = TrustRecord {
        document_id: pending_doc,
        seq: pending_head.to_string(),
        base_snapshot_seq: pending_head.to_string(),
        revision_id: None,
        public_key: allowed[0].clone(),
    };
    let pending_result = packs
        .import(
            destination_owner,
            Uuid::new_v4(),
            "Pending history restored",
            &pending_archive,
            &pending_trust,
            allowed,
        )
        .await
        .unwrap();
    let pending_import: Uuid = pending_result["documentId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(client.query_one("SELECT count(*) AS n FROM crdt_legacy_replicas WHERE document_id=$1 AND replica_id IN(93,94)",&[&pending_import]).await.unwrap().get::<_,i64>("n"),2);
}

// Keep the snapshot-only scenario separate from the round-trip scenario so
// debug test polling does not nest both integration checks on one small stack.
#[tokio::test]
async fn snapshot_pending_identities_are_quarantined() {
    let (db, worker) = test_dependencies().await;
    let packs = PackService {
        repo: GatewayRepo::new(db.clone()),
        worker,
    };
    let owner = UserId(Uuid::new_v4());
    let client = db.get().await.unwrap();
    client
        .execute(
            "INSERT INTO users(id,clerk_user_id) VALUES($1,$2)",
            &[&owner.0, &format!("pack_{owner:?}")],
        )
        .await
        .unwrap();
    let signer = ProofSigner::from_seed([41; 32]);
    let allowed = vec![hex::encode(signer.public_key_bytes())];
    pending_snapshot_identity_check(&packs, owner, owner, &signer, &allowed).await;
    client
        .execute("DELETE FROM documents WHERE owner_user_id=$1", &[&owner.0])
        .await
        .unwrap();
    client
        .execute("DELETE FROM users WHERE id=$1", &[&owner.0])
        .await
        .unwrap();
}

async fn test_dependencies() -> (Db, WorkerPool) {
    let config = Config {
        bind_host: "127.0.0.1".into(),
        bind_port: 0,
        database_url: std::env::var("DATABASE_TEST_URL")
            .unwrap_or("postgres://concord:concord_local_dev@127.0.0.1:5433/concord_test".into()),
        clerk_issuer: "https://test.clerk.accounts.dev".into(),
        clerk_audience: None,
        clerk_authorized_party: None,
        require_internal_services: false,
        allowed_origins: vec![],
        trusted_proxy_cidrs: vec![],
        connect_rate_per_min: 240,
        max_frame_size: 8 * 1024 * 1024,
        per_connection_queue_capacity: 16,
        heartbeat_interval: Duration::from_secs(30),
        idle_timeout: Duration::from_secs(120),
        db_pool_size: 4,
        jwks_file: None,
        nats_url: None,
        nats_subject_prefix: "concord.test".into(),
        gateway_id: 1,
        redis_url: None,
        otel_enabled: false,
        otel_endpoint: "http://127.0.0.1:4317".into(),
        otel_sample_ratio: 1.0,
        otel_exporter: "otlp".into(),
        debug_op_ids: false,
        worker_binary: None,
    };
    let db = Db::connect(&config)
        .await
        .expect("start Concord's test PostgreSQL and migrate the isolated concord_test database");
    run_migrations(&db).await.expect("migrations");
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../build/native/worker/concord-worker");
    assert!(path.is_file(), "build concord-worker first");
    (db, WorkerPool::new(&path, Duration::from_secs(120)))
}
