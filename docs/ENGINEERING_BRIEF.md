# Concord — Engineering Brief

A factual technical orientation for engineers, interviewers, and
recruiters. Everything here traces to a document, a test, or a measured
benchmark in this repository — links are inline, and
[VERIFICATION.md](VERIFICATION.md) is the claim-to-evidence index for
the whole project. Nothing in this brief is marketing; where a
capability is limited, the limitation is stated with its pointer.

---

## What Concord is

Concord is a local-first collaborative document workspace — a
Google-Docs-class editor UX — with its synchronization engine **implemented
in this repository**: a sequence CRDT, the browser local-first runtime, the
WebSocket sync gateways, the durability and recovery layer, and the wire
protocol. The provenance record distinguishes Concord-developed code from
third-party and generated material; no blanket authorship or legal claim is
made. No collaboration SaaS is
involved: Liveblocks and Convex were removed deliberately in Phases 0–1
(smoke tests assert their old endpoints 404), and the tutorial baseline
this project started from is preserved and audited at the historical git
reference `antonio-original-baseline` ([PROVENANCE.md](PROVENANCE.md)). The
system was built in eight gated phases (2026-09-06 → 2026-09-11), with the
historical `concord-v1.0.0` tag preserved as a v1 identity; the current
`1.0.1` candidate and release state are recorded separately in the canonical
report. The AWS 10-service deployment was exercised historically and is
intentionally torn down now; any configured web URL is a reference only and
was not independently verified in this pass.

## Why a CRDT — and why built, not adopted

The hard part of collaborative editing is keeping many replicas of one
document converging while people type simultaneously, on unreliable
networks, without ever losing an edit that was acknowledged as saved
([README](../README.md)). Concord chose an **operation-based sequence
CRDT with YATA-style origin anchoring** over a flat item stream
(DEC-023 in [DECISIONS.md](DECISIONS.md)): every insert records left
and right origin anchors; integration resolves concurrent same-position
inserts by fixed-size item identities `(ReplicaId, counter)`, so
convergence depends only on the *set* of operations received — never
arrival order, duplication, or wall-clock time
([CONSISTENCY_MODEL.md](CONSISTENCY_MODEL.md)). Alternatives were
evaluated and rejected on the record: per-block RGA (split/merge moves
elements across containers), Logoot/LSEQ positional identifiers
(identifier-size/interleaving subtleties), tree CRDTs over the
ProseMirror node tree (larger implementation surface than v1 needs), and
— explicitly — adopting Yrs/Automerge, because owning the
synchronization core is the project's thesis (only published algorithms
were studied, no code copied). A hosted collab SaaS or an OT
central-server design would have removed exactly the engineering
problem this project exists to demonstrate.

## One core, two targets (C++20 → native + WASM)

The CRDT is written **once in C++20** and compiled twice: native
(server-side verification and the recovery worker) and WebAssembly
(browser) — DEC-006. The argument is semantic authority: if every
replica runs the same merge code, convergence cannot drift between
platforms. This is enforced, not assumed: native and WASM builds assert
**byte-identical digests** against shared golden vectors in every
correctness run (26 parity tests + smoke,
[TESTING.md](TESTING.md) §6), and TS ⇄ Rust ⇄ C++ protocol codecs are
cross-language golden-tested. The same native binary doubles as the
standalone recovery worker (`concord-worker`, DEC-038), spawned by the
Rust gateway per maintenance request with bounded IO and kill-on-drop —
native sanitizers (ASan/UBSan/TSan) and fuzzers apply to the exact code
the browser runs.

## The durability contract

The invariant that makes "saved" mean saved: **an operation is
acknowledged only after its PostgreSQL WAL commit** — commit-before-ACK
on every batch, inside one transaction
([FAILURE_MODEL.md](FAILURE_MODEL.md)). Delivery is at-least-once with
idempotent ingestion everywhere: operation identity = canonical bytes
under `(document_id, operation_id)`, a unique index as the dedup
boundary, `INSERT … ON CONFLICT DO NOTHING`. Client crash mid-batch,
gateway SIGKILL after commit, NATS redelivery storms — all tested, none
lose an acknowledged operation (27/27 chaos scenarios, 0 lost
durable-ACKed ops — [VERIFICATION.md](VERIFICATION.md) §3). The role of
each store is deliberate ([DECISIONS.md](DECISIONS.md) DEC-004/008/009):

