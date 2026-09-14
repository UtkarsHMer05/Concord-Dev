#!/usr/bin/env node
// Stage the generated Next standalone server exactly as the production image
// expects it. `next build` emits `.next/standalone/server.js`, but static and
// public assets remain siblings in the repository's `.next`/`public` trees.
import fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "../..");

export function stageStandalone(root = ROOT) {
  const standaloneDir = path.join(root, ".next", "standalone");
  const server = path.join(standaloneDir, "server.js");
  const staticDir = path.join(root, ".next", "static");
  const publicDir = path.join(root, "public");

  if (!fs.existsSync(server)) {
    throw new Error("standalone Next server missing; run npm run build first");
  }
  if (!fs.existsSync(staticDir)) {
    throw new Error(".next/static missing; run npm run build first");
  }
  if (!fs.existsSync(publicDir)) {
    throw new Error("public directory missing; restore the application public assets first");
  }

  fs.mkdirSync(path.join(standaloneDir, ".next"), { recursive: true });
  fs.cpSync(staticDir, path.join(standaloneDir, ".next", "static"), {
    recursive: true,
    force: true,
  });
  fs.cpSync(publicDir, path.join(standaloneDir, "public"), {
    recursive: true,
    force: true,
  });
  return server;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  stageStandalone();
}
