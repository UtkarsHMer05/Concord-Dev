//! Inter-gateway event transport: NATS JetStream (P4-M011..M014).
//!
//! Design (DEC-031/032): one stream `CONCORD_OPS_<namespace>`, one subject,
//! one durable pull consumer PER GATEWAY. Events carry the FULL accepted
//! batch so peer gateways fan out without a DB read; identity idempotency
//! (PostgreSQL unique key + client CRDT dedup) makes redelivery safe. The
//! broker is a transport, never a correctness authority: publication happens
//! strictly AFTER the durable commit, and a gateway missing events recovers
//! via the DB catch-up floor.

mod envelope;

pub use envelope::{BrokerEvent, BrokerEventError};

use std::time::Duration;

use async_nats::jetstream;
use async_nats::jetstream::consumer::pull::Config as PullConfig;
use async_nats::jetstream::stream::StorageType;

/// Stream/consumer parameters (DEC-032).
pub const STREAM_NAME_PREFIX: &str = "CONCORD_OPS";
pub const MAX_STREAM_AGE: Duration = Duration::from_secs(10 * 60);
pub const DUPLICATE_WINDOW: Duration = Duration::from_secs(2 * 60);
pub const CONSUMER_ACK_WAIT: Duration = Duration::from_secs(30);
pub const CONSUMER_MAX_DELIVER: i64 = 5;
pub const CONSUMER_MAX_ACK_PENDING: i64 = 256;

/// Consumer-info refresh interval (B11 hardening): the subscriber loop
/// refreshes lag/redelivery at most this often instead of issuing a
/// per-message JetStream metadata request. 30s keeps the lag gauge
/// responsive enough to alert on while removing a network round trip
/// from the per-event hot path.
pub const CONSUMER_INFO_TTL: Duration = Duration::from_secs(30);

/// Errors for the broker layer (structured; no payload content).
#[derive(Debug, thiserror::Error)]
pub enum BrokerError {
    #[error("nats connect failed")]
    Connect,
    #[error("jetstream unavailable")]
    JetStream,
    #[error("stream provisioning failed: {0}")]
    Provision(String),
    #[error("publish failed")]
    Publish,
    #[error("consume failed")]
    Consume,
    #[error("event validation failed: {0}")]
    InvalidEvent(String),
}

// async-nats intentionally keeps URL parsing and connection options separate:
// `async_nats::connect("nats://user:pass@host")` parses the address but does
// NOT promote its user-info into the CONNECT frame. Do that explicitly so an
// authenticated deployment cannot silently act like an anonymous one. These
// values are kept only in the client builder and are never formatted/logged.
enum NatsUrlAuth {
    None,
    UserPassword { username: String, password: String },
    Token(String),
}

fn nats_server_and_auth(url: &str) -> Result<(async_nats::ServerAddr, NatsUrlAuth), BrokerError> {
    let server = url
        .parse::<async_nats::ServerAddr>()
        .map_err(|_| BrokerError::Connect)?;
    let auth = match (server.username(), server.password()) {
        (Some(username), Some(password)) => NatsUrlAuth::UserPassword {
            username: username.to_owned(),
            password: password.to_owned(),
        },
        // NATS URL syntax also permits nats://token@host. Preserve that
        // compatibility instead of treating the token as a username with a
        // missing password.
        (Some(token), None) => NatsUrlAuth::Token(token.to_owned()),
        (None, _) => NatsUrlAuth::None,
    };
    Ok((server, auth))
}

async fn connect_nats(url: &str) -> Result<async_nats::Client, BrokerError> {
    let (server, auth) = nats_server_and_auth(url)?;
    let client = match auth {
        NatsUrlAuth::None => async_nats::connect(server).await,
        NatsUrlAuth::UserPassword { username, password } => {
            async_nats::ConnectOptions::with_user_and_password(username, password)
                .connect(server)
                .await
        }
        NatsUrlAuth::Token(token) => {
            async_nats::ConnectOptions::with_token(token)
                .connect(server)
                .await
        }
    }
    .map_err(|_| BrokerError::Connect)?;
    Ok(client)
}