| Store | Role | Explicitly NOT |
|---|---|---|
| PostgreSQL 18 | the only durable truth: op log, ACLs, snapshots, revisions, audit | — |
| NATS JetStream | inter-gateway event transport (msg-id dedup, post-commit publish) | not the ordering authority, not truth |
| Redis | ephemeral: TTL presence, rate limits | never durable; safe to FLUSHALL by design (proven by chaos test) |

Authorization is deny-by-default RBAC
(OWNER/EDITOR/COMMENTER/VIEWER), re-checked on every batch inside the
ingestion transaction, with revocation effective on the next write and
no existence oracle on denial ([AUTHORIZATION.md](AUTHORIZATION.md)).
Clerk verifies identity only; every authorization decision is made
against Concord-owned data in PostgreSQL.

## Snapshot + tail recovery

Recovery does not replay history. A stale client or gateway fetches the
newest finalized snapshot plus the bounded post-boundary tail; corrupt
snapshots fall back to older ones, then to full replay — recovery never
fails due to corruption ([RECOVERY.md](RECOVERY.md),
[ARCHITECTURE.md](ARCHITECTURE.md) §0). Measured head-to-head at a
100 k-op history with a 1 k tail (5 runs, digest equality asserted on
every run): full replay 65.2 s vs snapshot+tail **0.96 s p50 — 98.4 %
faster**, reproduced four consecutive times at 98.6 / 98.5 / 98.6 /
98.4 % across the Phase 6 and Phase 7 campaigns on different commits
([BENCHMARKS.md](BENCHMARKS.md) — P7-M038). Crash-safe staged
compaction keeps 50.1 % of durable bytes after fully compacting a
50 k-op document while retaining historical revisions.

## The hardest bugs — found by the project's own testing

These are the ones worth asking about, each documented where it was
found and pinned by a regression test:

1. **CRITICAL broker off-by-one panic (found by fuzzing).**
   `BrokerEvent::decode` accepted a 74-byte frame through its `< 74`
   length gate, then panicked reading the second byte of `op_count` at
   index 74 — any peer in the NATS mesh could crash a whole gateway with
   one truncated event. Found by the Phase 6 Rust protocol fuzzer, fixed
   (minimum length 75), and pinned forever as regression
   `FUZZ-2026-09-001` in
   `rust/sync-gateway/tests/protocol_fuzz_regressions.rs`; the fuzz
   campaign is recorded in [TESTING.md](TESTING.md) §13 and
   [VERIFICATION.md](VERIFICATION.md) §2.
2. **JWKS lifetime-refresh exhaustion (found by the v1 hardening pass).**
   The gateway's JWKS refresh budget was a process-lifetime counter an
   attacker could burn by sending unknown `kid` values, permanently
   breaking key rotation. A new regression test fails against the old
   counter (rotation after attack, concurrent burst, oversized
   response); the fix is async singleflight with cooldown, negative
   caching, TTL, and bounded HTTP. Finding HARD-AUTH-001 in
   [audits/V1_HARDENING_FINDINGS.md](audits/V1_HARDENING_FINDINGS.md).
3. **The staging `aud=convex` incident.** Real Clerk JWTs were rejected
   by default audience validation: the session token still carried the
   tutorial-era `"aud": "convex"` claim while the gateway began
   enforcing strict audiences (commit `0b9ae95` series, P7-M024). Root
   cause was a claim-migration gap, not code; the resolution — a
   Concord-specific audience, `azp` pinned to the app origin, and a
   push-bundle that refuses a missing or literal `convex` audience — is
   the Clerk claim-migration section of [SECURITY.md](SECURITY.md) §10,
   tracked open in [audits/V1_HARDENING_FINDINGS.md](audits/V1_HARDENING_FINDINGS.md)
   (HARD-AUTH-002) pending the live dashboard migration.
4. **The `PG_PASSWORD` regeneration incident.** A second
   `push-bundle.sh` run regenerated the cloud database password while
   the compose Postgres volume kept the original — every service failed
   DB auth and the gateways crash-looped "database unreachable"
   (observed live while rolling staging). Fix: password source order is
   explicit env → existing SSM SecureString → generate (first deploy
   only), plus an `instance-ops db-reset-password` recovery verb; commits
   `7c42631`/`cb68a0c`/`4ad3ebd` (P7-M024).

