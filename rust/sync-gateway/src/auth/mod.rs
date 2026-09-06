//! Server-side Clerk session-token verification (P3-M013).
//!
//! The authenticated principal is derived ONLY from the verified token:
//! signature (RS256 via JWKS), issuer, expiry, not-before. Client-supplied
//! user ids are never trusted (non-negotiables #12/#14). Tokens are never
//! logged (non-negotiable #24); failures carry class names, not token
//! material.
//!
//! JWKS is fetched over HTTPS from the issuer and cached; an unknown `kid`
//! triggers a bounded refresh (key-rotation support). Unit tests inject
//! keys via the [`JwksSource`] trait — no network in tests.

use jsonwebtoken::jwk::{AlgorithmParameters, JwkSet};
use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use thiserror::Error;

/// Verified Clerk principal. `clerk_user_id` is the verified token `sub`;
/// Concord's `users.id` is resolved later by the DB layer (M015).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub clerk_user_id: String,
}

#[derive(Debug, Error)]
pub enum AuthError {
    /// The token did not verify (signature/expiry/issuer/malformed/alg).
    #[error("invalid token: {reason}")]
    Invalid { reason: &'static str },
    /// JWKS could not be loaded/refreshed from the issuer.
    #[error("jwks unavailable")]
    JwksUnavailable,
    /// The verified token has no usable subject.
    #[error("token subject missing")]
    MissingSubject,
}

/// Minimal claim set Clerk session JWTs carry. `sub` is the Clerk user id.
#[derive(Debug, Deserialize)]
struct ClerkClaims {
    sub: String,
}

/// JWKS source: real HTTPS fetcher or test injector.
pub trait JwksSource: Send + Sync {
    fn load_jwks(&self) -> Result<JwkSet, AuthError>;
}

/// HTTPS JWKS source for a Clerk issuer (`{issuer}/.well-known/jwks.json`).
pub struct HttpJwks {
    url: String,
}

impl HttpJwks {
    pub fn new(issuer: &str) -> Self {
        Self {
            url: format!("{}/.well-known/jwks.json", issuer.trim_end_matches('/')),
        }
    }
}

impl JwksSource for HttpJwks {
    fn load_jwks(&self) -> Result<JwkSet, AuthError> {
        // The gateway is tokio-native; block_on from a fresh current-thread
        // runtime is safe here because load_jwks is only called from async
        // contexts on the worker threads (never from within another
        // runtime's reactor thread), and reqwest blocks only its own I/O.
        let url = self.url.clone();
        tokio::task::block_in_place(|| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| AuthError::JwksUnavailable)?;
            rt.block_on(async {
                let client = reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(10))
                    .build()
                    .map_err(|_| AuthError::JwksUnavailable)?;
                client
                    .get(&url)
                    .send()
                    .await
                    .map_err(|_| AuthError::JwksUnavailable)?
                    .json::<JwkSet>()
                    .await
                    .map_err(|_| AuthError::JwksUnavailable)
            })
        })
    }
}

/// Verifies Clerk session tokens against a cached, refreshable JWKS.
pub struct TokenVerifier<S: JwksSource> {
    issuer: String,
    source: S,
    keys: Mutex<HashMap<String, Arc<DecodingKey>>>,
    refresh_count: AtomicU64,
    /// Bound on refresh attempts per unknown `kid` (rotation support with
    /// resource containment).
    max_refreshes: u32,
}

const DEFAULT_MAX_REFRESHES: u32 = 3;

impl<S: JwksSource> TokenVerifier<S> {
    pub fn new(issuer: &str, source: S) -> Self {
        Self {
            issuer: issuer.trim_end_matches('/').to_owned(),
            source,
            keys: Mutex::new(HashMap::new()),
            refresh_count: AtomicU64::new(0),
            max_refreshes: DEFAULT_MAX_REFRESHES,
        }
    }

