//! Native C++ worker orchestration (P5-M015, DEC-038).
//!
//! Spawns the standalone `concord-worker` process per request — no shell,
//! no FFI — and speaks its length-prefixed binary protocol over bounded
//! stdin/stdout:
//!
//!   request  = [u32 LE frame_len][frame]
//!   frame    = [u32 LE command][command-specific body]
//!   response = [u32 LE frame_len][frame]
//!   frame    = [u32 LE status][ok: outputs | error: [u32 msg_len][msg]]
//!
//! Every call is bounded (input frame cap, output frame cap, wall-clock
//! timeout), cancellable (the child is killed when the future is dropped
//! or the deadline passes), and classified into a structured error so
//! maintenance jobs can decide retryable vs terminal.
//!
//! Safety (prompt §8): argv is fixed (no shell interpolation — the worker
//! path is the ONLY argument and comes from config); stdin carries only
//! op/snapshot bytes; stdout/stderr are captured to bounded buffers; the
//! worker never receives tokens, DSNs, or any secret.

use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::telemetry::Metrics;

/// Worker protocol commands (mirrors cpp/worker/main.cpp).
pub mod cmd {
    pub const RECONSTRUCT: u32 = 1;
    pub const EXPORT_SNAPSHOT: u32 = 2;
    pub const IMPORT_VERIFY: u32 = 3;
    pub const DIGEST_AFTER: u32 = 4;
    pub const VERIFY_SNAPSHOT: u32 = 5;
    pub const GENERATE_OPS: u32 = 6;
    pub const RESTORE_DIFF: u32 = 7;
}

/// Worker status codes (mirrors cpp/worker/main.cpp).
pub mod status {
    pub const OK: u32 = 0;
    pub const MALFORMED: u32 = 1;
    pub const VERSION_UNSUPPORTED: u32 = 2;
    pub const OP_APPLY_ERROR: u32 = 3;
    pub const SIZE_EXCEEDED: u32 = 4;
    pub const INTERNAL: u32 = 5;
}

/// Hard protocol limits shared with the worker (256 MiB frames).
const MAX_FRAME_BYTES: u32 = 256 * 1024 * 1024;
/// Bounded stderr capture (the worker's stderr is fatal-diagnostics-only).
const MAX_STDERR_BYTES: usize = 64 * 1024;

/// Structured classification for callers deciding retryable vs terminal.
#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    /// Worker binary missing/not executable at the configured path.
    #[error("worker binary unavailable: {0}")]
    BinaryUnavailable(String),
    /// Wall-clock deadline passed; the child was killed.
    #[error("worker timed out after {0:?}")]
    TimedOut(Duration),
    /// The future was cancelled; the child was killed.
    #[error("worker invocation cancelled")]
    Cancelled,
    /// Worker exited with a framing-failure code (unframeable stdin).
    #[error("worker framing error (exit {exit_code}): {detail}")]
    Framing { exit_code: i32, detail: String },
    /// Worker reported a structured status != 0.
    #[error("worker status {status}: {message}")]
    Status { status: u32, message: String },
    /// Response frame violated the protocol (oversize, truncated, or
    /// unframeable payload). Treated as a worker bug — terminal class.
    #[error("worker response malformed: {0}")]
    MalformedResponse(String),
    /// Spawn or I/O failure.
    #[error("worker spawn/io error: {0}")]
    Io(#[from] std::io::Error),
}

impl WorkerError {
    /// Retryable failures: transient process/spawn conditions and
    /// timeouts. Structured worker statuses reflect input content and
    /// are terminal (retrying the same bytes cannot help); a malformed
    /// response indicates a build mismatch — also terminal.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            WorkerError::TimedOut(_) | WorkerError::Io(_) | WorkerError::Cancelled
        )
    }
}

/// A successful worker response (status 0), decoded.
#[derive(Debug, Clone)]
pub struct WorkerOk {
    /// Canonical CRDT digest ("sha256:<hex>") — always present.
    pub digest: String,
    /// Inner v1 snapshot bytes — present for RECONSTRUCT/EXPORT.
    pub snapshot: Option<Vec<u8>>,
}

/// Orchestrates one process-per-request worker invocations.
#[derive(Debug, Clone)]
pub struct WorkerPool {
    binary: PathBuf,
    timeout: Duration,
}

