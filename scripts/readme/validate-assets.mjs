// Validate the README's local images, links, accessibility labels, and
// credential/path hygiene before the presentation is committed.

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const README_PATH = path.join(ROOT, "README.md");
const readme = fs.readFileSync(README_PATH, "utf8");
const failures = [];

function localTarget(raw) {
  const withoutAnchor = raw.split("#", 1)[0].split("?", 1)[0];
  if (!withoutAnchor || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(withoutAnchor)) {
    return null;
  }
  return path.resolve(ROOT, withoutAnchor);
}

function checkExists(raw, kind) {
  const target = localTarget(raw);
  if (target && !fs.existsSync(target)) {
    failures.push(`${kind} target does not exist: ${raw}`);
  }
}

for (const match of readme.matchAll(/!\[([^\]]*)\]\(([^)]+)\)|(<img\b[^>]*>)/gi)) {
  const markdownAlt = match[1];
  const markdownSrc = match[2];
  const htmlTag = match[3] || "";
  const htmlSrc = htmlTag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
  const alt = markdownAlt ?? htmlTag.match(/\balt=["']([^"']*)["']/i)?.[1] ?? "";
  const src = markdownSrc ?? htmlSrc;
  if (!alt.trim()) failures.push(`image is missing alt text: ${src}`);
  checkExists(src, "image");
}

for (const match of readme.matchAll(/(?<!!)]\(([^)]+)\)/g)) {
  checkExists(match[1], "link");
}

const screenshotNames = [
  "dashboard.png",
  "hero-editor.png",
  "collaborative-a.png",
  "collaborative-b.png",
  "offline-state.png",
];
for (const name of screenshotNames) {
  const target = path.join(ROOT, "docs/assets/readme", name);
  if (!fs.existsSync(target)) failures.push(`required screenshot is missing: ${name}`);
}

for (const pattern of [
  /\/Users\//,
  /file:\/\//i,
  /\b(?:pk_(?:test|live)|sk_(?:test|live))_[A-Za-z0-9_-]+\b/,
  /\bCLERK_SECRET_KEY\s*=/,
  /\bDATABASE_URL\s*=/,
]) {
  if (pattern.test(readme)) failures.push(`README contains a prohibited private value/path pattern: ${pattern}`);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  const imageCount = [...readme.matchAll(/!\[[^\]]*\]\([^)]+\)|<img\b/gi)].length;
  const localLinks = [...readme.matchAll(/(?<!!)]\(([^)]+)\)/g)].filter((match) => localTarget(match[1])).length;
  console.log(`[readme] validated ${imageCount} images and ${localLinks} local links`);
}
