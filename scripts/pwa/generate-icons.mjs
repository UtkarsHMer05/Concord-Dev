#!/usr/bin/env node
// Feature 8 — PWA icon generation (runs rsvg-convert, macOS homebrew).
//
// Renders src/app/icon.svg to the PNG sizes the web manifest needs. Run
// manually after changing the logo; the outputs ARE committed (they are
// static brand assets), but they are generated — never hand-edited:
//
//   node scripts/pwa/generate-icons.mjs
//
// Skips cleanly (exit 0, with a notice) when rsvg-convert is unavailable so
// contributors on machines without it are not blocked.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const SOURCE = path.join(REPO, "src", "app", "icon.svg");
const SIZES = [192, 512];

if (!existsSync(SOURCE)) {
  console.error(`icon source missing: ${SOURCE}`);
  process.exit(2);
}

let rsvg = null;
for (const candidate of ["/opt/homebrew/bin/rsvg-convert", "/usr/local/bin/rsvg-convert", "/usr/bin/rsvg-convert"]) {
  if (existsSync(candidate)) {
    rsvg = candidate;
    break;
  }
}
if (!rsvg) {
  console.error("rsvg-convert not found — install librsvg (brew install librsvg) and re-run.");
  process.exit(0);
}

for (const size of SIZES) {
  const target = path.join(REPO, "public", `icon-${size}.png`);
  execFileSync(rsvg, ["-w", String(size), "-h", String(size), SOURCE, "-o", target]);
  console.log(`wrote ${path.relative(REPO, target)}`);
}