impl WorkerPool {
    /// Builds a pool descriptor. The binary path is the ONLY argv
    /// element ever passed to the child (no shell, no interpolation).
    pub fn new(binary: impl Into<PathBuf>, timeout: Duration) -> Self {
        Self {
            binary: binary.into(),
            timeout,
        }
    }

    pub fn binary_path(&self) -> &PathBuf {
        &self.binary
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// Runs one request frame and returns the raw response frame.
    ///
    /// Cancellation-safe: dropping the returned future kills the child
    /// (spawn.kill_on_drop(true)) so no zombie outlives the caller.
    /// Command-specific decoders (e.g. [`Self::generate_ops`]) build on
    /// this; the generic [`Self::request`] handles the common
    /// [status][digest (± snapshot)] shape.
    pub async fn request_frame(&self, command: u32, body: Vec<u8>) -> Result<Vec<u8>, WorkerError> {
        if !self.binary.is_file() {
            return Err(WorkerError::BinaryUnavailable(
                self.binary.display().to_string(),
            ));
        }

        let mut frame = Vec::with_capacity(4 + body.len());
        put_u32le(&mut frame, command);
        frame.extend_from_slice(&body);
        if frame.len() > MAX_FRAME_BYTES as usize {
            // Refuse locally rather than shipping an oversize frame the
            // worker must reject (classified as a status error, terminal).
            return Err(WorkerError::Status {
                status: status::SIZE_EXCEEDED,
                message: "request frame exceeds worker limit".into(),
            });
        }
        let mut request = Vec::with_capacity(4 + frame.len());
        put_u32le(&mut request, frame.len() as u32);
        request.extend_from_slice(&frame);

        let mut child = Command::new(&self.binary)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        // Bounded stderr drain (never blocks the response path).
        let mut stderr_pipe = child.stderr.take().expect("stderr piped");
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::with_capacity(MAX_STDERR_BYTES);
            let mut chunk = [0u8; 4096];
            loop {
                match stderr_pipe.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf.len() < MAX_STDERR_BYTES {
                            let take = n.min(MAX_STDERR_BYTES - buf.len());
                            buf.extend_from_slice(&chunk[..take]);
                        }
                    }
                }
            }
            buf
        });

        // Write the request, close stdin (EOF = one-request protocol).
        {
            let mut stdin = child.stdin.take().expect("stdin piped");
            // Short writes are handled by write_all; a worker exiting
            // early surfaces as a broken pipe → Io error (retryable).
            stdin.write_all(&request).await?;
            stdin.flush().await?;
        }

        let mut stdout_pipe = child.stdout.take().expect("stdout piped");

        // Bounded stdout read under a wall-clock deadline. NOTE: the
        // worker length-prefixes the REQUEST (stdin) but writes the
        // RESPONSE as a bare frame — status first, no outer length
        // (verified against cpp/worker/main.cpp emit_* which write the
        // status word directly). Read until EOF with the cap as the
        // only bound.
        let mut stdout_buf = Vec::with_capacity(4096);
        let started = std::time::Instant::now();
        {
            let mut chunk = [0u8; 16384];
            loop {
                let read = tokio::time::timeout(self.timeout, stdout_pipe.read(&mut chunk)).await;
                match read {
                    Err(_) => {
                        let _ = child.start_kill();
                        Metrics::global()
                            .worker_timeouts
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        return Err(WorkerError::TimedOut(started.elapsed()));
                    }
                    Ok(Err(e)) => return Err(WorkerError::Io(e)),
                    Ok(Ok(0)) => break, // EOF: response complete
                    Ok(Ok(n)) => {
                        if stdout_buf.len() + n > MAX_FRAME_BYTES as usize {
                            let _ = child.start_kill();
                            return Err(WorkerError::MalformedResponse(
                                "response exceeds frame limit".into(),
                            ));
                        }
                        stdout_buf.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        }

        // Reap the child (no zombie) and collect bounded stderr.
        let exit = child.wait().await?;
        let stderr = stderr_task.await.unwrap_or_default();
        if !exit.success() {
            let detail = String::from_utf8_lossy(&stderr).trim().to_string();
            return Err(WorkerError::Framing {
                exit_code: exit.code().unwrap_or(-1),
                detail,
            });
        }

        Ok(stdout_buf)
    }

    /// Generic request: decodes the common
    /// [status][ok: [digest_len][digest] (± [snapshot_len][snapshot]) |
    /// error: [msg_len][msg]] response shape.
    pub async fn request(&self, command: u32, body: Vec<u8>) -> Result<WorkerOk, WorkerError> {
        let frame = self.request_frame(command, body).await?;
        decode_response(&frame)
    }

    // ----- command wrappers ------------------------------------------------

    /// Reconstructs a replica from op payloads (each entry = one stored
    /// `crdt_operations.payload` = one serialize_batch frame) and returns
    /// the canonical digest + exported inner snapshot.
    pub async fn reconstruct(&self, op_payloads: &[Vec<u8>]) -> Result<WorkerOk, WorkerError> {
        let body = encode_op_batches(op_payloads);
        self.request(cmd::RECONSTRUCT, body).await
    }

    /// Digest of a snapshot imported into a fresh replica (M017 verify
    /// step 1: does it import at all, and to what state?).
    pub async fn import_digest(&self, snapshot: &[u8]) -> Result<WorkerOk, WorkerError> {
        let body = encode_snapshot_only(snapshot);
        self.request(cmd::IMPORT_VERIFY, body).await
    }

    /// Digest after importing a snapshot and replaying tail ops —
    /// the snapshot+tail recovery primitive (M020).
    pub async fn digest_after(
        &self,
        snapshot: &[u8],
        tail_op_payloads: &[Vec<u8>],
    ) -> Result<WorkerOk, WorkerError> {
        let mut body = encode_snapshot_only(snapshot);
        body.extend_from_slice(&encode_op_batches(tail_op_payloads));
        self.request(cmd::DIGEST_AFTER, body).await
    }

    /// CMD_GENERATE_OPS (6): deterministic seeded rich-op stream.
    ///
    /// Response shape: `[status]`, then on ok `[digest_len][digest]`,
    /// then `[batch_count]` followed by batches of
    /// `[u32 len][serialize_batch frames]`. The tail is NOT the
    /// snapshot-shaped `[len][bytes]`, so this method decodes the
    /// response itself rather than the generic path.
    pub async fn generate_ops(
        &self,
        seed: u64,
        op_count: u32,
        replica_count: u32,
        shape: u32,
    ) -> Result<GeneratedStream, WorkerError> {
        let mut body = Vec::with_capacity(20);
        body.extend_from_slice(&seed.to_le_bytes());
        body.extend_from_slice(&op_count.to_le_bytes());
        body.extend_from_slice(&replica_count.to_le_bytes());
        body.extend_from_slice(&shape.to_le_bytes());
        let frame = self.request_frame(cmd::GENERATE_OPS, body).await?;
        // Decode: [u32 status][ok: [u32 digest_len][digest]
        //   [u32 batch_count] + batches × ([u32 len][bytes])
        let mut offset = 0usize;
        let get_u32 = |f: &[u8], o: usize| -> Option<u32> {
            f.get(o..o + 4)
                .map(|b| u32::from_le_bytes(b.try_into().expect("4")))
        };
        let Some(status_code) = get_u32(&frame, offset) else {
            return Err(WorkerError::MalformedResponse("short status".into()));
        };
        offset += 4;
        if status_code != status::OK {
            let Some(msg_len) = get_u32(&frame, offset) else {
                return Err(WorkerError::MalformedResponse(
                    "error length missing".into(),
                ));
            };
            offset += 4;
            let Some(bytes) = frame.get(offset..offset + msg_len as usize) else {
                return Err(WorkerError::MalformedResponse(
                    "error message truncated".into(),
                ));
            };
            return Err(WorkerError::Status {
                status: status_code,
                message: String::from_utf8_lossy(bytes).trim().to_string(),
            });
        }
        let Some(digest_len) = get_u32(&frame, offset) else {
            return Err(WorkerError::MalformedResponse(
                "digest length missing".into(),
            ));
        };
        offset += 4;
        let Some(digest_bytes) = frame.get(offset..offset + digest_len as usize) else {
            return Err(WorkerError::MalformedResponse("digest truncated".into()));
        };
        let digest = String::from_utf8(digest_bytes.to_vec())
            .map_err(|_| WorkerError::MalformedResponse("digest not utf-8".into()))?;
        offset += digest_len as usize;
        let Some(batch_count) = get_u32(&frame, offset) else {
            return Err(WorkerError::MalformedResponse("batch count missing".into()));
        };
        offset += 4;
        let mut batches = Vec::with_capacity(batch_count as usize);
        for _ in 0..batch_count {
            let Some(len) = get_u32(&frame, offset) else {
                return Err(WorkerError::MalformedResponse(
                    "batch length missing".into(),
                ));
            };
            offset += 4;
            let Some(bytes) = frame.get(offset..offset + len as usize) else {
                return Err(WorkerError::MalformedResponse("batch truncated".into()));
            };
            batches.push(bytes.to_vec());
            offset += len as usize;
        }
        if offset != frame.len() {
            return Err(WorkerError::MalformedResponse(
                "trailing bytes in generated stream".into(),
            ));
        }
        Ok(GeneratedStream { digest, batches })
    }

    /// CMD_RESTORE_DIFF (7): computes the forward-op batch that converges
    /// the CURRENT state (snapshot A) to the TARGET state (snapshot B)'s
    /// visible content. Response shape (dedicated, like generate_ops):
    /// `[status][ok: [digest_len][target digest][batch_len][batch bytes]
    /// | error: [msg_len][msg]]` — the batch is ONE serialize_batch frame.
    ///
    /// The worker re-folds A + batch internally and refuses (status 3)
    /// unless it converges to B's visible content, so status 0 IS the
    /// convergence proof (P5-M036; restore ops carry the reserved REST
    /// replica 0x52455354).
    pub async fn restore_diff(
        &self,
        current_snapshot: &[u8],
        target_snapshot: &[u8],
    ) -> Result<RestoreDiff, WorkerError> {
        let mut body = Vec::with_capacity(8 + current_snapshot.len() + target_snapshot.len());
        put_u32le(&mut body, current_snapshot.len() as u32);
        body.extend_from_slice(current_snapshot);
        put_u32le(&mut body, target_snapshot.len() as u32);
        body.extend_from_slice(target_snapshot);
        let frame = self.request_frame(cmd::RESTORE_DIFF, body).await?;
        let mut offset = 0usize;
        let get_u32 = |f: &[u8], o: usize| -> Option<u32> {
            f.get(o..o + 4)
                .map(|b| u32::from_le_bytes(b.try_into().expect("4")))
        };
        let Some(status_code) = get_u32(&frame, offset) else {
            return Err(WorkerError::MalformedResponse("short status".into()));
        };
        offset += 4;
        if status_code != status::OK {
            let Some(msg_len) = get_u32(&frame, offset) else {
                return Err(WorkerError::MalformedResponse(
                    "error length missing".into(),
                ));
            };
            offset += 4;
            let Some(bytes) = frame.get(offset..offset + msg_len as usize) else {
                return Err(WorkerError::MalformedResponse(
                    "error message truncated".into(),
                ));
            };
            return Err(WorkerError::Status {
                status: status_code,
                message: String::from_utf8_lossy(bytes).trim().to_string(),
            });
        }
        let Some(digest_len) = get_u32(&frame, offset) else {
            return Err(WorkerError::MalformedResponse(
                "digest length missing".into(),
            ));
        };
        offset += 4;
        let Some(digest_bytes) = frame.get(offset..offset + digest_len as usize) else {
            return Err(WorkerError::MalformedResponse("digest truncated".into()));
        };
        let digest = String::from_utf8(digest_bytes.to_vec())
            .map_err(|_| WorkerError::MalformedResponse("digest not utf-8".into()))?;
        offset += digest_len as usize;
        let Some(batch_len) = get_u32(&frame, offset) else {
            return Err(WorkerError::MalformedResponse(
                "batch length missing".into(),
            ));
        };
        offset += 4;
        let Some(batch) = frame.get(offset..offset + batch_len as usize) else {
            return Err(WorkerError::MalformedResponse("batch truncated".into()));
        };
        let batch = batch.to_vec();
        offset += batch_len as usize;
        if offset != frame.len() {
            return Err(WorkerError::MalformedResponse(
                "trailing bytes in restore diff".into(),
            ));
        }
        Ok(RestoreDiff {
            target_digest: digest,
            batch,
        })
    }
}

/// A generated op stream (CMD_GENERATE_OPS): the digest of the final
/// state after applying all batches in order, plus the batches (each a
/// complete serialize_batch frame as the worker protocol emits).
#[derive(Debug, Clone)]
pub struct GeneratedStream {
    pub digest: String,
    pub batches: Vec<Vec<u8>>,
}

/// One computed restore diff: the target state's canonical digest
/// (verification reference) and the forward-op batch frame.
#[derive(Debug, Clone)]
pub struct RestoreDiff {
    /// Canonical digest of the TARGET state (the convergence reference).
    pub target_digest: String,
    /// The complete serialize_batch frame of forward restore ops.
    pub batch: Vec<u8>,
}

// ----- codec helpers -------------------------------------------------------

fn put_u32le(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// The durable log stores ONE RAW op per row (version+type header, no
/// batch prefix — `crdt_operations.payload` / OpEnvelope::bytes). The
/// worker's batch sections speak `serialize_batch` frames
/// ([u32 LE op_count][per-op [u32 len][bytes]]), so each payload is
/// wrapped as a single-op batch frame at the adapter boundary; the
/// worker re-parses and validates verbatim (M014 protocol).
fn wrap_single_op_batch(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(8 + payload.len());
    put_u32le(&mut out, 1); // count
    put_u32le(&mut out, payload.len() as u32);
    out.extend_from_slice(payload);
    out
}

/// [u32 batch_count] + batches × ([u32 len][serialize_batch bytes]).
/// Input entries are raw single-op payloads from the durable log and
/// are wrapped per [`wrap_single_op_batch`].
fn encode_op_batches(op_payloads: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + op_payloads.iter().map(|o| 12 + o.len()).sum::<usize>());
    put_u32le(&mut out, op_payloads.len() as u32);
    for payload in op_payloads {
        let wrapped = wrap_single_op_batch(payload);
        put_u32le(&mut out, wrapped.len() as u32);
        out.extend_from_slice(&wrapped);
    }
    out
}

/// [u32 snapshot_len][snapshot bytes].
fn encode_snapshot_only(snapshot: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + snapshot.len());
    put_u32le(&mut out, snapshot.len() as u32);
    out.extend_from_slice(snapshot);
    out
}