    /// Verifies a session token and returns the Clerk principal (`sub`).
    /// Malformed/missing/expired/forged/wrong-alg tokens all return
    /// structured errors — never a panic, never partial trust.
    pub async fn verify(&self, token: &str) -> Result<Principal, AuthError> {
        if token.is_empty() {
            return Err(AuthError::Invalid {
                reason: "empty token",
            });
        }
        if token.len() > crate::protocol::MAX_TOKEN_BYTES {
            return Err(AuthError::Invalid {
                reason: "token exceeds size cap",
            });
        }

        let header = decode_header(token).map_err(|_| AuthError::Invalid {
            reason: "malformed header",
        })?;
        // Reject alg-mismatch attacks (e.g. HS256 signed with the public
        // JWKS bytes) by pinning RS256.
        if header.alg != jsonwebtoken::Algorithm::RS256 {
            return Err(AuthError::Invalid {
                reason: "unexpected algorithm",
            });
        }
        let kid = header.kid.ok_or(AuthError::Invalid {
            reason: "missing key id",
        })?;

        let mut validation = Validation::new(jsonwebtoken::Algorithm::RS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_required_spec_claims(&["exp", "sub", "iss"]);
        validation.validate_exp = true;
        validation.validate_nbf = true;
        validation.leeway = 5;

        // Verification is CPU-bound and short; block_in_place keeps the
        // async signature without spanning awaits across the mutex guard.
        let key = tokio::task::block_in_place(|| self.key_for(&kid)).ok_or(AuthError::Invalid {
            reason: "unknown key id",
        })?;
        let data = tokio::task::block_in_place(|| {
            decode::<ClerkClaims>(token, &key, &validation).map_err(classify)
        })?;

        let sub = data.claims.sub;
        if sub.is_empty() {
            return Err(AuthError::MissingSubject);
        }
        Ok(Principal { clerk_user_id: sub })
    }

    fn key_for(&self, kid: &str) -> Option<Arc<DecodingKey>> {
        if let Ok(keys) = self.keys.lock() {
            if let Some(k) = keys.get(kid) {
                return Some(Arc::clone(k));
            }
        }
        // Unknown kid: bounded refresh (key rotation).
        if self.refresh_count.load(Ordering::Relaxed) >= self.max_refreshes as u64 {
            return None;
        }
        self.refresh_count.fetch_add(1, Ordering::Relaxed);
        let set = self.source.load_jwks().ok()?;
        let mut keys = self.keys.lock().ok()?;
        keys.clear();
        for jwk in set.keys {
            if let Some(id) = jwk.common.key_id.clone() {
                if let Ok(key) = decoding_key(&jwk) {
                    keys.insert(id, Arc::new(key));
                }
            }
        }
        keys.get(kid).map(Arc::clone)
    }
}

fn decoding_key(jwk: &jsonwebtoken::jwk::Jwk) -> Result<DecodingKey, AuthError> {
    match &jwk.algorithm {
        AlgorithmParameters::RSA(params) => DecodingKey::from_rsa_components(&params.n, &params.e)
            .map_err(|_| AuthError::JwksUnavailable),
        _ => Err(AuthError::JwksUnavailable),
    }
}

/// Map jsonwebtoken errors to a safe class name (never token material).
fn classify(e: jsonwebtoken::errors::Error) -> AuthError {
    use jsonwebtoken::errors::ErrorKind;
    match e.kind() {
        ErrorKind::ExpiredSignature => AuthError::Invalid { reason: "expired" },
        ErrorKind::InvalidIssuer => AuthError::Invalid {
            reason: "issuer mismatch",
        },
        ErrorKind::InvalidSignature => AuthError::Invalid {
            reason: "signature",
        },
        ErrorKind::InvalidToken | ErrorKind::Base64(_) => AuthError::Invalid {
            reason: "malformed",
        },
        ErrorKind::MissingRequiredClaim(claim) => AuthError::Invalid {
            reason: match claim.as_str() {
                "exp" => "missing expiry",
                "sub" => "missing subject",
                _ => "missing claim",
            },
        },
        _ => AuthError::Invalid { reason: "claims" },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::jwk::{CommonParameters, Jwk, KeyAlgorithm, RSAKeyParameters};
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde::Serialize;

    struct StaticJwks(JwkSet);

    impl JwksSource for StaticJwks {
        fn load_jwks(&self) -> Result<JwkSet, AuthError> {
            Ok(JwkSet {
                keys: self.0.keys.clone(),
            })
        }
    }

    struct FailingJwks;
    impl JwksSource for FailingJwks {
        fn load_jwks(&self) -> Result<JwkSet, AuthError> {
            Err(AuthError::JwksUnavailable)
        }
    }

    #[derive(Serialize)]
    struct Claims {
        sub: String,
        exp: u64,
        iss: String,
    }

    /// Generate an RSA keypair via the `rsa` crate is heavy; instead use a
    /// fixed 2048-bit test key encoded as DER PKCS8, used only in tests.
    /// Load a test signing key from its PKCS#8 DER file as a jsonwebtoken
    /// EncodingKey (PKCS8 PEM form is what jsonwebtoken expects for RSA).
    fn test_encoding_key_from(der: &[u8]) -> EncodingKey {
        use rsa::pkcs8::EncodePrivateKey;
        let key: rsa::RsaPrivateKey =
            rsa::pkcs8::DecodePrivateKey::from_pkcs8_der(der).expect("test key parses");
        let pem = key
            .to_pkcs8_pem(rsa::pkcs8::LineEnding::LF)
            .expect("pem encode");
        EncodingKey::from_rsa_pem(pem.as_str().as_bytes()).expect("test key is valid")
    }

    fn test_encoding_key() -> EncodingKey {
        test_encoding_key_from(include_bytes!("test_rsa_key.der"))
    }

    fn jwks_with_kid(kid: &str, der: &[u8]) -> JwkSet {
        let key: rsa::RsaPrivateKey =
            rsa::pkcs8::DecodePrivateKey::from_pkcs8_der(der).expect("test key parses");
        let public = key.to_public_key();
        // JWK needs base64url-encoded modulus/exponent without padding.
        fn b64u(bytes: &[u8]) -> String {
            const CHARS: &[u8] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut s = String::new();
            for chunk in bytes.chunks(3) {
                let b = [
                    chunk[0],
                    chunk.get(1).copied().unwrap_or(0),
                    chunk.get(2).copied().unwrap_or(0),
                ];
                s.push(CHARS[(b[0] >> 2) as usize] as char);
                s.push(CHARS[(((b[0] & 0x03) << 4) | (b[1] >> 4)) as usize] as char);
                if chunk.len() > 1 {
                    s.push(CHARS[((b[1] & 0x0f) << 2 | (b[2] >> 6)) as usize] as char);
                } else {
                    s.push('=');
                }
                if chunk.len() > 2 {
                    s.push(CHARS[(b[2] & 0x3f) as usize] as char);
                } else {
                    s.push('=');
                }
            }
            s.trim_end_matches('=').to_owned()
        }
        use rsa::traits::PublicKeyParts;
        let n = public.n().to_bytes_be();
        let e = public.e().to_bytes_be();
        let jwk = Jwk {
            common: CommonParameters {
                key_id: Some(kid.to_owned()),
                key_algorithm: Some(KeyAlgorithm::RS256),
                ..Default::default()
            },
            algorithm: AlgorithmParameters::RSA(RSAKeyParameters {
                key_type: jsonwebtoken::jwk::RSAKeyType::RSA,
                n: b64u(&n),
                e: b64u(&e),
            }),
        };
        JwkSet { keys: vec![jwk] }
    }

    fn verifier(kid: &str, der: &[u8]) -> TokenVerifier<StaticJwks> {
        TokenVerifier::new(
            "https://test.clerk.accounts.dev",
            StaticJwks(jwks_with_kid(kid, der)),
        )
    }

    fn sign(claims: &Claims, key: &EncodingKey, kid: &str) -> String {
        let mut header = Header::new(jsonwebtoken::Algorithm::RS256);
        header.kid = Some(kid.to_owned());
        encode(&header, claims, key).expect("sign test token")
    }

    fn claims_now(sub: &str, issuer: &str) -> Claims {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_secs();
        Claims {
            sub: sub.to_owned(),
            exp: now + 600,
            iss: issuer.to_owned(),
        }
    }

    const KID: &str = "test-key-1";
    const ISSUER: &str = "https://test.clerk.accounts.dev";

    #[test]
    fn valid_token_verifies_and_extracts_sub() {
        let key = test_encoding_key();
        let token = sign(&claims_now("user_test123", ISSUER), &key, KID);
        let rt = tokio::runtime::Runtime::new().expect("test runtime");
        let principal = rt
            .block_on(verifier(KID, include_bytes!("test_rsa_key.der")).verify(&token))
            .expect("valid token verifies");
        assert_eq!(principal.clerk_user_id, "user_test123");
    }

    #[test]
    fn forged_signature_rejected() {
        // Sign with a DIFFERENT key than the JWKS carries.
        let other = include_bytes!("test_rsa_key2.der");
        let other_key = test_encoding_key_from(other);
        let token = sign(&claims_now("user_attacker", ISSUER), &other_key, KID);
        let rt = tokio::runtime::Runtime::new().expect("test runtime");
        let err = rt
            .block_on(verifier(KID, include_bytes!("test_rsa_key.der")).verify(&token))
            .expect_err("forged token must fail");
        assert!(matches!(
            err,
            AuthError::Invalid {
                reason: "signature"
            }
        ));
    }

    #[test]
    fn expired_token_rejected() {
        let key = test_encoding_key();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_secs();
        let expired = Claims {
            sub: "user_old".into(),
            exp: now - 3600,
            iss: ISSUER.into(),
        };
        let token = sign(&expired, &key, KID);
        let rt = tokio::runtime::Runtime::new().expect("test runtime");
        let err = rt
            .block_on(verifier(KID, include_bytes!("test_rsa_key.der")).verify(&token))
            .expect_err("expired token must fail");
        assert!(matches!(err, AuthError::Invalid { reason: "expired" }));
    }

    #[test]
    fn wrong_issuer_rejected() {
        let key = test_encoding_key();
        let token = sign(
            &claims_now("user_test123", "https://evil.example.com"),
            &key,
            KID,
        );
        let rt = tokio::runtime::Runtime::new().expect("test runtime");
        let err = rt
            .block_on(verifier(KID, include_bytes!("test_rsa_key.der")).verify(&token))
            .expect_err("wrong issuer must fail");
        assert!(matches!(
            err,
            AuthError::Invalid {
                reason: "issuer mismatch"
            }
        ));
    }

    #[test]
    fn malformed_and_empty_rejected() {
        let rt = tokio::runtime::Runtime::new().expect("test runtime");
        let v = verifier(KID, include_bytes!("test_rsa_key.der"));
        assert!(matches!(
            rt.block_on(v.verify("")),
            Err(AuthError::Invalid {
                reason: "empty token"
            })
        ));
        assert!(matches!(
            rt.block_on(v.verify("garbage")),
            Err(AuthError::Invalid {
                reason: "malformed header"
            })
        ));
        let oversized = "x".repeat(crate::protocol::MAX_TOKEN_BYTES + 1);
        assert!(matches!(
            rt.block_on(v.verify(&oversized)),
            Err(AuthError::Invalid {
                reason: "token exceeds size cap"
            })
        ));
    }

    #[test]
    fn unknown_kid_with_failing_jwks_rejected() {
        let key = test_encoding_key();
        let token = sign(&claims_now("user_test123", ISSUER), &key, "nonexistent-kid");
        let rt = tokio::runtime::Runtime::new().expect("test runtime");
        let v = TokenVerifier::new(ISSUER, FailingJwks);
        let err = rt
            .block_on(v.verify(&token))
            .expect_err("unknown kid must fail");
        assert!(matches!(
            err,
            AuthError::Invalid {
                reason: "unknown key id"
            }
        ));
    }

    #[test]
    fn jwks_refresh_resolves_rotated_kid() {
        // Real rotation shape: the cache first holds key-1 (populated by
        // earlier verifications); the JWKS source then rotates to key-2.
        // A token signed by key-2 with the new kid must trigger a refresh
        // and verify — proving rotation support.
        const KEY1: &[u8] = include_bytes!("test_rsa_key.der");
        const KEY2: &[u8] = include_bytes!("test_rsa_key2.der");
        let key1 = test_encoding_key_from(KEY1);
        let key2 = test_encoding_key_from(KEY2);

        let state = std::sync::Arc::new(Mutex::new(0u8));
        struct RotatingJwks {
            state: Arc<Mutex<u8>>,
        }
        impl JwksSource for RotatingJwks {
            fn load_jwks(&self) -> Result<JwkSet, AuthError> {
                let mut state = self.state.lock().expect("lock");
                *state += 1;
                // Before rotation: key-1 only. After rotation: key-2 only.
                let jwk = if *state >= 2 {
                    jwks_with_kid("rotated-kid", KEY2)
                } else {
                    jwks_with_kid("test-key-1", KEY1)
                };
                Ok(jwk)
            }
        }

        let v = TokenVerifier::new(
            ISSUER,
            RotatingJwks {
                state: state.clone(),
            },
        );
        let rt = tokio::runtime::Runtime::new().expect("test runtime");

        // Phase 1: token under key-1 verifies and populates the cache.
        let old_token = sign(
            &claims_now("user_before_rotation", ISSUER),
            &key1,
            "test-key-1",
        );
        let principal = rt
            .block_on(v.verify(&old_token))
            .expect("pre-rotation token verifies");
        assert_eq!(principal.clerk_user_id, "user_before_rotation");
        assert_eq!(*state.lock().expect("lock"), 1, "one JWKS load so far");

        // Phase 2: rotated key serves a new kid; refresh must pick it up.
        let token = sign(&claims_now("user_rotated", ISSUER), &key2, "rotated-kid");
        let principal = rt
            .block_on(v.verify(&token))
            .expect("refresh must resolve rotated key");
        assert_eq!(principal.clerk_user_id, "user_rotated");
        assert!(
            *state.lock().expect("lock") >= 2,
            "rotation required a JWKS refresh"
        );
    }
}
