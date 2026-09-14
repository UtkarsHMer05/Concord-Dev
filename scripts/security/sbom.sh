#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Concord SBOM generator (P6-M026).
#
# Generates CycloneDX 1.5 SBOMs for every shipped component into
# scripts/sbom/ (the release-candidate inventory, committed once):
#
#   web.cdx.json          Next.js web app — npm 11 built-in `npm sbom`
#                         (CycloneDX; --omit dev: production tree only).
#   rust-gateway.cdx.json Rust sync-gateway — deterministic CycloneDX
#                         generated from Cargo.lock by this script
#                         (name/version/licenses; method documented in
#                         the SBOM's own metadata — honest and
#                         reproducible; no network, no tool drift).
#   native-worker.cdx.json C++ concord-worker + WASM CRDT core — no
#                         third-party deps (verified in P6-M025), so the
#                         manifest is hand-authored here listing the
#                         components + toolchains (clang/cmake/ninja/
#                         emcc versions from scripts/bench/capture-env.mjs).
#
# DETERMINISM (the M026 acceptance):
#   - npm sbom output is normalized: the `serialNumber` (a random UUID)
#     and `metadata.timestamp` are replaced with fixed values so the
#     same package-lock + same node_modules tree produces byte-identical
#     output on every run. Component order from npm is already
#     deterministic for a given lockfile.
#   - The Rust SBOM is generated from Cargo.lock with a fixed component
#     order (alphabetical) and fixed metadata — same lockfile → same SBOM.
#   - The native manifest carries toolchain versions which change only
#     when the toolchain changes (that is exactly the drift an SBOM
#     should surface).
#
# Regenerate:
#   bash scripts/security/sbom.sh
#
# Validate: every output parses as JSON (python3 json.tool) and
# scripts/security/secret-scan.sh scans scripts/sbom/ clean (SBOMs
# contain package names/versions/licenses only — never secrets).
#
# NO secrets in any SBOM by construction: the inputs are
# package-lock.json, Cargo.lock, and `--version` strings.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT/scripts/sbom"
mkdir -p "$OUT_DIR"

# Fixed normalization values (determinism): a nil/fixed serial and a
# build epoch pinned to the release-candidate generation date.
FIXED_SERIAL="urn:uuid:00000000-0000-4000-8000-000000000000"
FIXED_TIMESTAMP="2026-09-09T00:00:00.000Z"

log() { printf '[sbom] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# VERSION WIRING: package.json "version" is the ONE authoritative release
# version. It is read once here (with node, so no manual JSON parsing) and
# threaded into every generated SBOM (rust-gateway + native-worker metadata
# components). Do NOT bump an SBOM's embedded version by hand — regenerate:
#   bash scripts/security/sbom.sh
# package.json keeps the same 1.0.1 identity as rust/Cargo.toml's
# workspace.package.version and cpp/CMakeLists.txt's project VERSION (the
# three are the release trio; the wire protocol version is a separate
# constant and never tracks this).
# ---------------------------------------------------------------------------
CONCORD_VERSION="$(node -p "require('./package.json').version")" || {
  echo "sbom: cannot read version from package.json (is node on PATH?)" >&2
  exit 1
}
case "$CONCORD_VERSION" in
  ''|*[!0-9.]*) echo "sbom: invalid package.json version '$CONCORD_VERSION'" >&2; exit 1 ;;
esac
log "release version: $CONCORD_VERSION (from package.json)"