/// The per-gateway broker client: connection, stream, pull consumer.
pub struct Broker {
    jetstream: jetstream::Context,
    stream: jetstream::stream::Stream,
    consumer: jetstream::consumer::PullConsumer,
    consumer_name: String,
    subject: String,
    pub gateway_id: u64,
    /// B11: cached (ack_pending, redelivered) refreshed at most once per
    /// [`CONSUMER_INFO_TTL`] — the per-message path reads the cache, it
    /// never issues a JetStream metadata request per event.
    consumer_info_cache: tokio::sync::Mutex<Option<((u64, u64), std::time::Instant)>>,
}

impl Broker {
    /// Connects, provisions the stream + this gateway's durable consumer
    /// idempotently (M011/M012). Initial connect is explicit — the gateway
    /// starts degraded-but-alive rather than crashing if NATS is absent
    /// (callers treat `Err` as "run without broker"; the ws layer keeps
    /// local semantics — M019).
    pub async fn connect(url: &str, namespace: &str, gateway_id: u64) -> Result<Self, BrokerError> {
        let nats = connect_nats(url).await?;
        let jetstream = jetstream::new(nats);

        // NATS stream names: [A-Za-z0-9-] only — sanitize the namespace
        // (dots are fine in subjects, not in stream names).
        let sanitized: String = namespace
            .chars()
            .map(|c| match c {
                'a'..='z' | 'A'..='Z' | '0'..='9' | '-' => c,
                _ => '-',
            })
            .collect();
        let stream_name = format!("{STREAM_NAME_PREFIX}_{sanitized}");
        let subject = format!("{namespace}.ops.doc");
        let consumer_name = format!("gw-{gateway_id}");

        // Idempotent stream create-or-validate (never destructive).
        let mut stream = jetstream
            .get_or_create_stream(&jetstream_stream_config(&stream_name, &subject))
            .await
            .map_err(|e| BrokerError::Provision(e.to_string()))?;
        let info = stream
            .info()
            .await
            .map_err(|e| BrokerError::Provision(e.to_string()))?;
        if info.config.retention != jetstream::stream::RetentionPolicy::Limits {
            return Err(BrokerError::Provision(
                "existing stream retention is not Limits".into(),
            ));
        }

        // Idempotent durable pull consumer for THIS gateway.
        let consumer: jetstream::consumer::PullConsumer = stream
            .get_or_create_consumer(&consumer_name, consumer_config(&consumer_name, &subject))
            .await
            .map_err(|e| BrokerError::Provision(e.to_string()))?;

        Ok(Self {
            jetstream,
            stream,
            consumer,
            consumer_name,
            subject,
            gateway_id,
            consumer_info_cache: tokio::sync::Mutex::new(None),
        })
    }

    /// Publishes an accepted-batch event (M013: strictly AFTER the
    /// PostgreSQL commit; best-effort — a failure degrades cross-gateway
    /// realtime, never durability). Nats-Msg-Id = stable event identity so
    /// JetStream's duplicate window suppresses publisher retries.
    pub async fn publish(&self, event: &BrokerEvent) -> Result<(), BrokerError> {
        let bytes = event.encode();
        let ack = self
            .jetstream
            .publish_with_headers(
                self.subject.clone(),
                {
                    let mut headers = async_nats::HeaderMap::new();
                    headers.insert(
                        async_nats::header::NATS_MESSAGE_ID,
                        event.nats_msg_id().as_str(),
                    );
                    headers
                },
                bytes.into(),
            )
            .await
            .map_err(|_| BrokerError::Publish)?;
        ack.await.map_err(|_| BrokerError::Publish)?;
        Ok(())
    }

    /// Fetches the next bounded batch of messages (M018: caller acks after
    /// defined local processing; redelivery tolerated).
    pub async fn fetch(
        &self,
        batch: usize,
        expires: Duration,
    ) -> Result<Vec<jetstream::Message>, BrokerError> {
        let mut messages = self
            .consumer
            .fetch()
            .max_messages(batch)
            .expires(expires)
            .messages()
            .await
            .map_err(|_| BrokerError::Consume)?;
        let mut out = Vec::new();
        while let Some(msg) = futures_util::StreamExt::next(&mut messages).await {
            match msg {
                Ok(m) => out.push(m),
                Err(_) => return Err(BrokerError::Consume),
            }
        }
        Ok(out)
    }

