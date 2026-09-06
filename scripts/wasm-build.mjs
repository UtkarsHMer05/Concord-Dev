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
console.log("WASM artifacts staged in wasm/dist/");
