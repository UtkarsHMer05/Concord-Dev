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

use futures_util::StreamExt;
use jsonwebtoken::jwk::{AlgorithmParameters, JwkSet};
use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::Mutex as AsyncMutex;

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
    azp: Option<String>,
}

/// JWKS source: real HTTPS fetcher or test injector. Async-native (a
/// boxed future — no block_in_place anywhere).
pub trait JwksSource: Send + Sync {
    fn load_jwks(&self) -> futures_util::future::BoxFuture<'static, Result<JwkSet, AuthError>>;
}

/// Static JWKS source for tests and tooling (no network).
pub struct StaticJwks(pub JwkSet);

impl JwksSource for StaticJwks {
    fn load_jwks(&self) -> futures_util::future::BoxFuture<'static, Result<JwkSet, AuthError>> {
        let set = JwkSet {
            keys: self.0.keys.clone(),
        };
        Box::pin(async move { Ok(set) })
    }
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
    fn load_jwks(&self) -> futures_util::future::BoxFuture<'static, Result<JwkSet, AuthError>> {
        let url = self.url.clone();
        Box::pin(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| AuthError::JwksUnavailable)?;
            let response = client
                .get(&url)
                .send()
                .await
                .map_err(|_| AuthError::JwksUnavailable)?
                .error_for_status()
                .map_err(|_| AuthError::JwksUnavailable)?;
            if response
                .content_length()
                .is_some_and(|n| n > MAX_JWKS_BYTES as u64)
            {
                return Err(AuthError::JwksUnavailable);
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| AuthError::JwksUnavailable)?;
                if chunk.len() > MAX_JWKS_BYTES.saturating_sub(bytes.len()) {
                    return Err(AuthError::JwksUnavailable);
                }
                bytes.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&bytes).map_err(|_| AuthError::JwksUnavailable)
        })
    }
}

const MAX_JWKS_BYTES: usize = 128 * 1024;

/// File-backed JWKS source (GATEWAY_JWKS_FILE): local dev/E2E path — reads
/// a standard JWKS document from disk. Never enabled implicitly; the
/// config layer requires the env var. Production uses HTTPS.
pub struct FileJwks {
    path: std::path::PathBuf,
}

impl FileJwks {
    pub fn new(path: impl Into<std::path::PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl JwksSource for FileJwks {
    fn load_jwks(&self) -> futures_util::future::BoxFuture<'static, Result<JwkSet, AuthError>> {
        let path = self.path.clone();
        Box::pin(async move {
            let bytes = tokio::fs::read(&path)
                .await
                .map_err(|_| AuthError::JwksUnavailable)?;
            serde_json::from_slice(&bytes).map_err(|_| AuthError::JwksUnavailable)
        })
    }
}

/// Verifier source used by the gateway: HTTPS in production, a static
/// file or injected keys in dev/test (explicit config only).
pub enum VerifierSource {
    Http(HttpJwks),
    Static(StaticJwks),
    File(FileJwks),
}

impl JwksSource for VerifierSource {
    fn load_jwks(&self) -> futures_util::future::BoxFuture<'static, Result<JwkSet, AuthError>> {
        match self {
            VerifierSource::Http(s) => s.load_jwks(),
            VerifierSource::Static(s) => s.load_jwks(),
            VerifierSource::File(s) => s.load_jwks(),
        }
    }
}

/// Verifies Clerk session tokens against a cached, refreshable JWKS.
/// Generic over the JWKS source (HTTPS in production; injected keys in
/// tests).
pub struct TokenVerifier<S: JwksSource = HttpJwks> {
    issuer: String,
    audience: Option<String>,
    authorized_party: Option<String>,
    source: S,
    cache: Mutex<KeyCache>,
    refresh_gate: AsyncMutex<()>,
    refresh_cooldown: Duration,
}

#[derive(Default)]
struct KeyCache {
    keys: HashMap<String, Arc<DecodingKey>>,
    negative: HashMap<String, Instant>,
    loaded_at: Option<Instant>,
    last_attempt: Option<Instant>,
}

const KEY_TTL: Duration = Duration::from_secs(60 * 60);
const NEGATIVE_TTL: Duration = Duration::from_secs(60);
const DEFAULT_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);
const MAX_NEGATIVE_KIDS: usize = 256;

impl<S: JwksSource> TokenVerifier<S> {
    pub fn new(issuer: &str, source: S) -> Self {
        Self {
            issuer: issuer.trim_end_matches('/').to_owned(),
            audience: None,
            authorized_party: None,
            source,
            cache: Mutex::new(KeyCache::default()),
            refresh_gate: AsyncMutex::new(()),
            refresh_cooldown: DEFAULT_REFRESH_COOLDOWN,
        }
    }

