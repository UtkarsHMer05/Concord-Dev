//! Client-verifiable history proofs (Feature 5).
//!
//! A Merkle tree over the retained durable op log — leaf i commits to
//! `(server_seq, operation_id, payload_checksum)` — plus an Ed25519-signed
//! receipt binding `(document, seq, root, state_digest, op_count)` to a
//! gateway signing key. A client that independently folds its own replica to
//! the same canonical digest, verifies the audit path, and verifies the
//! signature has end-to-end evidence that the gateway durably committed
//! exactly this content at exactly this sequence.
//!
//! Trust model (documented honestly):
//! - The signature is over deterministic bytes (not JSON), so any client
//!   language can re-implement verification.
//! - The response carries the verifying public key; comparing it against a
//!   key obtained OUT OF BAND (or pinning `key_id`) is what makes the proof
//!   third-party verifiable. Verifying against the key in the same response
//!   still detects gateway-internal tampering/replay, not a full MITM.
//! - `GATEWAY_SIGNING_KEY` (hex or base64, 32-byte Ed25519 seed) pins the
//!   key across restarts and multi-gateway deployments. Without it, an
//!   EPHEMERAL key is generated per process (dev convenience; receipts do
//!   not survive restarts — surfaced via the key id and a startup warning).
//! - Pruned documents: the proof covers the RETAINED log only; `base_seq`
//!   names the first retained server seq so clients cannot mistake a pruned
//!   prefix for a complete one.
//!
//! Tree rules (mirrored in `src/lib/crdt/proofs.ts`, byte-for-byte):
//! - leaf  = SHA-256(0x00 || seq(u64 BE) || operation_id || checksum_hex)
//! - node  = SHA-256(0x01 || left || right)
//! - odd level count: the LAST node is duplicated (Bitcoin-style) and its
//!   audit path contains that duplicate as its own sibling.
//! - empty log: root = 32 zero bytes (no leaves, no proof).

use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// Domain separators keep leaf and node hashes non-interchangeable.
const LEAF_PREFIX: u8 = 0x00;
const NODE_PREFIX: u8 = 0x01;
/// Receipt message version (bumped on any wire change to the canonical bytes).
const RECEIPT_VERSION: u8 = 1;

pub const ROOT_OF_EMPTY: [u8; 32] = [0u8; 32];

/// SHA-256 of one op-log row's identity + payload. The operation id is
/// length-prefixed (u16 BE) so `(id, checksum)` concatenation is unambiguous
/// even for adversarial inputs (real ids are `r:c` and checksums 64 hex, but
/// the hash must not depend on that invariant).
pub fn leaf_hash(seq: u64, operation_id: &str, checksum_hex: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([LEAF_PREFIX]);
    hasher.update(seq.to_be_bytes());
    hasher.update((operation_id.len() as u16).to_be_bytes());
    hasher.update(operation_id.as_bytes());
    hasher.update(checksum_hex.as_bytes());
    hasher.finalize().into()
}

fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([NODE_PREFIX]);
    hasher.update(left);
    hasher.update(right);
    hasher.finalize().into()
}

/// Root over the given leaves (duplicate-last for odd levels).
pub fn merkle_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    if leaves.is_empty() {
        return ROOT_OF_EMPTY;
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            let right = level.get(i + 1).unwrap_or(&level[i]);
            next.push(node_hash(&level[i], right));
            i += 2;
        }
        level = next;
    }
    level[0]
}

/// Audit path for leaf `index`: sibling hash per level, bottom-up. For an
/// odd final node the path contains the node itself (duplicate rule).
pub fn merkle_proof(leaves: &[[u8; 32]], index: usize) -> Option<Vec<[u8; 32]>> {
    if index >= leaves.len() {
        return None;
    }
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    let mut idx = index;
    let mut path = Vec::new();
    while level.len() > 1 {
        let sibling_idx = if idx.is_multiple_of(2) {
            idx + 1
        } else {
            idx - 1
        };
        // Odd final node: its sibling is itself (duplicated upward).
        path.push(*level.get(sibling_idx).unwrap_or(&level[idx]));
        let mut next = Vec::with_capacity(level.len().div_ceil(2));
        let mut i = 0;
        while i < level.len() {
            let right = level.get(i + 1).unwrap_or(&level[i]);
            next.push(node_hash(&level[i], right));
            i += 2;
        }
        level = next;
        idx /= 2;
    }
    Some(path)
}

