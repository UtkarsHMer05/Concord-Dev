// Builds the CRDT WASM module via Emscripten and stages the artifacts in
// wasm/dist/ (git-ignored). Run via: npm run wasm:build
import { execSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
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

// P7-M032 (final form): the browser worker is a CLASSIC worker that loads
// the glue via importScripts() — the UMD wrapper's GLOBAL arm defines
// window/self.loadConcordCrdt, which is exactly what importScripts
// consumes. ALL copies stay PURE UMD: an ESM `export` tail is a syntax
// error under importScripts (observed live) and invalid in the Node
// tooling's new Function(source) loader. No transformation needed.
console.log("WASM artifacts staged in wasm/dist/ and public/wasm/ (pure UMD)");