    /// Configure an exact audience and/or authorized party. The default
    /// remains compatible with existing local session-token fixtures; cloud
    /// must explicitly set both values after its Clerk claim migration.
    pub fn with_claims_policy(
        mut self,
        audience: Option<&str>,
        authorized_party: Option<&str>,
    ) -> Self {
        self.audience = audience.map(str::to_owned);
        self.authorized_party = authorized_party.map(str::to_owned);
        self
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
        if let Some(audience) = &self.audience {
            validation.set_audience(&[audience]);
            validation.set_required_spec_claims(&["exp", "sub", "iss", "aud"]);
        } else {
            validation.set_required_spec_claims(&["exp", "sub", "iss"]);
            // Compatibility for development tokens without Concord's aud.
            validation.validate_aud = false;
        }
        validation.validate_exp = true;
        validation.validate_nbf = true;
        validation.leeway = 5;

        let key = self.key_for(&kid).await.ok_or_else(|| {
            crate::observability::metrics::incr("concord_jwks_unknown_kid_total");
            AuthError::Invalid {
                reason: "unknown key id",
            }
        })?;
        let data = decode::<ClerkClaims>(token, &key, &validation).map_err(classify)?;

        if let Some(expected) = &self.authorized_party {
            if data.claims.azp.as_deref() != Some(expected.as_str()) {
                return Err(AuthError::Invalid {
                    reason: "authorized party mismatch",
                });
            }
        }

        let sub = data.claims.sub;
        if sub.is_empty() {
            return Err(AuthError::MissingSubject);
        }
        Ok(Principal { clerk_user_id: sub })
    }

    async fn key_for(&self, kid: &str) -> Option<Arc<DecodingKey>> {
        if let Some(cached) = self.cached_key(kid) {
            return Some(cached);
        }
        // One caller fetches at a time. Waiters recheck the populated cache;
        // a burst cannot launch parallel issuer requests.
        let _gate = self.refresh_gate.lock().await;
        if let Some(cached) = self.cached_key(kid) {
            return Some(cached);
        }
        let now = Instant::now();
        {
            let mut cache = self.cache.lock().ok()?;
            if cache.negative.get(kid).is_some_and(|until| *until > now) {
                return None;
            }
            if cache
                .last_attempt
                .is_some_and(|last| now.duration_since(last) < self.refresh_cooldown)
            {
                crate::observability::metrics::incr("concord_jwks_refresh_throttled_total");
                return None;
            }
            cache.last_attempt = Some(now);
        }
        crate::observability::metrics::incr("concord_jwks_refresh_attempts_total");
        let set = match self.source.load_jwks().await {
            Ok(set) => set,
            Err(_) => {
                crate::observability::metrics::incr("concord_jwks_refresh_failures_total");
                return None;
            }
        };
        let mut fresh = HashMap::new();
        for jwk in set.keys {
            if let Some(id) = jwk.common.key_id.clone() {
                if let Ok(key) = decoding_key(&jwk) {
                    fresh.insert(id, Arc::new(key));
                }
            }
        }
        if fresh.is_empty() {
            crate::observability::metrics::incr("concord_jwks_refresh_failures_total");
            return None;
        }
        crate::observability::metrics::incr("concord_jwks_refresh_success_total");
        let mut cache = self.cache.lock().ok()?;
        cache.keys = fresh;
        cache.loaded_at = Some(Instant::now());
        cache.negative.clear();
        if !cache.keys.contains_key(kid) {
            if cache.negative.len() >= MAX_NEGATIVE_KIDS {
                cache.negative.clear();
            }
            cache
                .negative
                .insert(kid.to_owned(), Instant::now() + NEGATIVE_TTL);
        }
        cache.keys.get(kid).map(Arc::clone)
    }

    fn cached_key(&self, kid: &str) -> Option<Arc<DecodingKey>> {
        let cache = self.cache.lock().ok()?;
        if cache
            .loaded_at
            .is_some_and(|loaded| loaded.elapsed() < KEY_TTL)
        {
            if let Some(key) = cache.keys.get(kid) {
                return Some(Arc::clone(key));
            }
        }
        None
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

    struct FailingJwks;
    impl JwksSource for FailingJwks {
        fn load_jwks(&self) -> futures_util::future::BoxFuture<'static, Result<JwkSet, AuthError>> {
            Box::pin(async { Err(AuthError::JwksUnavailable) })
        }
    }

    #[derive(Serialize)]
    struct Claims {
        sub: String,
        exp: u64,
        iss: String,
    }

    /// Claims mirroring a REAL Clerk template token: includes `aud`
    /// (this project's Clerk default template still carries aud="convex"
    /// from the pre-Concord tutorial era) and `azp`. Regression for the
    /// staging incident where jsonwebtoken's default validate_aud=true
    /// rejected every real Clerk token while aud-less test tokens passed.
    #[derive(Serialize)]
    struct ClaimsWithAud {
        sub: String,
        exp: u64,
        iss: String,
        aud: String,
        azp: String,
    }

