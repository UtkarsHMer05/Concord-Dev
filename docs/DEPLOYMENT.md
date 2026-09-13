# Concord — Deployment Topology (v1)

Status: Authoritative (Phase 7) · Implements DEC-050 · Staging-first rule
per `docs/MIGRATIONS.md` and `docs/OPERATIONS.md`.

The AWS topology below is a deployable owner runbook and records the
historical Phase 7 exercise. No AWS environment is running in the current
repository state; DNS, TLS, cloud credentials, and the live deployment are
owner actions.

One compose stack per environment; staging and production are separate
EC2 instances with identical shape. Replica counts are deliberately
small and truthful — this is not an HA deployment (see §4).

## 1. Staging / production topology (identical shape)

```mermaid
flowchart TB
    U["Browser (client)"] -->|"HTTPS / WSS"| ALB["AWS ALB\n(TLS termination)\n:443 public"]
    ALB -->|"HTTP :3000 / WS upgrade"| WEB["concord-web container\n(Next.js standalone)\nnon-root uid 1000"]
    ALB -->|"WSS :8890 /api/v1/sync"| LB["nginx LB container\nround-robin, no sticky"]
    LB --> GW1["concord-gateway :8791"]
    LB --> GW2["concord-gateway :8792"]
    LB --> GW3["concord-gateway :8793"]
    subgraph PRIV["private: VPC-internal / instance-only ports"]
        PG[("PostgreSQL 18.6\n:5432 — durable truth")]
        NATS["NATS JetStream\n:4222 — event transport\n(not order authority)"]
        REDIS["Redis 8.8\n:6379 — ephemeral only"]
        PROM["Prometheus :9090\n+ Grafana :3000\nloopback-bound"]
    end
    WEB --> PG
    GW1 --> PG
    GW2 --> PG
    GW3 --> PG
    GW1 --> NATS
    GW2 --> NATS
    GW3 --> NATS
    GW1 -.-> REDIS
    GW2 -.-> REDIS
    GW3 -.-> REDIS
    GW1 -.->|"GATEWAY_WORKER_BINARY\n(stdio, in-image)"| W["concord-worker\n(C++ snapshots/recovery)"]
    GW2 -.-> W
    GW3 -.-> W
    GW1 -.-> PROM
    GW2 -.-> PROM
    GW3 -.-> PROM
```

Public/private boundary:

| Port | Service | Exposure |
|---|---|---|
| 443 | ALB (TLS) | Public — the only public entrypoint |
| 3000 | web | ALB target only (security group: ALB → instance) |
| 8890 | nginx LB | ALB target only |
| 8791-8793 | gateways | nginx LB only (localhost) |
| 5432 | PostgreSQL | Instance/VPC only — never public |
| 4222 | NATS | Instance only |
| 6379 | Redis | Instance only |
| 9090/3000 | Prometheus/Grafana | Loopback only (SSH tunnel to inspect) |

## 2. Durable operation flow (what deployment must preserve)

```mermaid
sequenceDiagram
    participant B as Browser (WASM CRDT in Worker)
    participant G as Rust gateway (per-batch in-tx authz)
    participant P as PostgreSQL (durable truth)
    participant N as NATS JetStream
    participant G2 as Peer gateway(s)
    B->>G: client_ops batch (stable op identities)
    G->>P: INSERT…ON CONFLICT inside one transaction (authz recheck in-tx)
    P-->>G: commit
    G-->>B: durable_ack (only AFTER commit — never before)
    G->>N: publish batch event (post-commit, msg-id dedup)
    N->>G2: fanout → room members
```

## 3. Recovery flow (why the topology is safe)

```mermaid
flowchart LR
    A["stale / reconnecting client"] -->|"join + state summary"| G["gateway"]
    G -->|"snapshot at/below floor?"| S{"compaction floor?"}
    S -->|"yes"| SNAP["fetch verified snapshot\n(checksum + integrity matrix)"]
    S -->|"no"| REPLAY["catch-up stream from DB floor (bounded pages)"]
    SNAP --> T["apply tail ops after snapshot"]
    REPLAY --> C["converged (digest verified)"]
    T --> C
```

Failure model reference: `docs/FAILURE_MODEL.md`; chaos evidence:
`docs/VERIFICATION.md` §3 (27/27 scenarios, 0 lost durable-ACKed
operations, 0 divergent replicas).

## 4. What v1 IS and IS NOT (honest claims)

- IS: 3 gateway replicas behind an LB (connectivity/fanout scale-out);
  Postgres as the single durable truth; verified snapshots + bounded
  tails; graceful drain on SIGTERM (rolling restart safe); automated
  backups (see `docs/OPERATIONS.md`).
- IS NOT: multi-AZ failover, auto-scaling, multi-region, Redis Cluster,
  or NATS clustering. Nothing here claims HA — recovery from component
  loss is tested (chaos), but failover between instances is not
  implemented in v1. Single-node data services per environment.

## 5. Environment matrix

| | Staging | Production |
|---|---|---|
| Instance | 1× Graviton (2 vCPU min) | 1× Graviton (2+ vCPU) |
| Gateway replicas | 3 | 3 |
| Web replicas | 1 | 1 |
| Postgres | compose + volume + nightly dump | compose + volume + nightly dump |
| DNS | ALB DNS name (no custom domain) | ALB DNS name (no custom domain) |
| Secrets | env injection at launch | env injection at launch |
| Migrations | applied per `docs/MIGRATIONS.md` | same runbook, after staging |
