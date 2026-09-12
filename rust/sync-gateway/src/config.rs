//! Gateway configuration (P3-M009): typed, secret-safe, fail-fast.
//!
//! All values come from `GATEWAY_*` environment variables. No secret values
//! are ever logged; missing required values abort startup so the gateway
//! never runs in a surprising state.

use std::env;
use std::net::SocketAddr;
use std::time::Duration;

/// Typed gateway configuration.
#[derive(Debug, Clone)]
pub struct Config {
    /// TCP bind address (host + port). Defaults to 127.0.0.1:8787.
    pub bind_host: String,
    pub bind_port: u16,
    /// PostgreSQL connection URL. REQUIRED (fail fast when absent).
    pub database_url: String,
    /// Clerk instance issuer (`https://<instance>.clerk.accounts.dev`).
    /// REQUIRED in this phase (no safe default).
    pub clerk_issuer: String,
    /// Comma-separated allowed browser origins (WebSocket upgrade policy).
    pub allowed_origins: Vec<String>,
    /// IP ranges of proxies permitted to supply X-Forwarded-For. Empty by default.
    pub trusted_proxy_cidrs: Vec<ipnet::IpNet>,
    /// Validated connect budget per logical client IP (before authentication).
    pub connect_rate_per_min: u64,
    /// Maximum accepted WebSocket frame size in bytes.
    pub max_frame_size: usize,
    /// Per-connection outbound queue capacity (count of frames).
    pub per_connection_queue_capacity: usize,
    /// Server->client heartbeat interval.
    pub heartbeat_interval: Duration,
    /// Idle timeout before a connection is dropped.
    pub idle_timeout: Duration,
    /// DB pool size (connections).
    pub db_pool_size: u32,
    /// Optional local JWKS file (dev/E2E only; production uses the issuer
    /// over HTTPS). Path, never contents, in config.
    pub jwks_file: Option<String>,
    // --- Phase 4 distributed configuration (P4-M009) ---
    /// NATS URL; absent ⇒ single-gateway Phase 3 mode (no broker).
    pub nats_url: Option<String>,
    /// NATS subject namespace prefix (default "concord.dev").
    pub nats_subject_prefix: String,
    /// Stable per-process gateway identity (P4-M010). Explicit or
    /// generated; used for logs/origin suppression/metrics — never a
    /// correctness authority.
    pub gateway_id: u64,
    /// Redis URL; absent ⇒ no ephemeral tier (presence disabled, local
    /// rate limiting only).
    pub redis_url: Option<String>,
    // --- Phase 6 observability (P6-M008/M009) ---
    /// OpenTelemetry tracing enabled (GATEWAY_OTEL_ENABLED, default
    /// false: zero behavior change when off).
    pub otel_enabled: bool,
    /// OTLP collector endpoint (GATEWAY_OTEL_ENDPOINT; default
    /// http://127.0.0.1:4317 — loopback dev posture).
    pub otel_endpoint: String,
    /// Parent-based sampling ratio (GATEWAY_OTEL_SAMPLE_RATIO; default
    /// 1.0 — local dev keeps every trace).
    pub otel_sample_ratio: f64,
    /// OTel exporter: "otlp" (default) | "stdout" | "memory" (tests).
    pub otel_exporter: String,
    /// Debug op-id attribution in spans/logs (GATEWAY_DEBUG_OP_IDS,
    /// default false: keeps span attribute cardinality bounded).
    pub debug_op_ids: bool,
    // --- Phase 6 maintenance scheduler (F-1 fix, P6 audit) ---
    /// Path to the native maintenance worker binary. Absent ⇒ the
    /// maintenance scheduler stays OFF (snapshots/compaction/retention
    /// jobs are enqueued by the pipeline but not executed by this
    /// process — the documented Phase 5 test-driven posture). Set ⇒ the
    /// BoundedRunner claims and executes jobs with graceful drain.
    pub worker_binary: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("missing required environment variable: {0}")]
    Missing(&'static str),
    #[error("invalid value for {key}: {message}")]
    Invalid { key: &'static str, message: String },
}

fn env_required(key: &'static str) -> Result<String, ConfigError> {
    env::var(key).map_err(|_| ConfigError::Missing(key))
}

fn env_optional(key: &'static str) -> Option<String> {
    env::var(key).ok()
}

fn env_parse<T>(key: &'static str, ctx: &str, default: T) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
{
    match env_optional(key) {
        None => Ok(default),
        Some(raw) => raw.parse().map_err(|_| ConfigError::Invalid {
            key,
            message: ctx.to_string(),
        }),
    }
}

const DEFAULT_BIND_HOST: &str = "127.0.0.1";
const DEFAULT_BIND_PORT: u16 = 8787;
const DEFAULT_ORIGINS: &str = "http://localhost:3000";
const DEFAULT_MAX_FRAME_SIZE: usize = 8 * 1024 * 1024; // 8 MiB (PROTOCOL §9.11)
const DEFAULT_QUEUE_CAPACITY: usize = 512;
const DEFAULT_HEARTBEAT_SECS: u64 = 30;
const DEFAULT_IDLE_SECS: u64 = 120;
const DEFAULT_DB_POOL_SIZE: u32 = 8;

impl Config {
    /// Builds a [`Config`] from the process environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        let database_url = env_required("GATEWAY_DATABASE_URL")?;
        let clerk_issuer = env_required("GATEWAY_CLERK_ISSUER")?;

        let bind_host =
            env_optional("GATEWAY_BIND_HOST").unwrap_or_else(|| DEFAULT_BIND_HOST.to_string());
        let bind_port = env_parse("GATEWAY_BIND_PORT", "expected a number", DEFAULT_BIND_PORT)?;

        let allowed_origins = match env_optional("GATEWAY_ALLOWED_ORIGINS") {
            Some(raw) => raw
                .split(',')
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            None => vec![DEFAULT_ORIGINS.to_string()],
        };
        let trusted_proxy_cidrs = env_optional("GATEWAY_TRUSTED_PROXY_CIDRS")
            .unwrap_or_default()
            .split(',')
            .filter(|value| !value.trim().is_empty())
            .map(|value| {
                let cidr =
                    value
                        .trim()
                        .parse::<ipnet::IpNet>()
                        .map_err(|_| ConfigError::Invalid {
                            key: "GATEWAY_TRUSTED_PROXY_CIDRS",
                            message: "expected comma-separated IP CIDRs".into(),
                        })?;
                if cidr.prefix_len() == 0 {
                    return Err(ConfigError::Invalid {
                        key: "GATEWAY_TRUSTED_PROXY_CIDRS",
                        message: "catch-all CIDR would trust arbitrary peers".into(),
                    });
                }
                Ok(cidr)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if trusted_proxy_cidrs.len() > 16 {
            return Err(ConfigError::Invalid {
                key: "GATEWAY_TRUSTED_PROXY_CIDRS",
                message: "at most 16 ranges are supported".into(),
            });
        }
        let connect_rate_per_min = env_parse(
            "GATEWAY_RATE_CONNECT_PER_MIN",
            "expected a number in [1, 10000]",
            240u64,
        )?;
        if !(1..=10_000).contains(&connect_rate_per_min) {
            return Err(ConfigError::Invalid {
                key: "GATEWAY_RATE_CONNECT_PER_MIN",
                message: "must be within [1, 10000]".into(),
            });
        }

        let max_frame_size = env_parse(
            "GATEWAY_MAX_FRAME_SIZE",
            "expected a byte count",
            DEFAULT_MAX_FRAME_SIZE,
        )?;
        let per_connection_queue_capacity = env_parse(
            "GATEWAY_QUEUE_CAPACITY",
            "expected a positive integer",
            DEFAULT_QUEUE_CAPACITY,
        )?;
        // Heartbeat interval and idle timeout in seconds (defaults above).
        let heartbeat_interval = Duration::from_secs(env_parse(
            "GATEWAY_HEARTBEAT_INTERVAL_SECS",
            "expected seconds",
            DEFAULT_HEARTBEAT_SECS,
        )?);
        let idle_timeout = Duration::from_secs(env_parse(
            "GATEWAY_IDLE_TIMEOUT_SECS",
            "expected seconds",
            DEFAULT_IDLE_SECS,
        )?);
        let db_pool_size = env_parse(
            "GATEWAY_DB_POOL_SIZE",
            "expected a positive integer",
            DEFAULT_DB_POOL_SIZE,
        )?;
        // Optional local JWKS file (dev/E2E only; empty or absent = HTTPS).
        let jwks_file = env_optional("GATEWAY_JWKS_FILE").filter(|s| !s.is_empty());

        // --- Phase 4 distributed config ---
        let nats_url = env_optional("GATEWAY_NATS_URL").filter(|s| !s.is_empty());
        let nats_subject_prefix = env_optional("GATEWAY_NATS_SUBJECT_PREFIX")
            .unwrap_or_else(|| "concord.dev".to_string());
        let gateway_id = match env_optional("GATEWAY_ID") {
            Some(raw) => raw.parse().map_err(|_| ConfigError::Invalid {
                key: "GATEWAY_ID",
                message: "expected a u64".into(),
            })?,
            None => {
                // Stable per-process identity: derive from a fresh UUID's
                // low 64 bits — unique in practice; not a correctness input.
                let u = uuid::Uuid::new_v4();
                u.as_u64_pair().0
            }
        };
        let redis_url = env_optional("GATEWAY_REDIS_URL").filter(|s| !s.is_empty());

        // --- Phase 6 observability config (P6-M009) ---
        let otel_enabled = env_parse("GATEWAY_OTEL_ENABLED", "expected a boolean", false)?;
        let otel_endpoint = env_optional("GATEWAY_OTEL_ENDPOINT")
            .unwrap_or_else(|| "http://127.0.0.1:4317".to_string());
        let otel_sample_ratio = env_parse(
            "GATEWAY_OTEL_SAMPLE_RATIO",
            "expected a ratio in [0.0, 1.0]",
            1.0f64,
        )?;
        if !(0.0..=1.0).contains(&otel_sample_ratio) {
            return Err(ConfigError::Invalid {
                key: "GATEWAY_OTEL_SAMPLE_RATIO",
                message: "must be within [0.0, 1.0]".into(),
            });
        }
        let otel_exporter = env_optional("GATEWAY_OTEL_EXPORTER")
            .unwrap_or_else(|| "otlp".to_string())
            .to_ascii_lowercase();
        if !matches!(otel_exporter.as_str(), "otlp" | "stdout" | "memory") {
            return Err(ConfigError::Invalid {
                key: "GATEWAY_OTEL_EXPORTER",
                message: format!("unknown exporter \"{otel_exporter}\" (otlp|stdout|memory)"),
            });
        }
        let debug_op_ids = env_parse("GATEWAY_DEBUG_OP_IDS", "expected a boolean", false)?;
        crate::observability::correlation::set_debug_op_ids(debug_op_ids);

        let worker_binary = env_optional("GATEWAY_WORKER_BINARY").filter(|s| !s.is_empty());
        if let Some(path) = &worker_binary {
            if !std::path::Path::new(path).is_file() {
                return Err(ConfigError::Invalid {
                    key: "GATEWAY_WORKER_BINARY",
                    message: format!("worker binary not found at \"{path}\" (leave GATEWAY_WORKER_BINARY unset to disable maintenance scheduling)"),
                });
            }
        }

        if per_connection_queue_capacity == 0 {
            return Err(ConfigError::Invalid {
                key: "GATEWAY_QUEUE_CAPACITY",
                message: "must be >= 1".into(),
            });
        }
        if db_pool_size == 0 {
            return Err(ConfigError::Invalid {
                key: "GATEWAY_DB_POOL_SIZE",
                message: "must be >= 1".into(),
            });
        }
        if max_frame_size < 1024 {
            return Err(ConfigError::Invalid {
                key: "GATEWAY_MAX_FRAME_SIZE",
                message: "must be >= 1024".into(),
            });
        }

        // Fail fast on a non-literal bind host: `SocketAddr::parse` (used by
        // main) only accepts IP literals, so a hostname like `localhost`
        // would otherwise panic at startup instead of exiting with a clear
        // config error.
        let bind_addr = format!("{bind_host}:{bind_port}");
        if bind_addr.parse::<SocketAddr>().is_err() {
            return Err(ConfigError::Invalid {
                key: "GATEWAY_BIND_HOST",
                message: format!("expected an IP address (e.g. 127.0.0.1), got \"{bind_host}\""),
            });
        }

        Ok(Self {
            bind_host,
            bind_port,
            database_url,
            clerk_issuer,
            allowed_origins,
            trusted_proxy_cidrs,
            connect_rate_per_min,
            max_frame_size,
            per_connection_queue_capacity,
            heartbeat_interval,
            idle_timeout,
            db_pool_size,
            jwks_file,
            nats_url,
            nats_subject_prefix,
            gateway_id,
            redis_url,
            otel_enabled,
            otel_endpoint,
            otel_sample_ratio,
            otel_exporter,
            debug_op_ids,
            worker_binary,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Sets a known-good baseline env and runs `f` with it.
    fn with_env<T>(mutations: &[(&str, Option<&str>)], f: impl FnOnce() -> T) -> T {
        let _guard = ENV_LOCK.lock().unwrap();
        let saved: Vec<(&str, Option<String>)> = [
            "GATEWAY_DATABASE_URL",
            "GATEWAY_CLERK_ISSUER",
            "GATEWAY_BIND_HOST",
            "GATEWAY_BIND_PORT",
            "GATEWAY_MAX_FRAME_SIZE",
            "GATEWAY_QUEUE_CAPACITY",
            "GATEWAY_ALLOWED_ORIGINS",
            "GATEWAY_TRUSTED_PROXY_CIDRS",
            "GATEWAY_RATE_CONNECT_PER_MIN",
            "GATEWAY_HEARTBEAT_INTERVAL_SECS",
            "GATEWAY_IDLE_TIMEOUT_SECS",
            "GATEWAY_DB_POOL_SIZE",
            "GATEWAY_JWKS_FILE",
            "GATEWAY_NATS_URL",
            "GATEWAY_NATS_SUBJECT_PREFIX",
            "GATEWAY_ID",
            "GATEWAY_REDIS_URL",
            "GATEWAY_OTEL_ENABLED",
            "GATEWAY_OTEL_ENDPOINT",
            "GATEWAY_OTEL_SAMPLE_RATIO",
            "GATEWAY_OTEL_EXPORTER",
            "GATEWAY_DEBUG_OP_IDS",
        ]
        .iter()
        .map(|k| (*k, env::var(k).ok()))
        .collect();

        env::set_var("GATEWAY_DATABASE_URL", "postgres://u:p@localhost/concord");
        env::set_var("GATEWAY_CLERK_ISSUER", "https://example.clerk.accounts.dev");
        for key in [
            "GATEWAY_BIND_HOST",
            "GATEWAY_BIND_PORT",
            "GATEWAY_MAX_FRAME_SIZE",
            "GATEWAY_QUEUE_CAPACITY",
            "GATEWAY_ALLOWED_ORIGINS",
            "GATEWAY_TRUSTED_PROXY_CIDRS",
            "GATEWAY_RATE_CONNECT_PER_MIN",
            "GATEWAY_HEARTBEAT_INTERVAL_SECS",
            "GATEWAY_IDLE_TIMEOUT_SECS",
            "GATEWAY_DB_POOL_SIZE",
            "GATEWAY_JWKS_FILE",
            "GATEWAY_NATS_URL",
            "GATEWAY_NATS_SUBJECT_PREFIX",
            "GATEWAY_ID",
            "GATEWAY_REDIS_URL",
            "GATEWAY_OTEL_ENABLED",
            "GATEWAY_OTEL_ENDPOINT",
            "GATEWAY_OTEL_SAMPLE_RATIO",
            "GATEWAY_OTEL_EXPORTER",
            "GATEWAY_DEBUG_OP_IDS",
        ] {
            env::remove_var(key);
        }

        for (key, value) in mutations {
            match value {
                Some(v) => env::set_var(key, v),
                None => env::remove_var(key),
            }
        }

        let result = f();

        for (key, prev) in saved {
            match prev {
                Some(v) => env::set_var(key, v),
                None => env::remove_var(key),
            }
        }
        result
    }

    #[test]
    fn defaults_apply_when_only_required_present() {
        with_env(&[], || {
            let cfg = Config::from_env().expect("valid env");
            assert_eq!(cfg.bind_host, "127.0.0.1");
            assert_eq!(cfg.bind_port, 8787);
            assert_eq!(cfg.max_frame_size, 8 * 1024 * 1024);
            assert_eq!(cfg.per_connection_queue_capacity, 512);
            assert_eq!(
                cfg.allowed_origins,
                vec!["http://localhost:3000".to_string()]
            );
            assert_eq!(cfg.db_pool_size, 8);
        });
    }

    #[test]
    fn missing_required_env_fails_fast() {
        with_env(
            &[("GATEWAY_DATABASE_URL", None)],
            || match Config::from_env() {
                Err(ConfigError::Missing("GATEWAY_DATABASE_URL")) => {}
                other => panic!("expected Missing(GATEWAY_DATABASE_URL), got {other:?}"),
            },
        );
        with_env(
            &[("GATEWAY_CLERK_ISSUER", None)],
            || match Config::from_env() {
                Err(ConfigError::Missing("GATEWAY_CLERK_ISSUER")) => {}
                other => panic!("expected Missing(GATEWAY_CLERK_ISSUER), got {other:?}"),
            },
        );
    }

    #[test]
    fn malformed_port_rejected() {
        with_env(&[("GATEWAY_BIND_PORT", Some("not-a-number"))], || {
            assert!(matches!(
                Config::from_env(),
                Err(ConfigError::Invalid {
                    key: "GATEWAY_BIND_PORT",
                    ..
                })
            ));
        });
    }

    #[test]
    fn zero_queue_capacity_rejected() {
        with_env(&[("GATEWAY_QUEUE_CAPACITY", Some("0"))], || {
            assert!(matches!(
                Config::from_env(),
                Err(ConfigError::Invalid {
                    key: "GATEWAY_QUEUE_CAPACITY",
                    ..
                })
            ));
        });
    }

    #[test]
    fn origins_parse_and_normalize() {
        with_env(
            &[(
                "GATEWAY_ALLOWED_ORIGINS",
                Some(" http://localhost:3000/,https://concord.example.com "),
            )],
            || {
                let cfg = Config::from_env().expect("valid env");
                assert_eq!(
                    cfg.allowed_origins,
                    vec!["http://localhost:3000", "https://concord.example.com"]
                );
            },
        );
    }

    #[test]
    fn distributed_config_defaults_and_validation() {
        // Absent NATS/Redis ⇒ single-gateway mode (None); gateway id is
        // generated (nonzero); subject prefix defaults.
        with_env(
            &[
                ("GATEWAY_NATS_URL", None),
                ("GATEWAY_REDIS_URL", None),
                ("GATEWAY_ID", None),
            ],
            || {
                let cfg = Config::from_env().expect("valid");
                assert!(cfg.nats_url.is_none());
                assert!(cfg.redis_url.is_none());
                assert!(cfg.gateway_id != 0, "generated gateway id must be nonzero");
                assert_eq!(cfg.nats_subject_prefix, "concord.dev");
            },
        );
        // Explicit gateway id is respected; malformed rejected.
        with_env(&[("GATEWAY_ID", Some("42"))], || {
            assert_eq!(Config::from_env().expect("valid").gateway_id, 42);
        });
        with_env(&[("GATEWAY_ID", Some("not-a-u64"))], || {
            assert!(matches!(
                Config::from_env(),
                Err(ConfigError::Invalid {
                    key: "GATEWAY_ID",
                    ..
                })
            ));
        });
        // Broker URL present ⇒ distributed mode.
        with_env(
            &[("GATEWAY_NATS_URL", Some("nats://127.0.0.1:4222"))],
            || {
                assert_eq!(
                    Config::from_env().expect("valid").nats_url.as_deref(),
                    Some("nats://127.0.0.1:4222")
                );
            },
        );
    }

    #[test]
    fn hostname_bind_host_rejected_fail_fast() {
        // A hostname (not an IP literal) must fail config validation, not
        // panic later in `main`'s SocketAddr::parse.
        with_env(&[("GATEWAY_BIND_HOST", Some("localhost"))], || {
            assert!(matches!(
                Config::from_env(),
                Err(ConfigError::Invalid {
                    key: "GATEWAY_BIND_HOST",
                    ..
                })
            ));
        });
        with_env(&[("GATEWAY_BIND_HOST", Some("0.0.0.0"))], || {
            assert!(Config::from_env().is_ok());
        });
    }

    #[test]
    fn proxy_ranges_and_connect_budget_fail_closed_on_bad_configuration() {
        with_env(&[], || {
            let cfg = Config::from_env().expect("defaults");
            assert!(cfg.trusted_proxy_cidrs.is_empty());
            assert_eq!(cfg.connect_rate_per_min, 240);
        });
        with_env(
            &[
                ("GATEWAY_TRUSTED_PROXY_CIDRS", Some("10.0.0.0/8,fd00::/8")),
                ("GATEWAY_RATE_CONNECT_PER_MIN", Some("60")),
            ],
            || {
                let cfg = Config::from_env().expect("valid ranges");
                assert_eq!(cfg.trusted_proxy_cidrs.len(), 2);
                assert_eq!(cfg.connect_rate_per_min, 60);
            },
        );
        for invalid in ["garbage", "0.0.0.0/0", "::/0"] {
            with_env(&[("GATEWAY_TRUSTED_PROXY_CIDRS", Some(invalid))], || {
                assert!(matches!(
                    Config::from_env(),
                    Err(ConfigError::Invalid {
                        key: "GATEWAY_TRUSTED_PROXY_CIDRS",
                        ..
                    })
                ));
            });
        }
        for invalid in ["garbage", "0", "10001"] {
            with_env(&[("GATEWAY_RATE_CONNECT_PER_MIN", Some(invalid))], || {
                assert!(matches!(
                    Config::from_env(),
                    Err(ConfigError::Invalid {
                        key: "GATEWAY_RATE_CONNECT_PER_MIN",
                        ..
                    })
                ));
            });
        }
    }
}
