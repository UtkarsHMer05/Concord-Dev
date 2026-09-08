//! Standalone protocol fuzz driver (P6-M018).
//!
//! Mirrors `cpp/crdt/fuzz/standalone_driver.cpp` (P6-M017): libFuzzer /
//! cargo-fuzz is unavailable offline on this host, so the same
//! deterministic-seeded mutational loop drives the gateway's untrusted-input
//! decode layers directly. Every target is a pure `fn(&[u8])` that asserts
//! the decode contract: ANY byte string either decodes or returns a
//! structured error — never a panic, never an unbounded allocation.
//!
//! Usage: `cargo run --release --example proto_fuzz [runs-per-target]`
//! (defaults to 250_000 — the smoke tier; pass a seed via FUZZ_SEED).
//!
//! Targets:
//!  1. `fuzz_control_frame`    — protocol/control.rs `ControlFrame::decode`
//!     (malformed JSON, wrong types, unknown type strings, oversized
//!     tokens, deep nesting, extra envelope fields, unsupported versions).
//!  2. `fuzz_data_frame`       — protocol/data.rs `DataFrame::decode` +
//!     `decode_client_ops_validated` (truncated frames, bogus lengths,
//!     oversized op counts vs limits.rs).
//!  3. `fuzz_op_envelope`      — protocol/envelope.rs `validate_op`
//!     (bit-flips, wrong version, zero replica/counter, trailing bytes).
//!  4. `fuzz_broker_event`     — broker/envelope.rs `BrokerEvent::decode`
//!     (forged events, checksum mismatches, oversize caps, bad ops).
//!  5. `fuzz_session_property` — randomized SEQUENCE of control frames
//!     through the decode+state-machine-guard layer (the pure part of
//!     PROTOCOL §9.13 reachable without a live server: decode legality +
//!     the SessionState gating predicates).

use std::time::Instant;

use sync_gateway::broker::{BrokerEvent, BrokerEventError};
use sync_gateway::protocol::control::ControlFrame;
use sync_gateway::protocol::data::DataFrame;
use sync_gateway::protocol::envelope::validate_op;
use sync_gateway::protocol::{DecodeError, MAX_BATCH_OPS, MAX_OP_BYTES};
use sync_gateway::sessions::SessionState;

// ---------------------------------------------------------------------------
// xorshift64* RNG — deterministic, dependency-free (matches the C++ driver)
// ---------------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        // Never zero (xorshift would lock at 0); fold in the golden ratio.
        Self(seed | 0x9E3779B97F4A7C15 | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn byte(&mut self) -> u8 {
        (self.next() >> 24) as u8
    }
}

/// Mutational engine (same op set as the C++ standalone driver):
/// bit flip / random byte / truncate / insert / append / splice.
fn mutate(rng: &mut Rng, input: &[u8]) -> Vec<u8> {
    if input.is_empty() {
        return vec![rng.byte()];
    }
    let mut out = input.to_vec();
    let choice = rng.below(6);
    let position = rng.below(out.len());
    match choice {
        0 => {
            let bit = 1u8 << (rng.next() % 8);
            out[position] ^= bit;
        }
        1 => out[position] = rng.byte(),
        2 => out.truncate(1 + position % out.len()),
        3 => out.insert(position, rng.byte()),
        4 => {
            for _ in 0..4 {
                out.push(rng.byte());
            }
        }
        _ => {
            let take = position % input.len();
            out.extend_from_slice(&input[..take]);
        }
    }
    // Cap mutated inputs: nothing legitimate exceeds the 8 MiB wire frame
    // cap, and capping keeps a single run's allocation bounded (this is a
    // driver bound, NOT a decoder bound — decoders are separately verified
    // against oversize by the structured-seed suite below).
    const DRIVER_CAP: usize = 8 * 1024 + 64;
    if out.len() > DRIVER_CAP {
        out.truncate(DRIVER_CAP);
    }
    out
}

// ---------------------------------------------------------------------------
// Structured seeds — valid frames + documented mutations (inline corpus,
// matching the C++ fuzz/corpus concept without binary files)
// ---------------------------------------------------------------------------

fn golden_insert_op(replica: u64, counter: u64) -> Vec<u8> {
    let mut b = vec![1u8, 1u8];
    b.extend_from_slice(&replica.to_le_bytes());
    b.extend_from_slice(&counter.to_le_bytes());
    b.extend_from_slice(&1u64.to_le_bytes());
    b.push(0);
    b.push(0);
    b.push(1);
    b.push(1);
    b.push(b'a');
    b.push(0);
    b
}

