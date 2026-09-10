import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output: the P6-M027 release image runs `node server.js`
  // from the minimal standalone tree (no node_modules copy of build
  // toolchains). Dev/test flows (`next dev`, `next build && next start`)
  // are unaffected.
  output: "standalone",
  turbopack: {
    root: path.join(__dirname),
  },
  // P7-M027: baseline security headers on EVERY response (the staging
  // surface audit found them absent). CSP is deliberately PERMISSIVE,
  // v1-honestly: Clerk (script + iframe from the instance domain) and
  // Next's inline styles require these sources; the dangerous forms are
  // pinned (frame-ancestors none, object-src 'none', base-uri 'self').
  // connect-src allows ws:/wss: for the sync gateway (ALB DNS now; a
  // custom domain later). A nonce-based CSP is a documented follow-up.
  // P7-M033: 'wasm-unsafe-eval' added to script-src — WebAssembly compile/
  // instantiate is a script-src-gated capability in WebKit (and enforced in
  // newer Chromium); without it the CRDT worker's engine init rejects
  // (CompileError) and every session silently degrades to the Phase-1
  // REST mirror. This is the narrow, standard directive for wasm (it does
  // NOT open general eval), not a weakening of the policy.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' https://*.clerk.accounts.dev",
              "frame-src https://*.clerk.accounts.dev",
              "style-src 'self' 'unsafe-inline'",
              "connect-src 'self' https://*.clerk.accounts.dev ws: wss:",
              "img-src 'self' data: blob: https://*.clerk.accounts.dev",
              "font-src 'self' data:",
              "worker-src 'self' blob:",
              "child-src 'self' blob:",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