A fifth worth mentioning: the production CSP omission of
`wasm-unsafe-eval` silently disabled the WASM engine in WebKit — caught
during a historical production-shaped exercise and fixed with a pinned CSP plus a worker-init
fail-fast (P7-M033; README "Security" section). The hardening pass then
went further and replaced the script `'unsafe-inline'` allow with a
per-request nonce CSP generated in middleware
(`src/proxy.ts`, commit `05c9623`) — Next stamps the nonce on all
framework scripts and Clerk picks it up from the request CSP header;
the regression suite pins the effective header.

## Measured performance (with methodology labels)

Every number below is MEASURED under a recorded environment and run count —
[BENCHMARKS.md](BENCHMARKS.md) carries the methodology and reproduction
commands. These are historical phase-campaign measurements, not a new
performance delta claimed by the final hardening pass; the labels matter and
are never blurred:

| Measurement | Result | Methodology label |
|---|---|---|
| Durable-ACK ingest, 25-op batch | p50 31.45 → 2.72 ms (−91.4 %), throughput 771 → 8,685 ops/s (11.3×) | gateway microbenchmark, medians, digest-identical before/after (P7-M040) |
| Scale-out 1 → 4 gateways, 200 ops/s open-loop | ack p95 13.19 → 15.23 ms, zero loss, 0.000 % errors, 24/24 runs | gateway matrix {1..4 gw × 10/60 clients × 1/20 docs}, 3 runs/cell (P7-M037) |
| Snapshot+tail recovery, 100 k/1 k | 0.96 s vs 65.2 s full replay — 98.4 % faster | native recovery-bench, 5 runs, digest-verified (P7-M038) |
| Correctness campaigns | 181/181 scenarios, 0 divergent replicas; 130 seeds / 1.06 M ops; 27/27 chaos, 0 lost durable-ACKed ops | deterministic suites + chaos campaign (P6-M039) |
| Fuzzing | 5 M executions, 0 crashes; every fixed crash corpus-pinned | native standalone + Rust seeded mutational fuzzers (P6-M017/019) |
| Typing 0.003 ms/op; 5 k-op fanout batch 227 ms; runtime bundle 180 KB | **Node-instrumented WASM proxy** — explicitly not real-browser latency (P6-M036) |

## Honest limitations

Stated plainly, with pointers (also README "What the live demo runs"):

- **The configured demo URL is not a current runtime claim.** The multi-user
  realtime fanout path (Rust gateways + nginx + NATS + Redis) is built and
  tested locally, and was exercised historically on AWS before teardown. The
  current candidate's rendered-browser evidence is limited to the secretless
  public Chromium smoke; the historical Chromium/Firefox/WebKit results are
  labeled in `docs/BROWSER_SUPPORT.md`. The client detects a missing gateway
  and degrades truthfully (no fake "collaborating" states).
- **Collaborative subset**: text, headings, basic formatting. Content
  outside the subset degrades that session to whole-document save,
  surfaced loudly in the UI, never silently.
- **Single-node data services per environment** — gateways scale
  horizontally; the data tier does not (yet).
- **TLS requires a user-owned domain** (the no-cert mode opens the ALB
  sync port publicly instead — [SECURITY.md](SECURITY.md) §10).
- **Embedded-WebView browsers** are not independently verified in this pass
  and can need one event or a reload to converge live fanout visually. The
  rendered-browser matrix is documented in [BROWSER_SUPPORT.md](BROWSER_SUPPORT.md).
- History/restore UI is out of the v1 boundary (the revision/restore
  machinery exists and is protocol-tested — [HISTORY.md](HISTORY.md)).
- No exactly-once delivery is claimed anywhere: at-least-once +
  idempotent, within the fault model defined in
  [FAILURE_MODEL.md](FAILURE_MODEL.md).

## Where to dig next

[ARCHITECTURE.md](ARCHITECTURE.md) for the system,
[DECISIONS.md](DECISIONS.md) for the reasoning (DEC-001…050),
[VERIFICATION.md](VERIFICATION.md) for the evidence matrix,
[BENCHMARKS.md](BENCHMARKS.md) for the numbers with methodology, and
[audits/V1_HARDENING_FINDINGS.md](audits/V1_HARDENING_FINDINGS.md) for
the open/closed state of the hardening pass.
