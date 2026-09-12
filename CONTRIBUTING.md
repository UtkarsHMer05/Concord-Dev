# Contributing to Concord

Concord is a systems-engineering project: a local-first collaborative
document editor with an original synchronization stack (C++20 sequence
CRDT compiled native+WASM, TypeScript local-first runtime, Rust/Tokio
sync gateways, PostgreSQL durability, NATS JetStream fanout, Redis
ephemeral state). Contributions are welcome — this document explains the
setup, the quality gates, and the expectations.

Before writing code, skim the architecture map:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then the doc index
[docs/README.md](docs/README.md) for the deep dive relevant to your
change.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 24.20.0 | pinned by [.nvmrc](.nvmrc); `nvm use` |
| Docker + Compose | recent | PostgreSQL 18.6, NATS 2.11, Redis 8.8, Prometheus, Grafana via [docker-compose.yml](docker-compose.yml) |
| CMake ≥ 3.24 + Ninja | 4.x | native C++20 core and worker ([cpp/](cpp)) |
| Rust | 1.98.1 | pinned by `rust/rust-toolchain.toml`; sync gateway ([rust/](rust)) |
| Emscripten | 6.0.9 | WASM build of the same C++ core (`npm run wasm:build`) |

On macOS the Homebrew GCC 15 toolchain also works for the native core
(both GCC and Apple Clang are CI-verified).

## Setup

```bash
git clone https://github.com/UtkarsHMer05/Concord-Dev.git
cd Concord-Dev
nvm use                    # Node 24 (.nvmrc)
npm ci                     # clean install from the lockfile
docker compose up -d db    # PostgreSQL 18 on localhost:5433
cp .env.example .env.local  # then fill Clerk keys + DATABASE_URL
npm run db:migrate
```

`.env.local` is git-ignored and holds your secrets. The full variable
contract (every variable, its scope, and its failure mode) is
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) — start there, and never
commit real secrets. Realtime development additionally needs
`docker compose up -d db nats redis` and a release gateway build (see
below).

## The local gate list

CI runs a subset of these (`.github/workflows/phase6-pr-ci.yml`); the
full local gate is stronger. All commands run from the repository root.

### Web / TypeScript

```bash
npm run typecheck     # tsc --noEmit (strict)
npm run lint          # eslint (flat config)
npm test              # web unit suites (vitest, project "unit")
npm run test:db       # PostgreSQL integration (isolated concord_test DB,
                      #   migrations replayed from empty every run)
npm run test:realtime # real gateways over real WebSockets (needs db + release build)
npm run test:all      # unit + db
npm run build         # production build
```

### Native CRDT core (C++20)

```bash
./scripts/verify-native.sh           # configure + build + full native suite
./scripts/verify-native.sh Release   # same, optimized (CI parity)
```

### WASM / browser parity

```bash
./scripts/verify-wasm.sh   # Emscripten build + smoke + tests/crdt suites
```

### Rust sync gateway

```bash
cd rust
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
cargo test --test db_integration -- --test-threads=1   # shared test DB: serialize
cargo test --test ws_integration -- --test-threads=1
```

Sanitizer, fuzz, chaos, and benchmark gates exist beyond these
(as described in [docs/TESTING.md](docs/TESTING.md)); run them when your
change touches the relevant surface.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/) with a
scope, matching the existing log (`git log --oneline`):

```
feat(gateway): bounded inbound queue
fix(native): direct <algorithm> include for GCC
security(auth): enforce configured Clerk audience
docs(benchmarks): record Phase 6 campaign numbers
ci(pr): pin actions to commit SHAs
chore(provenance): replace inherited artwork
```

Types in use: `feat`, `fix`, `security`, `perf`, `test`, `docs`, `ci`,
`style`, `refactor`, `chore`. Scope names the area (`gateway`, `native`,
`wasm`, `web`, `sync`, `auth`, `ci`, `benchmarks`, …).

## Branches and pull requests

- Work on a branch (e.g. `codex/<topic>` or `phase/<id>`); never commit
  directly to `main`.
- Open a PR against `main`. The template asks for a summary, change
  type, testing evidence, and a checklist (tests added, no secrets, docs
  updated, CHANGELOG entry).
- `phase6-pr-ci` must pass (web, rust, native, wasm, security jobs);
  CodeQL runs on the PR too.

## Testing expectations

- **New behavior needs a test.** Suites are deterministic by design —
  seeded where randomness is involved. See
  [docs/TESTING.md](docs/TESTING.md) for where each kind of change is
  tested.
- **Security fixes need a regression test that pins the vulnerability**:
  the test should fail against the unfixed code and pass after the fix
  (see `rust/sync-gateway/tests/protocol_fuzz_regressions.rs` for the
  house pattern — the pinned FUZZ-2026-09-001 broker panic fix).
- Claims about performance require reproducible before/after measurement
  (DEC-011 in [docs/DECISIONS.md](docs/DECISIONS.md)) — do not state
  numbers you did not measure under a recorded environment.
- Honest negative results are welcome: a documented gap beats a silent
  one (the verification discipline is
  [docs/VERIFICATION.md](docs/VERIFICATION.md)).

## Security issues

Do **not** open a public issue for security vulnerabilities. Report them
privately per [SECURITY.md](SECURITY.md). The full threat model is
[docs/SECURITY.md](docs/SECURITY.md).

## Architecture map

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the system and its
  trust/storage boundaries
- [docs/README.md](docs/README.md) — index of every deep dive
  (protocol, consistency, storage, recovery, security, benchmarks, …)
- [docs/DECISIONS.md](docs/DECISIONS.md) — why things are the way they
  are (DEC-001…DEC-050)

## License

By contributing, you agree your contributions are licensed under the
MIT License ([LICENSE](LICENSE)). If your change touches anything
derived from the tutorial baseline, read
[docs/PROVENANCE.md](docs/PROVENANCE.md) first — replacement over risky
redistribution is the rule.
