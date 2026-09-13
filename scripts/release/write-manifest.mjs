#!/usr/bin/env node
// Write the deterministic, machine-readable release manifest.
//
// The manifest describes files already present in --dir. It deliberately
// excludes itself and SHA256SUMS to avoid a circular hash; SHA256SUMS covers
// the manifest after this command completes. A source archive may be gitless,
// so release identity is supplied explicitly by --commit/--tag when needed.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function usage(message) {
  if (message) console.error(`release manifest: ${message}`);
  console.error("usage: node scripts/release/write-manifest.mjs --dir DIR --commit SHA --tag TAG [--image-ref REF ...]");
  process.exit(2);
}

const args = process.argv.slice(2);
let dir = "release-artifacts";
let commit = process.env.GITHUB_SHA || "";
let tag = process.env.GITHUB_REF_NAME || "";
let protocolVersion = 1;
const imageRefs = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--dir") dir = args[++i] ?? usage("--dir needs a value");
  else if (arg === "--commit") commit = args[++i] ?? usage("--commit needs a value");
  else if (arg === "--tag") tag = args[++i] ?? usage("--tag needs a value");
  else if (arg === "--protocol-version") protocolVersion = Number(args[++i]);
  else if (arg === "--image-ref") imageRefs.push(args[++i] ?? usage("--image-ref needs a value"));
  else usage(`unknown option: ${arg}`);
}

const root = resolve(dir);
if (!existsSync(root) || !statSync(root).isDirectory()) usage(`artifact directory does not exist: ${root}`);
const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packageMetadata = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
if (!/^[0-9a-f]{40}$/i.test(commit)) {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  if (git.status === 0) commit = git.stdout.trim();
}
if (!/^[0-9a-f]{40}$/i.test(commit)) usage("--commit must be a full 40-character git SHA (required for a gitless archive)");
if (!tag) usage("--tag is required");
if (!Number.isInteger(protocolVersion) || protocolVersion < 1) usage("protocol version must be a positive integer");
const versionTag = tag.match(/^(?:concord-)?v(\d+\.\d+\.\d+)$/);
if (versionTag && versionTag[1] !== packageMetadata.version) {
  usage(`tag ${tag} does not match package version ${packageMetadata.version}`);
}

function filesUnder(current) {
  const entries = readdirSync(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function toolVersion(command, commandArgs = ["--version"]) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) return null;
  return `${result.stdout || result.stderr}`.trim().split("\n")[0] || null;
}

const allFiles = filesUnder(root)
  .map((path) => relative(root, path).split("\\").join("/"))
  .filter((path) => path !== "release-manifest.json" && path !== "SHA256SUMS")
  .sort();
if (allFiles.length === 0) usage("artifact directory contains no release files");

const entries = [];
for (const path of allFiles) {
  const absolute = join(root, path);
  entries.push({ path, sha256: await sha256(absolute), bytes: statSync(absolute).size });
}

const artifactEntries = entries.filter(({ path }) => !path.startsWith("sbom/"));
const sbomEntries = entries.filter(({ path }) => path.startsWith("sbom/"));
const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
const manifest = {
  manifestVersion: 1,
  project: "Concord",
  version: packageMetadata.version,
  gitCommit: commit.toLowerCase(),
  gitTag: tag,
  protocolVersion,
  ...(sourceDateEpoch && /^\d+$/.test(sourceDateEpoch)
    ? { buildTimestamp: new Date(Number(sourceDateEpoch) * 1000).toISOString() }
    : {}),
  reproducibility: {
    sourceDateEpoch: sourceDateEpoch && /^\d+$/.test(sourceDateEpoch) ? Number(sourceDateEpoch) : null,
    manifestExcludes: ["release-manifest.json", "SHA256SUMS"],
  },
  artifacts: artifactEntries,
  sbom: sbomEntries,
  containerImages: imageRefs.map((ref) => {
    const result = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", ref], { encoding: "utf8" });
    const imageId = result.status === 0 ? result.stdout.trim() : "";
    if (!imageId) usage(`docker image inspect failed for --image-ref ${ref}`);
    return { ref, imageId };
  }),
  toolchain: {
    node: toolVersion("node"),
    npm: toolVersion("npm"),
    cargo: toolVersion("cargo"),
    cmake: toolVersion("cmake"),
    cxx: toolVersion(process.env.CXX || "c++"),
  },
  checksumsFile: "SHA256SUMS",
};

writeFileSync(join(root, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`release manifest: ${join(root, "release-manifest.json")}`);
console.log(`release manifest: ${artifactEntries.length} artifacts, ${sbomEntries.length} SBOMs, commit ${manifest.gitCommit}, tag ${manifest.gitTag}`);
