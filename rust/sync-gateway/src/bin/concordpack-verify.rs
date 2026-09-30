//! Offline verifier: no database, issuer, gateway, or HTTP service is used.
use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;
use sync_gateway::maintenance::concordpack::{verify, TrustRecord, MAX_BYTES};
use sync_gateway::worker::WorkerPool;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("Concordpack REJECTED: {error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut flags = BTreeMap::new();
    while let Some(flag) = args.next() {
        if flag == "--help" {
            println!("concordpack-verify --bundle document.concordpack --trust trusted-record.json --worker /path/to/concord-worker\nTrust must be obtained independently. A signature authenticates a server statement, not physical persistence.");
            return Ok(());
        }
        if !matches!(flag.as_str(), "--bundle" | "--trust" | "--worker")
            || flags.contains_key(&flag)
        {
            return Err("unknown or repeated argument".into());
        }
        let value = args.next().ok_or("argument value is missing")?;
        flags.insert(flag, value);
    }
    let path = PathBuf::from(flags.get("--bundle").ok_or("--bundle is required")?);
    let trust_path = PathBuf::from(
        flags
            .get("--trust")
            .ok_or("--trust is required; the archive cannot supply its own trust")?,
    );
    let trust: TrustRecord = serde_json::from_slice(&read_bounded(&trust_path, 4096)?)?;
    let worker = WorkerPool::new(
        flags.get("--worker").ok_or("--worker is required")?,
        Duration::from_secs(600),
    );
    let bytes = read_bounded(&path, MAX_BYTES)?;
    let verified = verify(&bytes, &trust, &worker).await?;
    let manifest = &verified.archive.manifest;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "result":"verified","documentId":manifest.content.document_id,"seq":manifest.content.seq,
            "baseSnapshotSeq":manifest.content.base_snapshot_seq,"stateDigest":manifest.content.state_digest,
            "keyId":manifest.key_id,"operationCount":manifest.content.operations.len(),
            "snapshotCount":manifest.content.snapshots.len(),"revisions":manifest.content.revisions,
            "guarantee":"Signature authenticates the trusted server's statement; it does not prove physical persistence."
        }))?
    );
    Ok(())
}
fn read_bounded(
    path: &std::path::Path,
    limit: usize,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let file = std::fs::File::open(path)?;
    if !file.metadata()?.is_file() {
        return Err("input must be a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err("input exceeds its size limit".into());
    }
    Ok(bytes)
}
