// Bundles the CRDT worker into ONE self-contained ES module at
// public/crdt-worker.js (P7-M032). Run via: npm run worker:bundle
//
// WHY: Turbopack's worker chunking resolves its otherChunks list with a
// page-relative base that 404s inside the worker context on nested routes
// (…/documents/<id> — observed live on production: the worker bootstrap
// loads, its chunk fetch double-prefixes to /_next/static/chunks/static/
// chunks/… and 404s, the init RPC never answers, the bridge stalls idle).
// A pre-bundled static worker file with an ABSOLUTE URL (/crdt-worker.js)
// is bundler-runtime-free: no chunk graph, no base resolution, correct on
// every route in every deployment.
//
// esbuild resolves the relative ./idb / ./core / ./protocol imports and
// inlines them; the worker itself loads the WASM glue via importScripts()
// and the binary via fetch() from /wasm/ at RUNTIME (absolute same-origin
// URLs, CSP-clean). CLASSIC worker format: module workers proved
// unreliable in the embedded-WebView browser used for E2E (silently
// dropping all messages; classic workers verified working), and
// importScripts is the classic-worker standard loader.
// The zod schema in protocol.ts must NOT be bundled (it is server-side
// validation of the SAME wire shapes) — protocol.ts imports nothing
// zod-side for the worker surface; verify with the type import.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { build } = require(require.resolve("esbuild", { paths: [process.cwd() + "/node_modules/tsx/node_modules"] }));
import path from "node:path";

const root = process.cwd();
const result = await build({
  entryPoints: [path.join(root, "src/lib/crdt/worker/crdt-worker.ts")],
  bundle: true,
  format: "iife",
  target: "es2022",
  outfile: path.join(root, "public/crdt-worker.js"),
  minify: true,
  legalComments: "none",
  logLevel: "info",
});
if (result.errors.length > 0) {
  process.exit(1);
}
console.log("worker bundled → public/crdt-worker.js (serve at /crdt-worker.js)");
