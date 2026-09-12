import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output: the P6-M027 release image runs `node server.js`
  // from the minimal standalone tree (no node_modules copy of build
  // toolchains). Dev/test flows (`next dev`, `next build && next start`)
  // are unaffected. Vercel builds set VERCEL=1 and manage their own
  // output format — standalone there only slows the build.
  ...(process.env.VERCEL ? {} : { output: "standalone" as const }),
  turbopack: {
    root: path.join(__dirname),
  },
  // P7-M027: baseline security headers on EVERY response (the staging
  // surface audit found them absent). CSP is NOT set here anymore: it is
  // generated per-request by src/proxy.ts (C2 hardening) with a nonce —
  // Clerk's middleware option produces it, stamps Clerk's scripts, and
  // mirrors nonce+CSP onto the request headers so Next 16 applies the
  // nonce to all framework/page scripts. A static CSP here would be
  // strictly weaker (no nonce, and 'unsafe-inline' to survive hydration).
  // The headers below apply to every response including static assets
  // (the middleware matcher skips those; they carry no HTML surface).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