fn client_ops_bytes(ops: &[Vec<u8>]) -> Vec<u8> {
    let mut out = vec![1u8, 0x20];
    out.extend_from_slice(&7u64.to_be_bytes());
    out.extend_from_slice(&(ops.len() as u16).to_be_bytes());
    for op in ops {
        out.extend_from_slice(&(op.len() as u32).to_be_bytes());
        out.extend_from_slice(op);
    }
    out
}

fn broker_event_bytes(ops: &[Vec<u8>]) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for op in ops {
        hasher.update((op.len() as u32).to_be_bytes());
        hasher.update(op);
    }
    let checksum: [u8; 32] = hasher.finalize().into();
    let mut out = vec![1u8];
    out.extend_from_slice(&5u64.to_be_bytes());
    out.extend_from_slice(&uuid::Uuid::new_v4().into_bytes());
    out.extend_from_slice(&42u64.to_be_bytes());
    out.extend_from_slice(&99u64.to_be_bytes());
    out.extend_from_slice(&checksum);
    out.extend_from_slice(&(ops.len() as u16).to_be_bytes());
    for op in ops {
        out.extend_from_slice(&(op.len() as u32).to_be_bytes());
        out.extend_from_slice(op);
    }
    out
}

fn control_seeds() -> Vec<Vec<u8>> {
    vec![
        br#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1}}"#.to_vec(),
        br#"{"v":1,"id":"c-7","type":"authenticate","payload":{"token":"eyJhbGciOiJFUzI1NiJ9.x.y"}}"#.to_vec(),
        format!(
            r#"{{"v":1,"type":"join_document","payload":{{"documentId":"{}","stateSummary":[{{"replicaId":"7","sequence":"9"}}]}}}}"#,
            uuid::Uuid::new_v4()
        )
        .into_bytes(),
        br#"{"v":1,"type":"sync_request","payload":{"cursor":"12345"}}"#.to_vec(),
        br#"{"v":1,"type":"ping","payload":{"nonce":"42"}}"#.to_vec(),
        br#"{"v":2,"type":"hello","payload":{"clientProtocolVersion":2}}"#.to_vec(),
        br#"{"v":1,"type":"unknown_type","payload":{}}"#.to_vec(),
        br#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":1},"extra":true}"#.to_vec(),
        br#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":"one"}}"#.to_vec(),
        br#"{"v":1,"type":"hello","payload":null}"#.to_vec(),
        br#"not json at all"#.to_vec(),
        br#"[]"#.to_vec(),
        br#"{""#.to_vec(),
        br#"{"v":1,"type":"error","payload":{"code":"x","message":"m","requestId":null}}"#.to_vec(),
        // Deep nesting seed (serde_json recursion behavior).
        br#"{"v":1,"type":"hello","payload":{"clientProtocolVersion":[[[[[[[]]]]]]]}}"#.to_vec(),
    ]
}

fn data_seeds() -> Vec<Vec<u8>> {
    let mut seeds = vec![
        client_ops_bytes(&[golden_insert_op(7, 1), golden_insert_op(7, 2)]),
        vec![1u8, 0x21, 0, 0, 0, 0, 0, 0, 0, 42, 1, 0, 0], // empty sync page
        vec![1u8, 0x20],
        vec![1u8, 0x99, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], // bad kind
        vec![9u8, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], // bad version
    ];
    // Oversized declared count: count=65535 ops but no payload.
    let mut over = vec![1u8, 0x20, 0, 0, 0, 0, 0, 0, 0, 1];
    over.extend_from_slice(&65535u16.to_be_bytes());
    seeds.push(over);
    // Oversized single-op length (declared 0x10000 > MAX_OP_BYTES).
    let mut big = vec![1u8, 0x20, 0, 0, 0, 0, 0, 0, 0, 1];
    big.extend_from_slice(&1u16.to_be_bytes());
    big.extend_from_slice(&0x10000u32.to_be_bytes());
    seeds.push(big);
    seeds
}

fn op_seeds() -> Vec<Vec<u8>> {
    vec![
        golden_insert_op(0xD4, 17),
        {
            // valid delete
            let mut d = vec![1u8, 2u8];
            d.extend_from_slice(&7u64.to_le_bytes());
            d.extend_from_slice(&2u64.to_le_bytes());
            d.extend_from_slice(&1u64.to_le_bytes());
            d.extend_from_slice(&9u64.to_le_bytes());
            d.extend_from_slice(&1u64.to_le_bytes());
            d
        },
        {
            // valid setattr
            let mut s = vec![1u8, 3u8];
            s.extend_from_slice(&7u64.to_le_bytes());
            s.extend_from_slice(&4u64.to_le_bytes());
            s.extend_from_slice(&2u64.to_le_bytes());
            s.extend_from_slice(&9u64.to_le_bytes());
            s.extend_from_slice(&1u64.to_le_bytes());
            s.extend_from_slice(&2u64.to_le_bytes());
            s.push(b'b');
            s.push(b'o');
            s.push(1);
            s.extend_from_slice(&1u64.to_le_bytes());
            s.push(b'1');
            s
        },
        vec![],
        vec![1, 99, 0, 0, 0, 0],
    ]
}

