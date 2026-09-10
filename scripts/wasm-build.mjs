// Builds the CRDT WASM module via Emscripten and stages the artifacts in
// wasm/dist/ (git-ignored). Run via: npm run wasm:build
import { execSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const buildDir = path.join(root, "build/wasm");

execSync(
  "emcmake cmake -S wasm -B build/wasm -G Ninja -DCMAKE_BUILD_TYPE=Release",
  { stdio: "inherit" },
);
execSync("cmake --build build/wasm", { stdio: "inherit" });
mkdirSync(path.join(root, "wasm/dist"), { recursive: true });
cpSync(path.join(buildDir, "concord-crdt.js"), path.join(root, "wasm/dist/concord-crdt.js"));
cpSync(path.join(buildDir, "concord-crdt.wasm"), path.join(root, "wasm/dist/concord-crdt.wasm"));
// Serve path: the worker fetches the module as a static asset from /wasm/.
mkdirSync(path.join(root, "public/wasm"), { recursive: true });
cpSync(path.join(buildDir, "concord-crdt.js"), path.join(root, "public/wasm/concord-crdt.js"));
cpSync(path.join(buildDir, "concord-crdt.wasm"), path.join(root, "public/wasm/concord-crdt.wasm"));

// P7-M032: Emscripten emits a UMD wrapper (module.exports / define / global).
// The BROWSER worker loads the glue via dynamic import() — in an ESM
// context NONE of the UMD arms match, so the module has NO default export
// and `.default` is undefined ("n is not a function" in the minified
// worker, observed live). ONLY the public/wasm copy (browser-served) gets
// the ESM export tail: the wasm/dist copy stays pure UMD because Node
// test tooling loads it via new Function(source) — `export` is invalid in
// a Function body (the naive dual-format file broke the whole crdt suite).
for (const dir of ["public/wasm"]) {
  const file = path.join(root, dir, "concord-crdt.js");
  const marker = "export default loadConcordCrdt;";
  const current = execSync(`tail -c 200 "${file}"`).toString();
  if (!current.includes(marker)) {
    appendFileSync(file, `\n// P7-M032: ESM surface for the browser worker's dynamic import().\n${marker}\n`);
  }
}
console.log("WASM artifacts staged in wasm/dist/ (UMD, Node tooling) and public/wasm/ (ESM-exported glue, browser)");