    /// Consumer info: ack-pending (lag proxy) and redelivery stats
    /// (M036/M040). B11: TTL-cached — the per-message subscriber path
    /// reads the cached value; a refresh is issued at most once per
    /// [`CONSUMER_INFO_TTL`] so event processing never pays a JetStream
    /// metadata round trip per message. Callers that need live data
    /// (monitoring, tests) use [`Self::consumer_info_fresh`].
    pub async fn consumer_info(&self) -> Result<(u64, u64), BrokerError> {
        {
            let cache = self.consumer_info_cache.lock().await;
            if let Some((stats, at)) = *cache {
                if at.elapsed() < CONSUMER_INFO_TTL {
                    return Ok(stats);
                }
            }
        }
        self.refresh_consumer_info().await
    }

    /// Uncached consumer-info read (live JetStream request): for probes,
    /// dashboards, and tests that must observe the broker's current
    /// state rather than the hot-path sample.
    pub async fn consumer_info_fresh(&self) -> Result<(u64, u64), BrokerError> {
        let info = self
            .stream
            .consumer_info(&self.consumer_name)
            .await
            .map_err(|_| BrokerError::Consume)?;
        let stats = (info.num_ack_pending as u64, info.num_redelivered as u64);
        *self.consumer_info_cache.lock().await = Some((stats, std::time::Instant::now()));
        Ok(stats)
    }

    /// Cache-refresh path for the TTL expiry: last known value is kept
    /// when the broker request fails (errors surface via `healthy()`).
    async fn refresh_consumer_info(&self) -> Result<(u64, u64), BrokerError> {
        match self.consumer_info_fresh().await {
            Ok(stats) => Ok(stats),
            Err(e) => {
                let cache = self.consumer_info_cache.lock().await;
                if let Some((stats, _)) = *cache {
                    return Ok(stats);
                }
                Err(e)
            }
        }
    }

    /// Connectivity probe (degraded-state observability, M011). Bypasses
    /// the B11 consumer-info cache: a probe must reflect the live broker,
    /// not a stale healthy sample.
    pub async fn healthy(&self) -> bool {
        self.stream.consumer_info(&self.consumer_name).await.is_ok()
    }
}

fn jetstream_stream_config(name: &str, subject: &str) -> jetstream::stream::Config {
    jetstream::stream::Config {
        name: name.to_owned(),
        subjects: vec![subject.to_owned()],
        retention: jetstream::stream::RetentionPolicy::Limits,
        storage: StorageType::File,
        max_age: MAX_STREAM_AGE,
        duplicate_window: DUPLICATE_WINDOW,
        max_bytes: 512 * 1024 * 1024,
        ..Default::default()
    }
}

fn consumer_config(name: &str, subject: &str) -> PullConfig {
    PullConfig {
        durable_name: Some(name.to_owned()),
        ack_policy: jetstream::consumer::AckPolicy::Explicit,
        ack_wait: CONSUMER_ACK_WAIT,
        max_deliver: CONSUMER_MAX_DELIVER,
        max_ack_pending: CONSUMER_MAX_ACK_PENDING,
        filter_subject: subject.to_owned(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::{nats_server_and_auth, NatsUrlAuth};

    #[test]
    fn authenticated_nats_url_preserves_explicit_user_password() {
        let (server, auth) = nats_server_and_auth("nats://concord:secret-value@127.0.0.1:4222")
            .expect("valid NATS URL");
        assert_eq!(server.host(), "127.0.0.1");
        assert_eq!(server.port(), 4222);
        match auth {
            NatsUrlAuth::UserPassword { username, password } => {
                assert_eq!(username, "concord");
                assert_eq!(password, "secret-value");
            }
            _ => panic!("expected user/password NATS authentication"),
        }
    }

    #[test]
    fn token_and_anonymous_nats_urls_keep_their_auth_mode() {
        let (_, token) = nats_server_and_auth("nats://token-value@localhost:4222")
            .expect("valid token NATS URL");
        assert!(matches!(token, NatsUrlAuth::Token(value) if value == "token-value"));

        let (_, anonymous) =
            nats_server_and_auth("nats://127.0.0.1:4222").expect("valid anonymous NATS URL");
        assert!(matches!(anonymous, NatsUrlAuth::None));
    }

    #[test]
    fn malformed_nats_url_is_a_generic_connect_failure() {
        assert!(nats_server_and_auth("https://not-nats.example").is_err());
    }
}