    /// Parse the fixed test fixture as PKCS#8 and pass its inner PKCS#1
    /// bytes to jsonwebtoken. Signing uses the same AWS-LC backend as the
    /// gateway; no separate RSA implementation is needed for test keys.
    fn test_encoding_key_from(der: &[u8]) -> EncodingKey {
        let key = pkcs8::PrivateKeyInfo::try_from(der).expect("PKCS8 test key");
        EncodingKey::from_rsa_der(key.private_key)
    }

    fn test_encoding_key() -> EncodingKey {
        test_encoding_key_from(include_bytes!("test_rsa_key.der"))
    }

    fn jwks_with_kid(kid: &str, der: &[u8]) -> JwkSet {
        let key = pkcs8::PrivateKeyInfo::try_from(der).expect("PKCS8 test key");
        let public = pkcs1::RsaPrivateKey::try_from(key.private_key).expect("RSA test key");
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
        let n = public.modulus.as_bytes();
        let e = public.public_exponent.as_bytes();
        let jwk = Jwk {
            common: CommonParameters {
                key_id: Some(kid.to_owned()),
                key_algorithm: Some(KeyAlgorithm::RS256),
                ..Default::default()
            },
            algorithm: AlgorithmParameters::RSA(RSAKeyParameters {
                key_type: jsonwebtoken::jwk::RSAKeyType::RSA,
                n: b64u(n),
                e: b64u(e),
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

    fn sign<T: serde::Serialize>(claims: &T, key: &EncodingKey, kid: &str) -> String {
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
    fn probe_decode_header_accepts_signed_token() {
        let key = test_encoding_key();
        let token = sign(&claims_now("user_x", ISSUER), &key, KID);
        assert!(
            jsonwebtoken::decode_header(&token).is_ok(),
            "decode_header must parse"
        );
    }

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

    /// P7 staging regression: real Clerk tokens carry an `aud` claim the
    /// gateway does not authorize on — verification must NOT fail on it.
    #[test]
    fn token_with_aud_claim_verifies() {
        let key = test_encoding_key();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_secs();
        let claims = ClaimsWithAud {
            sub: "user_clerk_real".to_owned(),
            exp: now + 600,
            iss: ISSUER.to_owned(),
            aud: "convex".to_owned(),
            azp: "http://concord-staging.example.internal".to_owned(),
        };
        let token = sign(&claims, &key, KID);
        let rt = tokio::runtime::Runtime::new().expect("test runtime");
        let principal = rt
            .block_on(verifier(KID, include_bytes!("test_rsa_key.der")).verify(&token))
            .expect("token with aud claim verifies (aud is not an authz boundary)");
        assert_eq!(principal.clerk_user_id, "user_clerk_real");
    }

    #[test]
    fn strict_claims_reject_cross_service_and_cross_origin_tokens() {
        let rt = tokio::runtime::Runtime::new().expect("test runtime");
        let key = test_encoding_key();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_secs();
        let verifier = verifier(KID, include_bytes!("test_rsa_key.der"))
            .with_claims_policy(Some("concord-sync"), Some("https://concord.example"));
        let base = serde_json::json!({
            "iss": ISSUER, "sub": "user_1", "exp": now + 600,
            "aud": "concord-sync", "azp": "https://concord.example"
        });
        let check = |claims: &serde_json::Value| {
            let token = sign(claims, &key, KID);
            rt.block_on(verifier.verify(&token))
        };
        assert!(check(&base).is_ok());
        let mut array = base.clone();
        array["aud"] = serde_json::json!(["other", "concord-sync"]);
        assert!(check(&array).is_ok());
        let mut wrong_aud = base.clone();
        wrong_aud["aud"] = serde_json::json!("convex");
        assert!(check(&wrong_aud).is_err());
        let mut missing_aud = base.clone();
        missing_aud.as_object_mut().unwrap().remove("aud");
        assert!(check(&missing_aud).is_err());
        let mut wrong_party = base.clone();
        wrong_party["azp"] = serde_json::json!("https://evil.example");
        assert!(matches!(
            check(&wrong_party),
            Err(AuthError::Invalid {
                reason: "authorized party mismatch"
            })
        ));
        let mut missing_party = base.clone();
        missing_party.as_object_mut().unwrap().remove("azp");
        assert!(check(&missing_party).is_err());
        let mut future = base.clone();
        future["nbf"] = serde_json::json!(now + 3600);
        assert!(check(&future).is_err());
        let mut empty_sub = base.clone();
        empty_sub["sub"] = serde_json::json!("");
        assert!(matches!(check(&empty_sub), Err(AuthError::MissingSubject)));
        let mut no_sub = base.clone();
        no_sub.as_object_mut().unwrap().remove("sub");
        assert!(check(&no_sub).is_err());
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
            fn load_jwks(
                &self,
            ) -> futures_util::future::BoxFuture<'static, Result<JwkSet, AuthError>> {
                let state = self.state.clone();
                Box::pin(async move {
                    let mut state = state.lock().expect("lock");
                    *state += 1;
                    // Before rotation: key-1 only. After rotation: key-2 only.
                    let jwk = if *state >= 2 {
                        jwks_with_kid("rotated-kid", KEY2)
                    } else {
                        jwks_with_kid("test-key-1", KEY1)
                    };
                    Ok(jwk)
                })
            }
        }

        let mut v = TokenVerifier::new(
            ISSUER,
            RotatingJwks {
                state: state.clone(),
            },
        );
        v.refresh_cooldown = Duration::ZERO;
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

    #[test]
    fn unknown_kids_cannot_permanently_exhaust_rotation_refresh() {
        const KEY1: &[u8] = include_bytes!("test_rsa_key.der");
        const KEY2: &[u8] = include_bytes!("test_rsa_key2.der");
        let state = Arc::new(Mutex::new((0usize, false)));
        struct RotatingSource(Arc<Mutex<(usize, bool)>>);
        impl JwksSource for RotatingSource {
            fn load_jwks(
                &self,
            ) -> futures_util::future::BoxFuture<'static, Result<JwkSet, AuthError>> {
                let state = Arc::clone(&self.0);
                Box::pin(async move {
                    let mut state = state.lock().expect("test source lock");
                    state.0 += 1;
                    Ok(if state.1 {
                        jwks_with_kid("new-key", KEY2)
                    } else {
                        jwks_with_kid("old-key", KEY1)
                    })
                })
            }
        }
        let verifier = TokenVerifier::new(ISSUER, RotatingSource(Arc::clone(&state)));
        let rt = tokio::runtime::Runtime::new().expect("test runtime");
        let old = sign(
            &claims_now("old", ISSUER),
            &test_encoding_key_from(KEY1),
            "old-key",
        );
        rt.block_on(verifier.verify(&old)).expect("initial key");

        for kid in ["unknown-1", "unknown-2", "unknown-3"] {
            let token = sign(
                &claims_now("attacker", ISSUER),
                &test_encoding_key_from(KEY1),
                kid,
            );
            assert!(rt.block_on(verifier.verify(&token)).is_err());
        }
        assert_eq!(
            state.lock().expect("test source lock").0,
            1,
            "an unknown-kid burst within cooldown must not cause extra fetches"
        );
        state.lock().expect("test source lock").1 = true;
        verifier.cache.lock().expect("cache lock").last_attempt =
            Some(Instant::now() - DEFAULT_REFRESH_COOLDOWN);
        let rotated = sign(
            &claims_now("new", ISSUER),
            &test_encoding_key_from(KEY2),
            "new-key",
        );
        rt.block_on(verifier.verify(&rotated))
            .expect("unknown kids must not permanently disable real rotation");
    }

    #[tokio::test]
    async fn concurrent_unknown_kids_coalesce_to_one_refresh() {
        const KEY: &[u8] = include_bytes!("test_rsa_key.der");
        let loads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        struct CountingSource(Arc<std::sync::atomic::AtomicUsize>);
        impl JwksSource for CountingSource {
            fn load_jwks(
                &self,
            ) -> futures_util::future::BoxFuture<'static, Result<JwkSet, AuthError>> {
                let loads = Arc::clone(&self.0);
                Box::pin(async move {
                    loads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    Ok(jwks_with_kid("real-key", KEY))
                })
            }
        }
        let verifier = Arc::new(TokenVerifier::new(
            ISSUER,
            CountingSource(Arc::clone(&loads)),
        ));
        let token = sign(
            &claims_now("attacker", ISSUER),
            &test_encoding_key_from(KEY),
            "fake-key",
        );
        let tasks = (0..20).map(|_| {
            let verifier = Arc::clone(&verifier);
            let token = token.clone();
            tokio::spawn(async move { verifier.verify(&token).await })
        });
        for result in futures_util::future::join_all(tasks).await {
            assert!(result.expect("task joined").is_err());
        }
        assert_eq!(loads.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn oversized_http_jwks_is_rejected_before_body_download() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local test server");
        let addr = listener.local_addr().expect("local addr");
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept");
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut request = [0u8; 1024];
            let amount = stream.read(&mut request).await.expect("read request");
            assert!(amount > 0);
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        MAX_JWKS_BYTES + 1
                    )
                    .as_bytes(),
                )
                .await
                .expect("write headers");
        });
        let source = HttpJwks {
            url: format!("http://{addr}/jwks"),
        };
        assert!(matches!(
            source.load_jwks().await,
            Err(AuthError::JwksUnavailable)
        ));
        server.await.expect("test server joined");
    }
}