/// Replays an audit path from a leaf to the root (client mirror exists).
pub fn replay_path(mut current: [u8; 32], index: usize, proof: &[[u8; 32]]) -> Option<[u8; 32]> {
    let mut idx = index;
    for sibling in proof {
        current = if idx.is_multiple_of(2) {
            node_hash(&current, sibling)
        } else {
            node_hash(sibling, &current)
        };
        idx /= 2;
    }
    Some(current)
}

/// Deterministic receipt message: `version(1) || document(16) || seq(8 BE)
/// || root(32) || stateDigest(len-prefixed u16 BE) || opCount(8 BE)
/// || issuedAtMs(8 BE) || keyId(len-prefixed u8)`. NOT JSON — length-prefix
/// framing keeps it unambiguous without a canonicalization spec.
pub fn receipt_message(
    document: Uuid,
    seq: u64,
    root: &[u8; 32],
    state_digest: &str,
    op_count: u64,
    issued_at_ms: u64,
    key_id: &str,
) -> Vec<u8> {
    let mut out =
        Vec::with_capacity(1 + 16 + 8 + 32 + 2 + state_digest.len() + 8 + 8 + 1 + key_id.len());
    out.push(RECEIPT_VERSION);
    out.extend_from_slice(document.as_bytes());
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(root);
    out.extend_from_slice(&(state_digest.len() as u16).to_be_bytes());
    out.extend_from_slice(state_digest.as_bytes());
    out.extend_from_slice(&op_count.to_be_bytes());
    out.extend_from_slice(&issued_at_ms.to_be_bytes());
    out.push(key_id.len() as u8);
    out.extend_from_slice(key_id.as_bytes());
    out
}

/// Gateway signing identity (Feature 5). Process-global via
/// [`ProofSigner::shared`] — the same once-init pattern as `Metrics::global`
/// — so neither `Config` nor `AppState` grows a field for it.
pub struct ProofSigner {
    signing: SigningKey,
    verifying: VerifyingKey,
    key_id: String,
    ephemeral: bool,
}

impl ProofSigner {
    /// From a 32-byte seed (env `GATEWAY_SIGNING_KEY`, hex or base64).
    pub fn from_seed(seed: [u8; 32]) -> Self {
        let signing = SigningKey::from_bytes(&seed);
        Self::build(signing, false)
    }

    /// Fresh per-process key (dev fallback; startup logs a warning).
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        Self::build(SigningKey::from_bytes(&seed), true)
    }

    fn build(signing: SigningKey, ephemeral: bool) -> Self {
        let verifying = signing.verifying_key();
        let key_id = hex::encode(&Sha256::digest(verifying.as_bytes())[..8]);
        Self {
            signing,
            verifying,
            key_id,
            ephemeral,
        }
    }

    /// The process-global signer: env-pinned when `GATEWAY_SIGNING_KEY` is
    /// set, otherwise one ephemeral key with a one-time warning.
    pub fn shared() -> &'static ArcProofSigner {
        static SHARED: std::sync::OnceLock<ArcProofSigner> = std::sync::OnceLock::new();
        SHARED.get_or_init(|| {
            let signer = match crate::config::parse_signing_seed(
                &std::env::var("GATEWAY_SIGNING_KEY").unwrap_or_default(),
            ) {
                Some(seed) => Self::from_seed(seed),
                None => {
                    tracing::warn!(
                        "GATEWAY_SIGNING_KEY unset: history-proof receipts use an EPHEMERAL \
                         Ed25519 key (receipts are unverifiable across restarts). Set a 32-byte \
                         hex/base64 seed in production."
                    );
                    Self::generate()
                }
            };
            std::sync::Arc::new(signer)
        })
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub fn public_key_bytes(&self) -> [u8; 32] {
        *self.verifying.as_bytes()
    }

    pub fn is_ephemeral(&self) -> bool {
        self.ephemeral
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        self.signing.sign(message).to_bytes()
    }

    /// Independent verification path (used by tests and self-checks).
    pub fn verify(&self, message: &[u8], signature: &[u8; 64]) -> bool {
        // ed25519-dalek v2: Signature::from_bytes is infallible over &[u8;64]
        // (the wire type already bounds the length); verification itself
        // rejects non-canonical/malleable encodings.
        self.verifying
            .verify(message, &Signature::from_bytes(signature))
            .is_ok()
    }
}

