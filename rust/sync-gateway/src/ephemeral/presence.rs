//! Cross-gateway ephemeral presence (P4-M022; DEC-033).
//!
//! Key: `presence:<doc>:<user>` → hash {gateway, replica, ts}, TTL 60s.
//! Presence is best-effort visibility only — NEVER authorization truth
//! and never document content. Expiry is authoritative for staleness;
//! cleanup is best-effort (SCAN-free: we rely on TTL).

use std::time::Duration;

use uuid::Uuid;

use super::{EphemeralError, RedisHandle};

pub const PRESENCE_TTL: Duration = Duration::from_secs(60);

/// One presence record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Presence {
    pub user_id: Uuid,
    pub document_id: Uuid,
    pub gateway_id: u64,
    pub updated_at_ms: u64,
}

/// Presence operations (all bounded, all degradable).
pub struct PresenceStore {
    redis: RedisHandle,
}

impl PresenceStore {
    pub fn new(redis: RedisHandle) -> Self {
        Self { redis }
    }

    fn key(&self, document: Uuid, user: Uuid) -> String {
        self.redis
            .namespaced(&format!("presence:{document}:{user}"))
    }

    /// Upsert one presence record with TTL (best-effort; errors degrade).
    pub async fn upsert(
        &self,
        document: Uuid,
        user: Uuid,
        gateway_id: u64,
    ) -> Result<(), EphemeralError> {
        let mut conn = self.redis.manager();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let key = self.key(document, user);
        let _: () = tokio::time::timeout(
            Duration::from_secs(2),
            redis::pipe()
                .hset(&key, "gateway", gateway_id)
                .hset(&key, "ts", now)
                .expire(&key, PRESENCE_TTL.as_secs() as i64)
                .query_async(&mut conn),
        )
        .await
        .map_err(|_| EphemeralError::Operation)?
        .map_err(|_| EphemeralError::Operation)?;
        Ok(())
    }

    /// Remove on disconnect (best-effort; TTL is the floor).
    pub async fn remove(&self, document: Uuid, user: Uuid) -> Result<(), EphemeralError> {
        let mut conn = self.redis.manager();
        let _: () = tokio::time::timeout(
            Duration::from_secs(2),
            redis::cmd("DEL")
                .arg(self.key(document, user))
                .query_async(&mut conn),
        )
        .await
        .map_err(|_| EphemeralError::Operation)?
        .map_err(|_| EphemeralError::Operation)?;
        Ok(())
    }

    /// Counts presence entries for a document via SCAN of the namespaced
    /// presence pattern (bounded cursor batches; best-effort).
    pub async fn document_presence_count(&self, document: Uuid) -> Result<u64, EphemeralError> {
        let mut conn = self.redis.manager();
        let pattern = self.redis.namespaced(&format!("presence:{document}:*"));
        let mut cursor: u64 = 0;
        let mut count = 0u64;
        loop {
            let (next, keys): (u64, Vec<String>) = tokio::time::timeout(
                Duration::from_secs(3),
                redis::cmd("SCAN")
                    .arg(cursor)
                    .arg("MATCH")
                    .arg(&pattern)
                    .arg("COUNT")
                    .arg(200)
                    .query_async(&mut conn),
            )
            .await
            .map_err(|_| EphemeralError::Operation)?
            .map_err(|_| EphemeralError::Operation)?;
            count += keys.len() as u64;
            cursor = next;
            if cursor == 0 {
                break;
            }
        }
        Ok(count)
    }
}