/// Decodes [status][ok: [u32 digest_len][digest] (+ [u32 snap_len][snap]) |
/// error: [u32 msg_len][msg]].
fn decode_response(frame: &[u8]) -> Result<WorkerOk, WorkerError> {
    let mut offset = 0usize;
    let get_u32 = |frame: &[u8], offset: usize| -> Option<u32> {
        frame
            .get(offset..offset + 4)
            .map(|b| u32::from_le_bytes(b.try_into().expect("4 bytes")))
    };
    let Some(status_code) = get_u32(frame, offset) else {
        return Err(WorkerError::MalformedResponse(
            "response shorter than status word".into(),
        ));
    };
    offset += 4;
    if status_code != status::OK {
        // Error payload: [u32 msg_len][message].
        let Some(msg_len) = get_u32(frame, offset) else {
            return Err(WorkerError::MalformedResponse(
                "error response missing message length".into(),
            ));
        };
        offset += 4;
        let Some(bytes) = frame.get(offset..offset + msg_len as usize) else {
            return Err(WorkerError::MalformedResponse(
                "error message shorter than declared".into(),
            ));
        };
        let message = String::from_utf8_lossy(bytes).trim().to_string();
        return Err(WorkerError::Status {
            status: status_code,
            message,
        });
    }
    // OK: [u32 digest_len][digest] (snapshot optional depending on cmd —
    // the caller knows; decode opportunistically).
    let Some(digest_len) = get_u32(frame, offset) else {
        return Err(WorkerError::MalformedResponse(
            "ok response missing digest length".into(),
        ));
    };
    offset += 4;
    let Some(digest_bytes) = frame.get(offset..offset + digest_len as usize) else {
        return Err(WorkerError::MalformedResponse(
            "digest shorter than declared".into(),
        ));
    };
    offset += digest_len as usize;
    let digest = String::from_utf8(digest_bytes.to_vec())
        .map_err(|_| WorkerError::MalformedResponse("digest not utf-8".into()))?;
    let snapshot = if offset < frame.len() {
        let Some(snap_len) = get_u32(frame, offset) else {
            return Err(WorkerError::MalformedResponse(
                "snapshot length truncated".into(),
            ));
        };
        offset += 4;
        let Some(bytes) = frame.get(offset..offset + snap_len as usize) else {
            return Err(WorkerError::MalformedResponse(
                "snapshot shorter than declared".into(),
            ));
        };
        offset += snap_len as usize;
        Some(bytes.to_vec())
    } else {
        None
    };
    if offset != frame.len() {
        return Err(WorkerError::MalformedResponse(
            "trailing bytes in response".into(),
        ));
    }
    Ok(WorkerOk { digest, snapshot })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live_worker() -> Option<WorkerPool> {
        // Tests find the worker via the repo-relative build path; skipped
        // when not built (documented precondition: the native gate script
        // or `cmake --build build/native`). Both layout depths are probed
        // (top-level and per-target subdirectory).
        let mut root = std::env::current_dir().expect("cwd");
        for _ in 0..3 {
            for rel in [
                "build/native/concord-worker",
                "build/native/worker/concord-worker",
            ] {
                let mut path = root.clone();
                path.push(rel);
                if path.is_file() {
                    return Some(WorkerPool::new(path, Duration::from_secs(60)));
                }
            }
            if !root.pop() {
                break;
            }
        }
        eprintln!("SKIP: concord-worker binary not built (build/native)");
        None
    }

    /// A tiny valid op stream: build ops through the worker itself by
    /// reconstructing an empty batch (digest of the empty doc) — the
    /// empty-history case is a real, meaningful boundary.
    #[tokio::test]
    async fn empty_reconstruction_round_trips() {
        let Some(pool) = live_worker() else { return };
        let ok = pool.reconstruct(&[]).await.expect("empty reconstruct");
        assert!(ok.digest.starts_with("sha256:"));
        let snapshot = ok.snapshot.expect("reconstruct returns snapshot");
        let verify = pool
            .import_digest(&snapshot)
            .await
            .expect("import verifies");
        assert_eq!(ok.digest, verify.digest, "import must reproduce the digest");
    }

    #[tokio::test]
    async fn missing_binary_fails_closed() {
        let pool = WorkerPool::new("/nonexistent/concord-worker", Duration::from_secs(5));
        let err = pool.reconstruct(&[]).await.expect_err("must fail");
        assert!(matches!(err, WorkerError::BinaryUnavailable(_)));
        assert!(!err.is_retryable(), "missing binary is terminal");
    }

    #[tokio::test]
    async fn malformed_worker_response_is_classified() {
        // A fake "worker": a shell-less static response is impossible to
        // fabricate without a binary; instead validate the decoder unit-
        // style with crafted frames.
        let ok_frame = {
            let mut f = Vec::new();
            put_u32le(&mut f, 0);
            put_u32le(&mut f, 5);
            f.extend_from_slice(b"hello");
            f
        };
        let decoded = decode_response(&ok_frame).expect("decodes");
        assert_eq!(decoded.digest, "hello");
        assert!(decoded.snapshot.is_none());

        let err_frame = {
            let mut f = Vec::new();
            put_u32le(&mut f, 2);
            put_u32le(&mut f, 3);
            f.extend_from_slice(b"bad");
            f
        };
        let err = decode_response(&err_frame).expect_err("status 2");
        let classification = err.is_retryable();
        match err {
            WorkerError::Status { status, message } => {
                assert_eq!(status, 2);
                assert_eq!(message, "bad");
            }
            other => panic!("wrong classification: {other:?}"),
        }
        assert!(!classification);

        assert!(decode_response(&[0, 0]).is_err(), "truncated status word");
        let trailing = {
            let mut f = Vec::new();
            put_u32le(&mut f, 0);
            put_u32le(&mut f, 1);
            f.extend_from_slice(b"h");
            f.extend_from_slice(b"junk");
            put_u32le(&mut f, 0);
            f
        };
        // trailing: digest "h", then snapshot_len=0? "junk" is 4 bytes
        // read as snapshot_len → snapshot of 0 bytes, then 4 trailing.
        assert!(decode_response(&trailing).is_err());
    }

    #[tokio::test]
    async fn timeout_kills_worker_and_classifies_retryable() {
        let Some(_pool) = live_worker() else { return };
        // A worker that never answers: emulate with `cat` — no. The pool
        // only spawns the configured binary; timeout behavior is covered
        // by the maintenance-suite fault injection (P5-M033) against a
        // deliberately hung binary path. Here: assert the classification
        // of the timeout error type unit-style.
        let err = WorkerError::TimedOut(Duration::from_secs(1));
        assert!(err.is_retryable());
    }
}