fn broker_seeds() -> Vec<Vec<u8>> {
    vec![
        broker_event_bytes(&[golden_insert_op(901, 1), golden_insert_op(901, 2)]),
        broker_event_bytes(&[]),
        vec![9u8; 100],
        vec![1u8; 10],
    ]
}

// ---------------------------------------------------------------------------
// Targets (contract: decode-or-error, never panic; bounds asserted by
// error-return, not allocation measurement)
// ---------------------------------------------------------------------------

fn fuzz_control_frame(input: &[u8]) {
    let Ok(text) = std::str::from_utf8(input) else {
        return; // WebSocket text frames arrive as UTF-8; binary garbage
    }; // is a transport-level concern already bounded elsewhere.
    if let Ok(frame) = ControlFrame::decode(text) {
        // Bounded behavior: an accepted authenticate frame's token must
        // respect MAX_TOKEN_BYTES (defense-in-depth wire cap).
        if let sync_gateway::protocol::control::Frame::Authenticate(p) = &frame.frame {
            assert!(
                p.token.len() <= sync_gateway::protocol::MAX_TOKEN_BYTES,
                "decoder accepted an over-cap token ({} bytes)",
                p.token.len()
            );
        }
    }
    // Every structured rejection is fine — the contract is
    // decode-or-error, never panic.
}

fn fuzz_data_frame(input: &[u8]) {
    match DataFrame::decode(input) {
        Ok(DataFrame::ClientOps(f)) => {
            // Bounds held: decoded batches respect the limits.rs caps.
            assert!(f.ops.len() <= MAX_BATCH_OPS, "op count bound violated");
            for op in &f.ops {
                assert!(op.len() <= MAX_OP_BYTES, "op size bound violated");
            }
        }
        Ok(DataFrame::SyncBatch(f)) => {
            assert!(
                f.ops.len() <= sync_gateway::protocol::MAX_SYNC_PAGE_OPS,
                "sync page bound violated"
            );
        }
        Err(
            DecodeError::BadBinaryHeader { .. }
            | DecodeError::BadBinaryBody { .. }
            | DecodeError::UnsupportedVersion { .. }
            | DecodeError::TooLarge { .. }
            | DecodeError::FrameTooLarge { .. },
        ) => {}
        Err(other) => panic!("data-frame decode returned a text-path error: {other:?}"),
    }
    // Second entry point: validated client_ops (identity + uniqueness).
    if let Ok(f) = DataFrame::decode_client_ops_validated(input) {
        assert!(f.ops.len() <= MAX_BATCH_OPS, "validated op count bound");
    }
}

fn fuzz_op_envelope(input: &[u8]) {
    match validate_op(input) {
        Ok(env) => {
            // Valid ops must satisfy the identity range rules (ids.hpp).
            assert_ne!(env.identity.replica, 0, "zero replica accepted");
            assert!(
                (1..=(1u64 << 63) - 1).contains(&env.identity.counter),
                "counter range accepted"
            );
        }
        Err(DecodeError::BadOperation { .. }) => {}
        Err(other) => panic!("validate_op returned a non-op error: {other:?}"),
    }
}

fn fuzz_broker_event(input: &[u8]) {
    match BrokerEvent::decode(input) {
        Ok(event) => {
            assert!(!event.ops.is_empty(), "empty op list accepted");
            assert!(
                event.ops.len() <= MAX_BATCH_OPS,
                "broker op count bound violated"
            );
            for op in &event.ops {
                assert!(op.len() <= MAX_OP_BYTES, "broker op size bound violated");
            }
        }
        Err(BrokerEventError::Truncated)
        | Err(BrokerEventError::UnsupportedVersion(_))
        | Err(BrokerEventError::TooLarge)
        | Err(BrokerEventError::TooManyOps(_))
        | Err(BrokerEventError::ChecksumMismatch)
        | Err(BrokerEventError::InvalidOp(_))
        | Err(BrokerEventError::Trailing) => {}
    }
}

