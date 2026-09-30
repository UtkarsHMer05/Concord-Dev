//! Signed, bounded history archives. The same verifier serves offline CLI and
//! transactional import. No verification path obtains its trust key from a file
//! it is verifying; C++ remains the authority for snapshot and operation semantics.
use super::proofs::{leaf_hash, merkle_root, ProofSigner};
use crate::db::repo::{GatewayRepo, UserId};
use crate::db::snapshots::{validate_integrity, wrapper, SnapshotRow};
use crate::protocol::envelope::validate_op;
use crate::worker::WorkerPool;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_postgres::Transaction;
use uuid::Uuid;

pub const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_MANIFEST: usize = 16 * 1024 * 1024;
const MAX_REVISIONS: usize = 200;
const MAX_SNAPSHOTS: usize = 500;
const MAX_OPS: usize = 1_000_000;
const DOMAIN: &[u8] = b"Concordpack signed history v2\0";

#[derive(Debug, thiserror::Error)]
pub enum PackError {
    #[error("{0}")]
    Invalid(&'static str),
    #[error(transparent)]
    Pg(#[from] tokio_postgres::Error),
    #[error(transparent)]
    Pool(#[from] crate::db::pool::PoolError),
    #[error(transparent)]
    Worker(#[from] crate::worker::WorkerError),
}
type Result<T> = std::result::Result<T, PackError>;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustRecord {
    pub public_key: String,
    pub document_id: Uuid,
    pub seq: String,
    pub base_snapshot_seq: String,
    pub revision_id: Option<Uuid>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackSnapshot {
    pub snapshot_id: Uuid,
    pub seq: String,
    pub op_count: String,
    pub state_digest: String,
    pub bytes: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackOp {
    pub seq: String,
    pub operation_id: String,
    pub checksum: String,
    pub bytes: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackRevision {
    pub revision_id: Uuid,
    pub seq: String,
    pub kind: String,
    pub label: Option<String>,
    /// Original actor is provenance only; it is not a destination principal.
    pub created_by: Option<Uuid>,
    pub created_at_ms: String,
    pub snapshot_id: Option<Uuid>,
    pub restore_source_revision: Option<Uuid>,
    /// None explicitly marks a pruned revision whose state is unavailable.
    pub state_digest: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackContent {
    pub format: String,
    pub version: u8,
    pub document_id: Uuid,
    pub title: String,
    pub seq: String,
    pub floor_seq: String,
    pub base_snapshot_seq: String,
    pub state_digest: String,
    pub root: String,
    pub exported_at_ms: String,
    pub snapshots: Vec<PackSnapshot>,
    pub operations: Vec<PackOp>,
    pub revisions: Vec<PackRevision>,
    pub provenance: Option<Value>,
    pub payload_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedManifest {
    pub content: PackContent,
    pub public_key: String,
    pub key_id: String,
    pub signature: String,
}
#[derive(Clone)]
pub struct Archive {
    pub manifest: SignedManifest,
    pub snapshots: Vec<Vec<u8>>,
    pub operations: Vec<Vec<u8>>,
}
pub struct VerifiedArchive {
    pub archive: Archive,
    pub historical_replicas: BTreeSet<u64>,
    pub visible_content: Value,
}

fn checksum(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn digest_valid(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn sequence(value: &str) -> Result<i64> {
    let parsed = value
        .parse::<i64>()
        .map_err(|_| PackError::Invalid("invalid_boundary"))?;
    if parsed < 0 || parsed.to_string() != value {
        return Err(PackError::Invalid("invalid_boundary"));
    }
    Ok(parsed)
}
fn message(content: &PackContent) -> Result<Vec<u8>> {
    let serialized =
        serde_json::to_vec(content).map_err(|_| PackError::Invalid("invalid_manifest"))?;
    let hash = Sha256::digest(serialized);
    Ok([DOMAIN, &hash[..]].concat())
}
fn now_ms() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

pub fn encode(
    content: PackContent,
    snapshots: Vec<Vec<u8>>,
    operations: Vec<Vec<u8>>,
    signer: &ProofSigner,
) -> Result<Vec<u8>> {
    if signer.is_ephemeral() {
        return Err(PackError::Invalid("stable_signing_key_required"));
    }
    let signature = hex::encode(signer.sign(&message(&content)?));
    let manifest = SignedManifest {
        content,
        public_key: hex::encode(signer.public_key_bytes()),
        key_id: signer.key_id().into(),
        signature,
    };
    let json = serde_json::to_vec(&manifest).map_err(|_| PackError::Invalid("invalid_manifest"))?;
    let payload_len: usize = snapshots
        .iter()
        .chain(operations.iter())
        .map(Vec::len)
        .sum();
    if json.len() > MAX_MANIFEST || 9 + json.len() + payload_len > MAX_BYTES {
        return Err(PackError::Invalid("archive_too_large"));
    }
    let mut bytes = Vec::with_capacity(9 + json.len() + payload_len);
    bytes.extend_from_slice(b"CNCP\x02");
    bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&json);
    for part in snapshots.iter().chain(operations.iter()) {
        bytes.extend_from_slice(part);
    }
    Ok(bytes)
}

pub fn decode(bytes: &[u8], trust: &TrustRecord) -> Result<Archive> {
    if !(10..=MAX_BYTES).contains(&bytes.len()) || &bytes[..5] != b"CNCP\x02" {
        return Err(PackError::Invalid("signed_history_archive_required"));
    }
    let length = u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize;
    if length == 0 || length > MAX_MANIFEST || 9 + length >= bytes.len() {
        return Err(PackError::Invalid("invalid_manifest"));
    }
    let manifest: SignedManifest = serde_json::from_slice(&bytes[9..9 + length])
        .map_err(|_| PackError::Invalid("invalid_manifest"))?;
    if serde_json::to_vec(&manifest).map_err(|_| PackError::Invalid("invalid_manifest"))?
        != bytes[9..9 + length]
    {
        return Err(PackError::Invalid("noncanonical_manifest"));
    }
    let c = &manifest.content;
    if c.format != "concordpack"
        || c.version != 2
        || c.title.trim().is_empty()
        || c.title.chars().count() > 200
        || c.operations.len() > MAX_OPS
        || c.snapshots.len() > MAX_SNAPSHOTS
        || c.revisions.len() > MAX_REVISIONS
        || !digest_valid(&c.state_digest)
    {
        return Err(PackError::Invalid("invalid_manifest"));
    }
    if manifest.public_key != trust.public_key
        || c.document_id != trust.document_id
        || c.seq != trust.seq
        || c.base_snapshot_seq != trust.base_snapshot_seq
    {
        return Err(PackError::Invalid("archive_context_mismatch"));
    }
    if trust.revision_id.is_some_and(|id| {
        !c.revisions
            .iter()
            .any(|r| r.revision_id == id && r.state_digest.is_some())
    }) {
        return Err(PackError::Invalid("expected_revision_unavailable"));
    }
    let public: [u8; 32] = hex::decode(&trust.public_key)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(PackError::Invalid("invalid_trusted_key"))?;
    if manifest.key_id != checksum(&public)[..16] {
        return Err(PackError::Invalid("invalid_key_id"));
    }
    let signature: [u8; 64] = hex::decode(&manifest.signature)
        .ok()
        .and_then(|v| v.try_into().ok())
        .ok_or(PackError::Invalid("invalid_signature"))?;
    VerifyingKey::from_bytes(&public)
        .map_err(|_| PackError::Invalid("invalid_trusted_key"))?
        .verify_strict(&message(c)?, &Signature::from_bytes(&signature))
        .map_err(|_| PackError::Invalid("untrusted_signature"))?;
    let payload = &bytes[9 + length..];
    if checksum(payload) != c.payload_digest {
        return Err(PackError::Invalid("payload_checksum_mismatch"));
    }
    let mut offset = 0usize;
    let mut take = |size: usize| -> Result<Vec<u8>> {
        let end = offset
            .checked_add(size)
            .filter(|end| size > 0 && *end <= payload.len())
            .ok_or(PackError::Invalid("invalid_payload_length"))?;
        let part = payload[offset..end].to_vec();
        offset = end;
        Ok(part)
    };
    let snapshots = c
        .snapshots
        .iter()
        .map(|s| take(s.bytes))
        .collect::<Result<Vec<_>>>()?;
    let operations = c
        .operations
        .iter()
        .map(|s| take(s.bytes))
        .collect::<Result<Vec<_>>>()?;
    if offset != payload.len() {
        return Err(PackError::Invalid("trailing_payload"));
    }
    let archive = Archive {
        manifest,
        snapshots,
        operations,
    };
    validate_metadata(&archive)?;
    Ok(archive)
}

fn validate_metadata(a: &Archive) -> Result<()> {
    let c = &a.manifest.content;
    let end = sequence(&c.seq)?;
    let floor = sequence(&c.floor_seq)?;
    if floor > end || sequence(&c.base_snapshot_seq)? != floor {
        return Err(PackError::Invalid("invalid_snapshot_boundary"));
    }
    timestamp(&c.exported_at_ms)?;
    let mut ids = BTreeSet::new();
    let mut previous = 0i64;
    let mut leaves = vec![];
    for (op, bytes) in c.operations.iter().zip(&a.operations) {
        let seq = sequence(&op.seq)?;
        let envelope = validate_op(bytes).map_err(|_| PackError::Invalid("invalid_operation"))?;
        if seq <= previous
            || seq <= floor
            || seq > end
            || op.operation_id != envelope.identity.to_wire()
            || !ids.insert(op.operation_id.clone())
            || checksum(bytes) != op.checksum
        {
            return Err(PackError::Invalid("operation_log_mismatch"));
        }
        previous = seq;
        leaves.push(leaf_hash(seq as u64, &op.operation_id, &op.checksum));
    }
    if hex::encode(merkle_root(&leaves)) != c.root {
        return Err(PackError::Invalid("merkle_root_mismatch"));
    }
    if end != previous.max(floor) {
        return Err(PackError::Invalid("invalid_head_boundary"));
    }
    ids.clear();
    let mut last = -1;
    for s in &c.snapshots {
        let seq = sequence(&s.seq)?;
        sequence(&s.op_count)?;
        if seq < last
            || seq > end
            || !ids.insert(s.snapshot_id.to_string())
            || !digest_valid(&s.state_digest)
        {
            return Err(PackError::Invalid("invalid_snapshot"));
        }
        last = seq;
    }
    if floor > 0 && !c.snapshots.iter().any(|s| s.seq == c.floor_seq) {
        return Err(PackError::Invalid("floor_snapshot_missing"));
    }
    ids.clear();
    for r in &c.revisions {
        if sequence(&r.seq)? > end
            || !ids.insert(r.revision_id.to_string())
            || !matches!(
                r.kind.as_str(),
                "named" | "auto_checkpoint" | "restore_event"
            )
            || (r.kind == "named"
                && r.label
                    .as_ref()
                    .is_none_or(|l| l.trim().is_empty() || l.chars().count() > 200))
            || r.state_digest.as_deref().is_some_and(|d| !digest_valid(d))
        {
            return Err(PackError::Invalid("invalid_revision"));
        }
        timestamp(&r.created_at_ms)?;
    }
    Ok(())
}
fn timestamp(value: &str) -> Result<i64> {
    let millis = sequence(value)?;
    if millis > 253_402_300_799_999 {
        return Err(PackError::Invalid("invalid_timestamp"));
    }
    Ok(millis)
}

type ReconstructionInput<'a> = (Option<&'a [u8]>, Vec<Vec<u8>>);
fn inputs(a: &Archive, boundary: i64) -> Result<ReconstructionInput<'_>> {
    if boundary == 0 {
        return Ok((None, Vec::new()));
    }
    let c = &a.manifest.content;
    let floor = sequence(&c.floor_seq)?;
    let base = if boundary < floor {
        c.snapshots
            .iter()
            .enumerate()
            .rev()
            .find(|(_, s)| s.seq == boundary.to_string())
    } else if floor > 0 {
        c.snapshots
            .iter()
            .enumerate()
            .rev()
            .find(|(_, s)| s.seq == c.floor_seq)
    } else {
        None
    };
    if boundary < floor && base.is_none() {
        return Err(PackError::Invalid("revision_pruned"));
    }
    let start = base
        .map(|(_, s)| sequence(&s.seq))
        .transpose()?
        .unwrap_or(0);
    let tail = c
        .operations
        .iter()
        .zip(&a.operations)
        .filter(|(o, _)| sequence(&o.seq).is_ok_and(|s| s > start && s <= boundary))
        .map(|(_, p)| p.clone())
        .collect();
    Ok((base.map(|(i, _)| a.snapshots[i].as_slice()), tail))
}
async fn state_digest(a: &Archive, boundary: i64, worker: &WorkerPool) -> Result<String> {
    let (base, tail) = inputs(a, boundary)?;
    Ok(match base {
        Some(s) => worker.digest_after(s, &tail).await?,
        None => worker.reconstruct(&tail).await?,
    }
    .digest)
}
pub async fn verify(
    bytes: &[u8],
    trust: &TrustRecord,
    worker: &WorkerPool,
) -> Result<VerifiedArchive> {
    let archive = decode(bytes, trust)?;
    let c = &archive.manifest.content;
    let floor = sequence(&c.floor_seq)?;
    let mut replicas = BTreeSet::new();
    for (meta, bytes) in c.snapshots.iter().zip(&archive.snapshots) {
        let verified = worker.snapshot_replicas(bytes).await?;
        if verified.digest != meta.state_digest {
            return Err(PackError::Invalid("snapshot_digest_mismatch"));
        }
        let ids: Vec<String> = serde_json::from_str(&verified.json)
            .map_err(|_| PackError::Invalid("invalid_replica_summary"))?;
        for id in ids {
            replicas.insert(
                id.parse()
                    .map_err(|_| PackError::Invalid("invalid_replica_summary"))?,
            );
        }
        let seq = sequence(&meta.seq)?;
        if (seq >= floor || seq == 0)
            && state_digest(&archive, seq, worker).await? != meta.state_digest
        {
            return Err(PackError::Invalid("snapshot_history_mismatch"));
        }
    }
    for r in &c.revisions {
        match (&r.state_digest, inputs(&archive, sequence(&r.seq)?)) {
            (Some(expected), Ok(_))
                if &state_digest(&archive, sequence(&r.seq)?, worker).await? == expected => {}
            (None, Err(PackError::Invalid("revision_pruned"))) => {}
            _ => return Err(PackError::Invalid("revision_digest_mismatch")),
        }
    }
    let (base, tail) = inputs(&archive, sequence(&c.seq)?)?;
    let head = match base {
        Some(snapshot) => worker.fold_after(snapshot, &tail).await?,
        None => worker.reconstruct(&tail).await?,
    };
    if head.digest != c.state_digest {
        return Err(PackError::Invalid("state_digest_mismatch"));
    }
    // The retained tail can contain pending operations and missing references
    // too. Inspect the reconstructed head, not only finalized snapshots.
    let head_replicas = worker
        .snapshot_replicas(
            head.snapshot
                .as_deref()
                .ok_or(PackError::Invalid("snapshot_missing"))?,
        )
        .await?;
    let ids: Vec<String> = serde_json::from_str(&head_replicas.json)
        .map_err(|_| PackError::Invalid("invalid_replica_summary"))?;
    for id in ids {
        replicas.insert(
            id.parse()
                .map_err(|_| PackError::Invalid("invalid_replica_summary"))?,
        );
    }
    let visible = worker.visible_after(base, &tail).await?;
    let visible_content = serde_json::from_str(&visible.json)
        .map_err(|_| PackError::Invalid("invalid_visible_content"))?;
    Ok(VerifiedArchive {
        archive,
        historical_replicas: replicas,
        visible_content,
    })
}

async fn lock(tx: &Transaction<'_>, key: &str) -> Result<()> {
    tx.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",
        &[&key],
    )
    .await?;
    Ok(())
}
async fn read_access(tx: &Transaction<'_>, document: Uuid, actor: UserId) -> Result<()> {
    let row = tx
        .query_opt(crate::db::authz::AUTHZ_QUERY, &[&actor.0, &document])
        .await?
        .ok_or(PackError::Invalid("not_found"))?;
    crate::db::authz::EffectiveRole::resolve(
        row.get("is_owner"),
        row.get::<_, Option<String>>("direct_role").as_deref(),
        row.get("org_member"),
    )
    .filter(|r| r.can_view())
    .ok_or(PackError::Invalid("not_found"))?;
    Ok(())
}

pub struct PackService {
    pub repo: GatewayRepo,
    pub worker: WorkerPool,
}
impl PackService {
    pub async fn export(
        &self,
        document: Uuid,
        actor: UserId,
        signer: &ProofSigner,
    ) -> Result<Vec<u8>> {
        if signer.is_ephemeral() {
            return Err(PackError::Invalid("stable_signing_key_required"));
        }
        let mut client = self.repo.db.get().await?;
        let tx = client.transaction().await?;
        lock(&tx, &document.to_string()).await?;
        read_access(&tx, document, actor).await?;
        let doc = tx
            .query_one(
                "SELECT title,compaction_floor_seq FROM documents WHERE id=$1 FOR SHARE",
                &[&document],
            )
            .await?;
        let seq: i64 = tx
            .query_one(crate::db::repo::DURABLE_CURSOR_QUERY, &[&document])
            .await?
            .get("cursor");
        let floor: i64 = doc
            .get::<_, Option<i64>>("compaction_floor_seq")
            .unwrap_or(0);
        let budget=tx.query_one("SELECT (SELECT COUNT(*) FROM crdt_operations WHERE document_id=$1) AS ops,
            (SELECT COUNT(*) FROM crdt_snapshots WHERE document_id=$1 AND status='finalized' AND coverage_seq<=$2) AS snaps,
            (SELECT COUNT(*) FROM crdt_revisions WHERE document_id=$1) AS revs,
            COALESCE((SELECT SUM(octet_length(payload)) FROM crdt_operations WHERE document_id=$1),0)::bigint+
            COALESCE((SELECT SUM(payload_size) FROM crdt_snapshots WHERE document_id=$1 AND status='finalized' AND coverage_seq<=$2),0)::bigint AS bytes",&[&document,&seq]).await?;
        if budget.get::<_, i64>("ops") > MAX_OPS as i64
            || budget.get::<_, i64>("snaps") > MAX_SNAPSHOTS as i64
            || budget.get::<_, i64>("revs") > MAX_REVISIONS as i64
            || budget.get::<_, i64>("bytes") > MAX_BYTES as i64
        {
            return Err(PackError::Invalid("archive_too_large"));
        }
        let rows=tx.query("SELECT id,operation_id,payload,payload_checksum FROM crdt_operations WHERE document_id=$1 ORDER BY id",&[&document]).await?;
        let mut operations = vec![];
        let mut operation_meta = vec![];
        let mut leaves = vec![];
        for row in rows {
            let id: i64 = row.get("id");
            let payload: Vec<u8> = row.get("payload");
            let checksum: String = row.get("payload_checksum");
            let op_id: String = row.get("operation_id");
            leaves.push(leaf_hash(id as u64, &op_id, &checksum));
            operation_meta.push(PackOp {
                seq: id.to_string(),
                operation_id: op_id,
                bytes: payload.len(),
                checksum,
            });
            operations.push(payload);
        }
        let snapshot_rows=tx.query("SELECT snapshot_id,document_id,format_version,coverage_seq,covered_op_count,state_digest,
            state_summary::text AS state_summary,payload,payload_size,payload_checksum,status,job_id,attempt,created_at,finalized_at
            FROM crdt_snapshots WHERE document_id=$1 AND status='finalized' AND coverage_seq<=$2 ORDER BY coverage_seq,id",&[&document,&seq]).await?;
        let mut snapshots = vec![];
        let mut snapshot_meta = vec![];
        for row in snapshot_rows {
            let row: SnapshotRow = crate::db::snapshots::row_to_snapshot(&row);
            let valid = validate_integrity(&row, document)
                .map_err(|_| PackError::Invalid("source_snapshot_corrupt"))?;
            snapshot_meta.push(PackSnapshot {
                snapshot_id: valid.snapshot_id,
                seq: valid.coverage_seq.to_string(),
                op_count: valid.covered_op_count.to_string(),
                state_digest: valid.state_digest,
                bytes: valid.inner.len(),
            });
            snapshots.push(valid.inner);
        }
        if floor == 0 && snapshots.is_empty() && operations.is_empty() {
            let empty = self.worker.reconstruct(&[]).await?;
            let bytes = empty
                .snapshot
                .ok_or(PackError::Invalid("snapshot_missing"))?;
            snapshot_meta.push(PackSnapshot {
                snapshot_id: Uuid::new_v4(),
                seq: "0".into(),
                op_count: "0".into(),
                state_digest: empty.digest,
                bytes: bytes.len(),
            });
            snapshots.push(bytes);
        }
        let payload_digest = checksum(
            &snapshots
                .iter()
                .chain(&operations)
                .flatten()
                .copied()
                .collect::<Vec<_>>(),
        );
        let origins: Vec<Value> = tx.query("SELECT replica_id,user_id,false AS legacy FROM crdt_replica_owners WHERE document_id=$1
            UNION ALL SELECT replica_id,NULL::uuid,true AS legacy FROM crdt_legacy_replicas WHERE document_id=$1 ORDER BY replica_id",&[&document]).await?
            .iter().map(|row|json!({"replicaId":(row.get::<_,i64>("replica_id") as u64).to_string(),"actorId":row.get::<_,Option<Uuid>>("user_id"),"legacy":row.get::<_,bool>("legacy")})).collect();
        let mut provenance = json!({"replicaOrigins":origins});
        if let Some(row)=tx.query_opt("SELECT archive_manifest,trust_record,sequence_map,snapshot_map,revision_map FROM concordpack_imports WHERE document_id=$1",&[&document]).await? {
            for (key,column) in [("sourceManifest","archive_manifest"),("trustRecord","trust_record"),("sequenceMap","sequence_map"),("snapshotMap","snapshot_map"),("revisionMap","revision_map")] {
                provenance[key]=row.get::<_,Value>(column);
            }
        }
        let provenance = Some(provenance);
        let content = PackContent {
            format: "concordpack".into(),
            version: 2,
            document_id: document,
            title: doc.get("title"),
            seq: seq.to_string(),
            floor_seq: floor.to_string(),
            base_snapshot_seq: floor.to_string(),
            state_digest: format!("sha256:{}", "0".repeat(64)),
            root: hex::encode(merkle_root(&leaves)),
            exported_at_ms: now_ms(),
            snapshots: snapshot_meta,
            operations: operation_meta,
            revisions: vec![],
            provenance,
            payload_digest,
        };
        let mut archive = Archive {
            manifest: SignedManifest {
                content,
                public_key: String::new(),
                key_id: String::new(),
                signature: String::new(),
            },
            snapshots,
            operations,
        };
        archive.manifest.content.state_digest = state_digest(&archive, seq, &self.worker).await?;
        for row in tx.query("SELECT revision_id,target_seq,kind,label,created_by,created_at,snapshot_id,restore_source_revision
            FROM crdt_revisions WHERE document_id=$1 ORDER BY target_seq,id",&[&document]).await? {
            let boundary:i64=row.get("target_seq");
            let digest=match inputs(&archive,boundary) {Ok(_)=>Some(state_digest(&archive,boundary,&self.worker).await?),Err(PackError::Invalid("revision_pruned"))=>None,Err(e)=>return Err(e)};
            let created:SystemTime=row.get("created_at");
            archive.manifest.content.revisions.push(PackRevision {revision_id:row.get("revision_id"),seq:boundary.to_string(),kind:row.get("kind"),label:row.get("label"),
                created_by:row.get("created_by"),created_at_ms:created.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().to_string(),
                snapshot_id:row.get("snapshot_id"),restore_source_revision:row.get("restore_source_revision"),state_digest:digest});
        }
        let bytes = encode(
            archive.manifest.content,
            archive.snapshots,
            archive.operations,
            signer,
        )?;
        let signed: SignedManifest = serde_json::from_slice(
            &bytes[9..9 + u32::from_le_bytes(bytes[5..9].try_into().unwrap()) as usize],
        )
        .map_err(|_| PackError::Invalid("invalid_manifest"))?;
        let trust = TrustRecord {
            public_key: signed.public_key.clone(),
            document_id: document,
            seq: signed.content.seq.clone(),
            base_snapshot_seq: signed.content.base_snapshot_seq.clone(),
            revision_id: None,
        };
        // Validate every exported checkpoint and snapshot before issuing the file.
        verify(&bytes, &trust, &self.worker).await?;
        tx.commit().await?;
        Ok(bytes)
    }

    pub async fn import(
        &self,
        actor: UserId,
        request_id: Uuid,
        title: &str,
        bytes: &[u8],
        trust: &TrustRecord,
        allowed_keys: &[String],
    ) -> Result<Value> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 200 {
            return Err(PackError::Invalid("invalid_title"));
        }
        if !allowed_keys.contains(&trust.public_key) {
            return Err(PackError::Invalid("untrusted_import_key"));
        }
        let verified = verify(bytes, trust, &self.worker).await?;
        let archive_hash = checksum(bytes);
        let trust_json =
            serde_json::to_value(trust).map_err(|_| PackError::Invalid("invalid_trust_record"))?;
        let mut client = self.repo.db.get().await?;
        let tx = client.transaction().await?;
        lock(&tx, &format!("concordpack-import:{request_id}")).await?;
        if let Some(row)=tx.query_opt("SELECT document_id,actor_id,archive_checksum,destination_title,trust_record FROM concordpack_imports WHERE request_id=$1",&[&request_id]).await? {
            if row.get::<_,Uuid>("actor_id")!=actor.0 {return Err(PackError::Invalid("not_found"));}
            if row.get::<_,String>("archive_checksum")!=archive_hash || row.get::<_,String>("destination_title")!=title || row.get::<_,Value>("trust_record")!=trust_json {
                return Err(PackError::Invalid("request_id_conflicts"));
            }
            let document:Uuid=row.get("document_id"); read_access(&tx,document,actor).await?;
            return Ok(import_response(document,request_id,&verified.archive.manifest));
        }
        // Destination ownership is explicit. Source ACLs and actor UUIDs remain
        // provenance; no source users, organizations, or grants are transplanted.
        let document = Uuid::new_v4();
        tx.execute(
            "INSERT INTO documents(id,title,owner_user_id,organization_id) VALUES($1,$2,$3,NULL)",
            &[&document, &title, &actor.0],
        )
        .await?;
        let c = &verified.archive.manifest.content;
        let mut boundaries = BTreeSet::new();
        boundaries.insert(sequence(&c.seq)?);
        boundaries.insert(sequence(&c.floor_seq)?);
        for s in &c.snapshots {
            boundaries.insert(sequence(&s.seq)?);
        }
        for o in &c.operations {
            boundaries.insert(sequence(&o.seq)?);
        }
        for r in &c.revisions {
            boundaries.insert(sequence(&r.seq)?);
        }
        let mut seq_map = BTreeMap::new();
        seq_map.insert(0i64, 0i64);
        let count = boundaries.iter().filter(|s| **s > 0).count() as i64;
        let mut assigned=tx.query("SELECT nextval(pg_get_serial_sequence('crdt_operations','id')) AS id FROM generate_series(1,$1::bigint)",&[&count]).await?;
        assigned.sort_by_key(|row| row.get::<_, i64>("id"));
        for (source, row) in boundaries.into_iter().filter(|s| *s > 0).zip(assigned) {
            seq_map.insert(source, row.get::<_, i64>("id"));
        }
        let destination_seq = |s: &str| -> Result<i64> {
            seq_map
                .get(&sequence(s)?)
                .copied()
                .ok_or(PackError::Invalid("missing_boundary_map"))
        };
        let mut snapshot_map = BTreeMap::new();
        let mut attempts = BTreeMap::<i64, i32>::new();
        for (meta, inner) in c.snapshots.iter().zip(&verified.archive.snapshots) {
            let snapshot = Uuid::new_v4();
            snapshot_map.insert(meta.snapshot_id, snapshot);
            let boundary = destination_seq(&meta.seq)?;
            let op_count = sequence(&meta.op_count)?;
            let payload =
                wrapper::encode_wrapper(document, boundary as u64, op_count as u64, inner);
            let size = payload.len() as i64;
            let checksum = checksum(&payload);
            let attempt = attempts.entry(boundary).or_default();
            *attempt += 1;
            tx.execute("INSERT INTO crdt_snapshots(snapshot_id,document_id,format_version,coverage_seq,covered_op_count,state_digest,state_summary,payload,payload_size,payload_checksum,status,attempt,finalized_at)
                VALUES($1,$2,1,$3,$4,$5,'{}',$6,$7,$8,'finalized',$9,now())",&[&snapshot,&document,&boundary,&op_count,&meta.state_digest,&payload,&size,&checksum,attempt]).await?;
        }
        let envelopes = verified
            .archive
            .operations
            .iter()
            .map(|b| validate_op(b).map_err(|_| PackError::Invalid("invalid_operation")))
            .collect::<Result<Vec<_>>>()?;
        let ids: Vec<i64> = c
            .operations
            .iter()
            .map(|o| destination_seq(&o.seq))
            .collect::<Result<_>>()?;
        let op_ids: Vec<String> = c
            .operations
            .iter()
            .map(|o| o.operation_id.clone())
            .collect();
        let replicas: Vec<i64> = envelopes
            .iter()
            .map(|o| o.identity.replica as i64)
            .collect();
        let counters: Vec<i64> = envelopes
            .iter()
            .map(|o| o.identity.counter as i64)
            .collect();
        let checksums: Vec<String> = c.operations.iter().map(|o| o.checksum.clone()).collect();
        tx.execute("INSERT INTO crdt_operations(id,document_id,operation_id,replica_id,replica_sequence,payload,payload_version,payload_checksum)
            SELECT id,$1::uuid,op,replica,counter,payload,1,checksum FROM unnest($2::bigint[],$3::text[],$4::bigint[],$5::bigint[],$6::bytea[],$7::text[])
                AS t(id,op,replica,counter,payload,checksum)",&[&document,&ids,&op_ids,&replicas,&counters,&verified.archive.operations,&checksums]).await?;
        let historical: Vec<i64> = verified
            .historical_replicas
            .iter()
            .map(|r| *r as i64)
            .filter(|r| !matches!(*r as u64, 0x5245_5354 | 0x5359_5343))
            .collect();
        tx.execute("INSERT INTO crdt_legacy_replicas(document_id,replica_id) SELECT $1::uuid,r FROM unnest($2::bigint[]) t(r)",&[&document,&historical]).await?;
        if sequence(&c.floor_seq)? > 0 {
            let original = c
                .snapshots
                .iter()
                .rev()
                .find(|s| s.seq == c.floor_seq)
                .ok_or(PackError::Invalid("floor_snapshot_missing"))?;
            let snapshot = snapshot_map[&original.snapshot_id];
            let floor = destination_seq(&c.floor_seq)?;
            tx.execute("UPDATE documents SET compaction_floor_seq=$2,compaction_floor_snapshot_id=$3 WHERE id=$1",&[&document,&floor,&snapshot]).await?;
        }
        let revision_map: BTreeMap<Uuid, Uuid> = c
            .revisions
            .iter()
            .map(|r| (r.revision_id, Uuid::new_v4()))
            .collect();
        for r in &c.revisions {
            let revision = revision_map[&r.revision_id];
            let seq = destination_seq(&r.seq)?;
            let snapshot = r.snapshot_id.and_then(|s| snapshot_map.get(&s).copied());
            let restore = r
                .restore_source_revision
                .and_then(|s| revision_map.get(&s).copied());
            let created =
                UNIX_EPOCH + std::time::Duration::from_millis(sequence(&r.created_at_ms)? as u64);
            tx.execute("INSERT INTO crdt_revisions(revision_id,document_id,target_seq,kind,label,created_by,snapshot_id,restore_source_revision,created_at)
                VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8)",&[&revision,&document,&seq,&r.kind,&r.label,&snapshot,&restore,&created]).await?;
        }
        let manifest = serde_json::to_value(&verified.archive.manifest)
            .map_err(|_| PackError::Invalid("invalid_manifest"))?;
        let seq_json = serde_json::to_value(
            seq_map
                .iter()
                .map(|(s, d)| (s.to_string(), d.to_string()))
                .collect::<BTreeMap<_, _>>(),
        )
        .unwrap();
        let snapshot_json = serde_json::to_value(snapshot_map).unwrap();
        let revision_json = serde_json::to_value(revision_map).unwrap();
        tx.execute("INSERT INTO concordpack_imports(request_id,document_id,actor_id,archive_checksum,archive,archive_manifest,trust_record,destination_title,sequence_map,snapshot_map,revision_map)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",&[&request_id,&document,&actor.0,&archive_hash,&bytes,&manifest,&trust_json,&title,&seq_json,&snapshot_json,&revision_json]).await?;
        tx.execute("INSERT INTO audit_events(actor_user_id,action,resource_type,resource_id,metadata) VALUES($1,'document.import_history','document',$2,$3)",
            &[&actor.0,&document.to_string(),&json!({"requestId":request_id,"sourceDocumentId":c.document_id,"sourceSeq":c.seq,"keyId":verified.archive.manifest.key_id,"archiveChecksum":archive_hash})]).await?;
        tx.commit().await?;
        Ok(import_response(
            document,
            request_id,
            &verified.archive.manifest,
        ))
    }
    pub async fn provenance(&self, document: Uuid, actor: UserId) -> Result<Value> {
        let mut client = self.repo.db.get().await?;
        let tx = client.transaction().await?;
        read_access(&tx, document, actor).await?;
        let row=tx.query_opt("SELECT request_id,archive_checksum,archive_manifest,trust_record,sequence_map,snapshot_map,revision_map FROM concordpack_imports WHERE document_id=$1",&[&document]).await?
            .ok_or(PackError::Invalid("not_found"))?;
        Ok(
            json!({"requestId":row.get::<_,Uuid>("request_id"),"archiveChecksum":row.get::<_,String>("archive_checksum"),
            "manifest":row.get::<_,Value>("archive_manifest"),"trust":row.get::<_,Value>("trust_record"),"sequenceMap":row.get::<_,Value>("sequence_map"),
            "snapshotMap":row.get::<_,Value>("snapshot_map"),"revisionMap":row.get::<_,Value>("revision_map")}),
        )
    }
}
fn import_response(document: Uuid, request: Uuid, manifest: &SignedManifest) -> Value {
    json!({"documentId":document,"requestId":request,"sourceDocumentId":manifest.content.document_id,"sourceSeq":manifest.content.seq,
        "stateDigest":manifest.content.state_digest,"retainedRevisions":manifest.content.revisions.iter().filter(|r|r.state_digest.is_some()).count(),
        "prunedRevisions":manifest.content.revisions.iter().filter(|r|r.state_digest.is_none()).count(),"operationCount":manifest.content.operations.len(),
        "keyId":manifest.key_id,"workspace":"personal","sourcePermissionsCopied":false})
}
