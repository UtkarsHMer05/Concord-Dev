import { clerkMiddleware } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Origin allowlist for Clerk sessions (C1 hardening).
// An exact origin is supplied by the cloud bundle. Keep local development
// compatible with its own Clerk instance until a local origin is configured.
// ---------------------------------------------------------------------------
function parseTlsRequirement(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new Error("CONCORD_REQUIRE_TLS must be exactly 0 or 1 when set");
}

function parseAppOrigin(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  try {
    const parsed = new URL(value);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.origin !== value ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error("not an exact HTTP(S) origin");
    }
    return parsed.origin;
  } catch {
    throw new Error(
      "CONCORD_APP_ORIGIN must be an exact http(s) origin without credentials, a path, query, or fragment",
    );
  }
}

const requireTls = parseTlsRequirement(process.env.CONCORD_REQUIRE_TLS);
const appOrigin = parseAppOrigin(process.env.CONCORD_APP_ORIGIN);

if (requireTls && (!appOrigin || !appOrigin.startsWith("https://"))) {
  throw new Error(
    "CONCORD_APP_ORIGIN must be an exact HTTPS origin when CONCORD_REQUIRE_TLS=1",
  );
}

// ---------------------------------------------------------------------------
// Nonce-based Content-Security-Policy (C2 hardening).
//
// Next.js 16 calls this file convention `proxy.ts`. It generates a fresh
// nonce per request, builds the policy, and sets it on BOTH the request
// headers (Next stamps the nonce onto framework/page script tags) and the
// response (the browser enforcement header).
// ---------------------------------------------------------------------------

/** Dev-instance domains serve Clerk avatars; production serves from self. */
const CLERK_DEV_IMG = "https://img.clerk.com";
const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/**
 * CSP accepts a WebSocket origin, not the endpoint path. Keep the endpoint
 * path in the public client configuration while deriving only its exact
 * scheme/host/port here. A malformed value is never silently widened to
 * `ws:`/`wss:`; TLS mode additionally requires a secure WebSocket.
 */
function syncGatewayCspSource(
  value: string | undefined,
  tlsRequired: boolean,
): string | null {
  const raw = value?.trim() ?? "";
  if (!raw) {
    if (tlsRequired) {
      throw new Error(
        "NEXT_PUBLIC_SYNC_GATEWAY_URL must be a ws(s) URL when CONCORD_REQUIRE_TLS=1",
      );
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      "NEXT_PUBLIC_SYNC_GATEWAY_URL must be a valid ws:// or wss:// URL",
    );
  }

  if (
    !["ws:", "wss:"].includes(parsed.protocol) ||
    parsed.origin === "null" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(
      "NEXT_PUBLIC_SYNC_GATEWAY_URL must use ws:// or wss:// without credentials or a fragment",
    );
  }
  if (tlsRequired && parsed.protocol !== "wss:") {
    throw new Error(
      "NEXT_PUBLIC_SYNC_GATEWAY_URL must use wss:// when CONCORD_REQUIRE_TLS=1",
    );
  }

  return parsed.origin;
}

const syncGatewaySource = syncGatewayCspSource(
  process.env.NEXT_PUBLIC_SYNC_GATEWAY_URL,
  requireTls,
);

function buildCsp(nonce: string, clerkFrontendApi: string | null): string {
  const isDev = process.env.NODE_ENV === "development";
  const connectSrc = [
    "'self'",
    ...(clerkFrontendApi ? [clerkFrontendApi] : []),
    ...(syncGatewaySource ? [syncGatewaySource] : []),
  ];
  // A cookieless Clerk development instance loads its browser bundle from
  // the instance origin. That origin is explicitly allowed only in dev;
  // production keeps nonce + strict-dynamic script policy.
  const devClerkScripts = isDev && clerkFrontendApi;
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    ...(devClerkScripts ? [] : ["'strict-dynamic'"]),
    "'wasm-unsafe-eval'",
    ...(isDev ? ["'unsafe-eval'"] : []),
    ...(devClerkScripts ? [clerkFrontendApi] : []),
  ];

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSrc.join(" ")}`,
    `img-src 'self' data: blob: ${CLERK_DEV_IMG}`,
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/**
 * Extract the Clerk frontend API origin from a Clerk v6 publishable key.
 * Malformed or legacy keys return null; the policy then permits only the
 * same-origin plus the explicitly configured sync gateway origin.
 */
function clerkFrontendApiFromKey(key: string | undefined): string | null {
  if (!key) return null;
  const match = /^pk_(?:test|live)_([A-Za-z0-9_-]+)$/.exec(key);
  if (!match) return null;
  try {
    let decoded = Buffer.from(match[1], "base64url").toString("utf8");
    decoded = decoded.replace(/\$$/, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(decoded)) return null;
    return `https://${decoded}`;
  } catch {
    return null;
  }
}

export default clerkMiddleware(
  (_auth, request: NextRequest) => {
    const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
    const clerkApi = clerkFrontendApiFromKey(
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    );
    const csp = buildCsp(nonce, clerkApi);

    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);

    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("X-Frame-Options", "DENY");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    // HSTS is opt-in because local development and the documented plaintext
    // staging mode still use http:// and ws://. It is emitted only when the
    // explicit TLS contract is enabled for a production server.
    if (process.env.NODE_ENV === "production" && requireTls) {
      response.headers.set("Strict-Transport-Security", HSTS_VALUE);
    }
    return response;
  },
  {
    ...(appOrigin ? { authorizedParties: [appOrigin] } : {}),
  },
);

export const config = {
  matcher: [
    // Skip Next.js internals and static files, except API and Clerk routes.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