pub type ArcProofSigner = std::sync::Arc<ProofSigner>;

#[cfg(test)]
mod tests {
    use super::*;

    fn leaves(n: usize) -> Vec<[u8; 32]> {
        (0..n)
            .map(|i| leaf_hash(i as u64 + 1, &format!("10:{i}"), &format!("{i:064x}")))
            .collect()
    }

    #[test]
    fn leaf_hash_is_domain_separated_and_length_safe() {
        // The length prefix makes (id, checksum) framing unambiguous.
        let a = leaf_hash(1, "10:0", "aa");
        let b = leaf_hash(1, "10:0a", "a");
        assert_ne!(a, b);
        assert_ne!(a, node_hash(&a, &a));
    }

    #[test]
    fn empty_root_is_defined_and_single_leaf_wraps() {
        assert_eq!(merkle_root(&[]), ROOT_OF_EMPTY);
        let one = leaves(1);
        assert_eq!(merkle_root(&one), one[0]);
    }

    #[test]
    fn proofs_verify_for_every_index_and_several_sizes() {
        for size in [1usize, 2, 3, 5, 8, 9, 16] {
            let leaves = leaves(size);
            let root = merkle_root(&leaves);
            for index in 0..size {
                let proof = merkle_proof(&leaves, index).expect("proof for valid index");
                assert_eq!(
                    replay_path(leaves[index], index, &proof),
                    Some(root),
                    "size {size} index {index}"
                );
            }
            assert!(merkle_proof(&leaves, size).is_none(), "out of range");
        }
    }

    #[test]
    fn tampered_leaf_or_path_fails_replay() {
        let leaves = leaves(4);
        let root = merkle_root(&leaves);
        let proof = merkle_proof(&leaves, 2).expect("proof");
        let mut forged = leaves[2];
        forged[0] ^= 0xFF;
        assert_ne!(replay_path(forged, 2, &proof), Some(root));
        let mut bad_proof = proof.clone();
        bad_proof[0] = [0u8; 32];
        assert_ne!(replay_path(leaves[2], 2, &bad_proof), Some(root));
    }

    #[test]
    fn receipt_signing_and_verification_round_trip() {
        let signer = ProofSigner::from_seed([7u8; 32]);
        let document = Uuid::new_v4();
        let root = merkle_root(&leaves(3));
        let msg = receipt_message(
            document,
            3,
            &root,
            "sha256:abc",
            3,
            1_234_567,
            signer.key_id(),
        );
        let sig = signer.sign(&msg);
        assert!(signer.verify(&msg, &sig));
        assert!(!signer.verify(b"tampered", &sig));
        let mut bad = sig;
        bad[0] ^= 1;
        assert!(!signer.verify(&msg, &bad));

        // A different seed (different key) must NOT verify the same receipt.
        let other = ProofSigner::from_seed([8u8; 32]);
        assert!(!other.verify(&msg, &sig));
        assert_ne!(signer.key_id(), other.key_id());
    }

    #[test]
    fn receipt_message_is_deterministic_and_field_sensitive() {
        let root = merkle_root(&leaves(2));
        let a = receipt_message(Uuid::nil(), 2, &root, "sha256:x", 2, 5, "key01");
        let b = receipt_message(Uuid::nil(), 2, &root, "sha256:x", 2, 5, "key01");
        assert_eq!(a, b);
        // Any field change (including digest length framing) changes bytes.
        assert_ne!(
            a,
            receipt_message(Uuid::nil(), 3, &root, "sha256:x", 2, 5, "key01")
        );
        assert_ne!(
            a,
            receipt_message(Uuid::nil(), 2, &root, "sha256:y", 2, 5, "key01")
        );
        assert_ne!(
            a,
            receipt_message(Uuid::nil(), 2, &root, "sha256:x", 3, 5, "key01")
        );
        assert_ne!(
            a,
            receipt_message(Uuid::nil(), 2, &root, "sha256:x", 2, 6, "key01")
        );
        assert_ne!(
            a,
            receipt_message(Uuid::nil(), 2, &root, "sha256:x", 2, 5, "key02")
        );
    }
}