# ---------------------------------------------------------------------------
# 1. Web (npm) — `npm sbom` (CycloneDX), normalized for determinism.
# ---------------------------------------------------------------------------
generate_web() {
  log "web: npm sbom (CycloneDX, production tree)"
  cd "$ROOT"
  npm sbom --sbom-format cyclonedx --omit dev --package-lock-only >/dev/null 2>&1 \
    || npm sbom --sbom-format cyclonedx --omit dev > "$OUT_DIR/web.cdx.json"
  # Prefer the lockfile-only mode when supported (it needs no
  # node_modules); fall back to the on-disk tree.
  if npm sbom --sbom-format cyclonedx --omit dev --package-lock-only >/dev/null 2>&1; then
    npm sbom --sbom-format cyclonedx --omit dev --package-lock-only > "$OUT_DIR/web.cdx.json.tmp"
  else
    npm sbom --sbom-format cyclonedx --omit dev > "$OUT_DIR/web.cdx.json.tmp"
  fi
  python3 - "$OUT_DIR/web.cdx.json.tmp" "$OUT_DIR/web.cdx.json" <<'PY'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    bom = json.load(f)
# Determinism normalization: strip the two nondeterministic fields.
bom["serialNumber"] = "urn:uuid:00000000-0000-4000-8000-000000000000"
bom["metadata"]["timestamp"] = "2026-09-09T00:00:00.000Z"
# Document the normalization inside the SBOM itself.
bom["metadata"]["properties"] = bom["metadata"].get("properties", []) + [
    {
        "name": "concord:sbom:normalization",
        "value": (
            "serialNumber and metadata.timestamp are fixed by "
            "scripts/security/sbom.sh for byte-for-byte determinism; "
            "regenerating from the same package-lock.json yields "
            "identical output"
        ),
    }
]
with open(dst, "w") as f:
    json.dump(bom, f, indent=2, sort_keys=False)
    f.write("\n")
PY
  rm -f "$OUT_DIR/web.cdx.json.tmp"
  log "web: $(python3 -c "import json;print(len(json.load(open('$OUT_DIR/web.cdx.json'))['components']))") components"
}

# ---------------------------------------------------------------------------
# 2. Rust gateway — deterministic CycloneDX from Cargo.lock.
# ---------------------------------------------------------------------------
generate_rust() {
  log "rust-gateway: CycloneDX from Cargo.lock (deterministic generator)"
  python3 - "$ROOT/rust/Cargo.lock" "$OUT_DIR/rust-gateway.cdx.json" "$FIXED_SERIAL" "$FIXED_TIMESTAMP" "$CONCORD_VERSION" <<'PY'
import json, sys, hashlib
from collections import OrderedDict

lock_path, out_path, serial, timestamp, concord_version = (
    sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
)

# Best-effort license resolution from the local cargo registry cache:
# crates ship their license in Cargo.toml (license field). This is
# offline and deterministic for a given Cargo.lock + registry cache;
# crates with no license in the cache are reported with NO license
# (honest absence, never a guess).
import os, re, tomllib

def crate_license(name, version):
    home = os.environ.get("CARGO_HOME", os.path.expanduser("~/.cargo"))
    toml_path = os.path.join(
        home, "registry", "cache", "*", f"{name}-{version}.crate"
    )
    # Prefer the extracted src (fast path used by cargo):
    src_paths = [
        p
        for p in __import__("glob").glob(
            os.path.join(home, "registry", "src", "*", f"{name}-{version}", "Cargo.toml")
        )
    ]
    if not src_paths:
        return None
    try:
        with open(src_paths[0], "rb") as f:
            meta = tomllib.load(f)
        lic = meta.get("package", {}).get("license")
        if lic:
            return lic
        return None
    except Exception:
        return None

packages = []
cur = {}
with open(lock_path) as f:
    for line in f:
        line = line.rstrip("\n")
        if line == "[[package]]":
            if cur:
                packages.append(cur)
            cur = {}
        elif line.startswith("name = "):
            cur["name"] = line.split("= ", 1)[1].strip('"')
        elif line.startswith("version = ") and "version" not in cur:
            cur["version"] = line.split("= ", 1)[1].strip('"')
        elif line.startswith("source = "):
            cur["source"] = line.split("= ", 1)[1].strip('"')
if cur:
    packages.append(cur)

# Deterministic order: alphabetical by (name, version).
# Root workspace packages carry a `name`; every package always has one.
packages = [p for p in packages if p.get("name")]
packages.sort(key=lambda p: (p["name"], p.get("version", "")))

components = []
for p in packages:
    name, version = p["name"], p.get("version", "0")
    comp = OrderedDict()
    comp["type"] = "library"
    comp["bom-ref"] = f"pkg:cargo/{name}@{version}"
    comp["name"] = name
    comp["version"] = version
    if p.get("source", "").startswith("registry"):
        comp["purl"] = f"pkg:cargo/{name}@{version}"
    lic = crate_license(name, version)
    if lic:
        comp["licenses"] = [{"license": {"id" if re.fullmatch(r"[A-Za-z0-9.]+", lic.split(" OR ")[0]) else "name": lic.split(" OR ")[0]}}]
    components.append(comp)

bom = OrderedDict()
bom["$schema"] = "http://cyclonedx.org/schema/bom-1.5.schema.json"
bom["bomFormat"] = "CycloneDX"
bom["specVersion"] = "1.5"
bom["serialNumber"] = serial
bom["version"] = 1
metadata = OrderedDict()
metadata["timestamp"] = timestamp
metadata["tools"] = [
    {
        "vendor": "Concord",
        "name": "scripts/security/sbom.sh (Cargo.lock parser)",
        "version": concord_version,
    }
]
metadata["component"] = {
    "type": "application",
    "bom-ref": f"pkg:generic/concord-sync-gateway@{concord_version}",
    "name": "concord-sync-gateway",
    "version": concord_version,
    "purl": f"pkg:generic/concord-sync-gateway@{concord_version}",
    "description": "Concord Rust sync-gateway (workspace crate set)",
}
metadata["properties"] = [
    {
        "name": "concord:sbom:method",
        "value": (
            "Generated deterministically from rust/Cargo.lock by "
            "scripts/security/sbom.sh: package names + versions from the "
            "lockfile, licenses best-effort resolved OFFLINE from the "
            "local cargo registry cache (crates without a cached "
            "Cargo.toml carry no license — honest absence, never a "
            "guess). This is a lockfile-derived inventory, not a "
            "cargo-cyclonedx build scan; regenerating from the same "
            "Cargo.lock yields identical output."
        ),
    }
]
bom["metadata"] = metadata
bom["components"] = components

with open(out_path, "w") as f:
    json.dump(bom, f, indent=2)
    f.write("\n")
print(f"rust: {len(components)} components", file=sys.stderr)
PY
}

