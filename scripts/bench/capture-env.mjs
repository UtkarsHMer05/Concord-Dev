#!/usr/bin/env node
// P6-M006 — Benchmark environment capture.
//
// Emits a JSON environment snapshot that every benchmark run must carry
// (prompt §8: commit, hardware/OS, build mode, toolchain, service versions).
// Also mints a unique run ID. Output goes to stdout (or --out FILE).
//
// Usage:
//   node scripts/bench/capture-env.mjs [--out FILE] [--label my-benchmark]
//
// The snapshot is written into each result JSON produced by the harnesses
// (M007 schema `environment` block). Raw run artifacts live under the
// git-ignored .agent/bench/runs/<runId>/.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

function sh(cmd, args = []) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

function shTrim(cmd, args = []) {
  const out = sh(cmd, args);
  return out ? out.split("\n")[0].trim() : null;
}

const argList = process.argv.slice(2);
const outIdx = argList.indexOf("--out");
const outPath = outIdx >= 0 ? argList[outIdx + 1] : null;
const labelIdx = argList.indexOf("--label");
const label = labelIdx >= 0 ? argList[labelIdx + 1] : "unlabeled";

const git = (sub) => sh("git", ["-C", path.resolve(import.meta.dirname, "..", ".."), ...sub.split(" ")]);

const now = new Date();
const runId = `run-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const env = {
  schema: "concord.bench.env/1",
  runId,
  label,
  capturedAt: now.toISOString(),
  git: {
    commit: git("rev-parse HEAD"),
    branch: git("rev-parse --abbrev-ref HEAD"),
    dirty: (git("status --porcelain") || "").length > 0,
    phaseTag: shTrim("git", ["-C", path.resolve(import.meta.dirname, "..", ".."), "describe", "--tags", "--abbrev=0"]) || null,
  },
  os: {
    platform: process.platform,
    release: sh("uname", ["-r"]),
    version: sh("sw_vers", ["-productVersion"]) || null,
    arch: process.arch,
  },
  hardware: {
    model: shTrim("sysctl", ["-n", "hw.model"]) || null,
    cpuModel: shTrim("sysctl", ["-n", "machdep.cpu.brand_string"]) || null,
    cores: Number(shTrim("sysctl", ["-n", "hw.ncpu"]) || 0) || null,
    memTotalBytes: (() => {
      const m = shTrim("sysctl", ["-n", "hw.memsize"]);
      return m ? Number(m) : null;
    })(),
  },
  toolchains: {
    node: shTrim("node", ["--version"]),
    npm: shTrim("npm", ["--version"]),
    rustc: shTrim("rustc", ["--version"]),
    cargo: shTrim("cargo", ["--version"]),
    clang: shTrim("clang", ["--version"]),
    cmake: shTrim("cmake", ["--version"]),
    ninja: shTrim("ninja", ["--version"]),
    emcc: shTrim("emcc", ["--version"]),
    docker: shTrim("docker", ["--version"]),
    dockerCompose: shTrim("docker", ["compose", "version", "--short"]),
  },
  services: {
    postgres: sh("docker", ["exec", "concord-db", "postgres", "--version"])?.trim() || null,
    nats: (() => {
      const v = sh("docker", ["exec", "concord-nats", "nats-server", "--version"]);
      return v ? v.trim().split("\n")[0] : null;
    })(),
    redis: shTrim("docker", ["exec", "concord-redis", "redis-server", "--version"]) || null,
  },
  buildMode: "release (CMAKE_BUILD_TYPE=Release; cargo --release)",
  notes: [],
};

const json = JSON.stringify(env, null, 2);
if (outPath) {
  writeFileSync(outPath, json, "utf8");
  process.stderr.write(`environment snapshot written: ${outPath}\nrunId: ${runId}\n`);
} else {
  process.stdout.write(json + "\n");
}
