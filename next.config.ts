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
};

export default nextConfig;