# ---------------------------------------------------------------------------
# 3. Native worker + WASM — hand-authored manifest (no third-party deps,
#    verified in P6-M025: cpp/ CMake uses no FetchContent/ExternalProject/
#    find_package of externals — C++20 stdlib only).
# ---------------------------------------------------------------------------
generate_native() {
  log "native-worker + wasm: hand-authored CycloneDX manifest"
  python3 - "$OUT_DIR/native-worker.cdx.json" "$FIXED_SERIAL" "$FIXED_TIMESTAMP" "$CONCORD_VERSION" <<'PY'
import json, sys, subprocess, os
from collections import OrderedDict

out_path, serial, timestamp, concord_version = (
    sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4],
)
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(out_path))))

def tool_version(cmd, args):
    try:
        out = subprocess.run([cmd, *args], capture_output=True, text=True, timeout=15)
        line = (out.stdout or out.stderr).strip().splitlines()
        return line[0].strip() if line else None
    except Exception:
        return None

clang = tool_version("clang", ["--version"])
cmake = tool_version("cmake", ["--version"])
ninja = tool_version("ninja", ["--version"])
emcc = tool_version("emcc", ["--version"])

bom = OrderedDict()
bom["$schema"] = "http://cyclonedx.org/schema/bom-1.5.schema.json"
bom["bomFormat"] = "CycloneDX"
bom["specVersion"] = "1.5"
bom["serialNumber"] = serial
bom["version"] = 1

metadata = OrderedDict()
metadata["timestamp"] = timestamp
metadata["tools"] = [
    {"vendor": "Concord", "name": "scripts/security/sbom.sh (hand-authored manifest)", "version": concord_version}
]
metadata["properties"] = [
    {
        "name": "concord:sbom:method",
        "value": (
            "Hand-authored manifest: the C++ CRDT core, concord-worker, "
            "and the WASM build vendor ZERO third-party dependencies "
            "(verified in P6-M025 — cpp/*/CMakeLists.txt use no "
            "FetchContent/ExternalProject/find_package of externals; "
            "C++20 standard library only), so the SBOM surface is the "
            "components themselves plus the build toolchains. Toolchain "
            "versions are captured at generation time via --version "
            "(mirrors scripts/bench/capture-env.mjs)."
        ),
    }
]
bom["metadata"] = metadata