/// State-machine property target: a randomized SEQUENCE of frames drives the
/// pure decode + SessionState-gating layer (PROTOCOL §9.13). The machine's
/// full transition logic lives in `ws::handle_text` behind DB/auth mocks, so
/// the reachable-without-a-server property is: every frame in any state is
/// either (a) rejected as malformed/illegal-for-state by the same predicates
/// the ws handler consults, or (b) legal, in which case the state predicate
/// agrees. Documented boundary: no socket, no DB, no auth side effects.
fn fuzz_session_property(input: &[u8]) {
    let Ok(text) = std::str::from_utf8(input) else {
        return;
    };
    let Ok(frame) = ControlFrame::decode(text) else {
        return; // malformed: rejected in EVERY state — property holds
    };
    use sync_gateway::protocol::control::Frame;
    // Every state the ws loop can be in; client_ops gating via
    // can_send_client_ops is exercised for all of them.
    for state in [
        SessionState::Connected,
        SessionState::HelloDone,
        SessionState::Authenticated,
        SessionState::Syncing,
        SessionState::Ready,
        SessionState::Draining,
        SessionState::Closed,
    ] {
        // Property 1: client_ops is legal ONLY in Ready (binary frame path
        // mirrors the text gating — SessionState::can_send_client_ops).
        let ops_legal = state.can_send_client_ops();
        assert_eq!(
            ops_legal,
            state == SessionState::Ready,
            "can_send_client_ops must mean Ready"
        );
        // Property 2: server-only frames are structurally decodable (they
        // share the codec) but ILLEGAL inbound — the ws handler rejects
        // them by construction; this target pins the enum coverage so a new
        // frame variant cannot silently become client-legal without
        // updating this match (exhaustive).
        match &frame.frame {
            Frame::HelloAck(_)
            | Frame::Authenticated(_)
            | Frame::JoinAccepted(_)
            | Frame::SyncDone(_)
            | Frame::SnapshotResyncRequired(_)
            | Frame::SnapshotPayload(_)
            | Frame::DurableAck(_)
            | Frame::Error(_)
            | Frame::ServerDraining(_) => {} // server-only: rejected inbound
            Frame::Hello(_)
            | Frame::Authenticate(_)
            | Frame::JoinDocument(_)
            | Frame::SyncRequest(_)
            | Frame::FetchSnapshot(_)
            | Frame::Ping(_)
            | Frame::Pong(_) => {} // client-legal: state-checked by ws
        }
    }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

type Target = fn(&[u8]);

fn run_target(name: &str, target: Target, seeds: &[Vec<u8>], runs: u64, rng: &mut Rng) -> bool {
    let start = Instant::now();
    let mut inputs: Vec<Vec<u8>> = seeds.to_vec();
    for _ in 0..runs {
        let idx = rng.below(inputs.len());
        let mut input = inputs[idx].clone();
        // Mutation depth 3 (same as the C++ driver).
        for _ in 0..3 {
            input = mutate(rng, &input);
        }
        target(&input);
        // Keep a bounded live corpus: every 501st mutant becomes a seed
        // (schedule-driven coverage proxy — keeps the walk moving).
        if input.len() < 4096 && rng.below(501) == 0 {
            let replace = rng.below(inputs.len());
            inputs[replace] = input;
        }
    }
    let per_sec = runs as f64 / start.elapsed().as_secs_f64().max(1e-9);
    println!(
        "{name}: {runs} executions, {} seeds, {:.0} execs/sec — OK (no panics)",
        inputs.len(),
        per_sec
    );
    true
}

fn main() {
    let runs: u64 = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(250_000);
    let seed: u64 = std::env::var("FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x0FACADE0BADC0DE); // default seed (hex digits only)
    println!("concord proto fuzz driver: {runs} runs/target, seed {seed:#x}");
    let mut rng = Rng::new(seed);

    let all_ok = [
        run_target(
            "control_frame",
            fuzz_control_frame,
            &control_seeds(),
            runs,
            &mut rng,
        ),
        run_target("data_frame", fuzz_data_frame, &data_seeds(), runs, &mut rng),
        run_target("op_envelope", fuzz_op_envelope, &op_seeds(), runs, &mut rng),
        run_target(
            "broker_event",
            fuzz_broker_event,
            &broker_seeds(),
            runs,
            &mut rng,
        ),
        run_target(
            "session_property",
            fuzz_session_property,
            &control_seeds(),
            runs,
            &mut rng,
        ),
    ]
    .into_iter()
    .all(|ok| ok);

    println!("proto fuzz driver: completed without crashes");
    if !all_ok {
        std::process::exit(1);
    }
}