components = [
    {
        "type": "application",
        "bom-ref": f"pkg:generic/concord-worker@{concord_version}",
        "name": "concord-worker",
        "version": concord_version,
        "description": "C++ native snapshot/restore worker (cpp/worker): C++20 stdlib only, no third-party libraries",
        "purl": f"pkg:generic/concord-worker@{concord_version}",
        "licenses": [{"license": {"name": "MIT"}}],
    },
    {
        "type": "library",
        "bom-ref": f"pkg:generic/concord-crdt-cpp@{concord_version}",
        "name": "concord-crdt-cpp",
        "version": concord_version,
        "description": "C++ CRDT core (cpp/crdt): header+impl C++20 stdlib only, no third-party libraries",
        "purl": f"pkg:generic/concord-crdt-cpp@{concord_version}",
        "licenses": [{"license": {"name": "MIT"}}],
    },
    {
        "type": "library",
        "bom-ref": f"pkg:generic/concord-crdt-wasm@{concord_version}",
        "name": "concord-crdt-wasm",
        "version": concord_version,
        "description": (
            "WASM build of the SAME C++ CRDT core (wasm/): compiled with "
            "the Emscripten toolchain; identical source to the native "
            "component, browser-side replica engine"
        ),
        "purl": f"pkg:generic/concord-crdt-wasm@{concord_version}",
        "licenses": [{"license": {"name": "MIT"}}],
    },
]

# Toolchain components (build metadata — the actual native audit surface
# per P6-M025: the toolchain IS the dependency).
if clang:
    components.append(
        {
            "type": "framework",
            "bom-ref": "pkg:generic/clang-toolchain",
            "name": "clang-toolchain",
            "version": clang,
            "description": "C/C++ compiler used for native builds (build-time dependency)",
        }
    )
if cmake:
    components.append(
        {
            "type": "framework",
            "bom-ref": "pkg:generic/cmake-build-system",
            "name": "cmake-build-system",
            "version": cmake,
            "description": "Native build generator (build-time dependency)",
        }
    )
if ninja:
    components.append(
        {
            "type": "framework",
            "bom-ref": "pkg:generic/ninja-build-runner",
            "name": "ninja-build-runner",
            "version": ninja,
            "description": "Build runner for native + WASM builds (build-time dependency)",
        }
    )
if emcc:
    components.append(
        {
            "type": "framework",
            "bom-ref": "pkg:generic/emscripten-toolchain",
            "name": "emscripten-toolchain",
            "version": emcc,
            "description": "Emscripten toolchain for the WASM CRDT build (build-time dependency)",
        }
    )

bom["components"] = components
with open(out_path, "w") as f:
    json.dump(bom, f, indent=2)
    f.write("\n")
print(f"native: {len(components)} components", file=sys.stderr)
PY
}

# ---------------------------------------------------------------------------
# Validation: every SBOM parses; JSON parse proof printed per file.
# ---------------------------------------------------------------------------
validate() {
  local failed=0
  for f in "$OUT_DIR"/*.cdx.json; do
    if python3 -m json.tool "$f" >/dev/null 2>&1; then
      log "validate: $(basename "$f") parses as JSON ($(python3 -c "import json;print(len(json.load(open('$f')).get('components',[])))") components)"
    else
      log "validate: $(basename "$f") FAILED to parse"
      failed=1
    fi
  done
  if command -v bash >/dev/null && [ -x "$ROOT/scripts/security/secret-scan.sh" ]; then
    log "secret-scan against scripts/sbom/ ..."
    if (cd "$ROOT" && bash scripts/security/secret-scan.sh) >/dev/null 2>&1; then
      log "secret-scan: clean"
    else
      log "secret-scan reported findings (inspect: bash scripts/security/secret-scan.sh)"
      failed=1
    fi
  fi
  return $failed
}

case "${1:-all}" in
  web) generate_web ;;
  rust) generate_rust ;;
  native) generate_native ;;
  all)
    generate_web
    generate_rust
    generate_native
    validate
    log "done: scripts/sbom/{web,rust-gateway,native-worker}.cdx.json"
    ;;
  validate) validate ;;
  *)
    echo "Usage: bash scripts/security/sbom.sh [web|rust|native|all|validate]"
    exit 2
    ;;
esac
