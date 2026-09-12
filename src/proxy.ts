import { clerkMiddleware } from "@clerk/nextjs/server";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Origin allowlist for Clerk sessions (C1 hardening).
// An exact origin is supplied by the cloud bundle. Keep local development
// compatible with its own Clerk instance until a local origin is configured.
// ---------------------------------------------------------------------------
const appOrigin = process.env.CONCORD_APP_ORIGIN;
if (appOrigin && new URL(appOrigin).origin !== appOrigin) {
  throw new Error("CONCORD_APP_ORIGIN must be an exact origin without a path or trailing slash");
}

// ---------------------------------------------------------------------------
// Nonce-based Content-Security-Policy (C2 hardening).
//
// Replaces the static header that used to live in next.config.ts, whose
// script-src carried 'unsafe-inline'. This middleware generates a fresh
// nonce per request, builds the policy, and — the part both Next.js 16 and
// Clerk need — sets it on BOTH the request headers (Next stamps the nonce
// onto every framework/page script tag; Clerk's server components parse
// the nonce from the request CSP header and stamp their injected scripts)
// and the response.
//
// Why not Clerk's `contentSecurityPolicy` middleware option: its directive
// merge is additive with Clerk defaults (Stripe/maps/telemetry endpoints,
// and 'unsafe-inline' survives strict mode in the merged script-src when
// any custom directive is supplied). Building the header here keeps the
// policy exactly what this product needs and nothing more.
//
// Deliberate exceptions, each replacing a broader earlier form:
//   - 'wasm-unsafe-eval' — WebAssembly compile/instantiate gate needed by
//     the CRDT worker's WASM engine; does NOT enable general eval.
//   - 'strict-dynamic' — nonce-bearing scripts may load their own deps;
//     host-source lists are ignored by CSP3 browsers, which is fine
//     because every first-party script is nonce-stamped by Next.
//   - connect-src ws:/wss: — the browser sync gateway WebSocket (ALB DNS
//     today; the app origin once TLS + custom domain land). Clerk's
//     frontend API origin is appended at request time from the instance.
//   - style-src 'unsafe-inline' — Tailwind + React style attributes inject
//     inline styles at render; Next does not nonce those. Script injection
//     is the XSS primitive that matters and it is nonce-gated.
//   - img-src data:/blob: — template thumbnails are inline SVGs; the WASM
//     worker bootstraps from a blob: URL.
//   - worker-src/child-src blob: — the CRDT worker is instantiated from a
//     versioned same-origin script URL (public/crdt-worker.js).
//   - 'unsafe-eval' in development only — React uses eval for enhanced
//     server-stack debugging (per the Next.js CSP guide); never in prod.
//   - upgrade-insecure-requests in production only — localhost dev is
//     plain http by definition.
//
// A nonce CSP forces dynamic rendering; every route here is behind Clerk
// auth and already dynamic, so nothing regresses.
// ---------------------------------------------------------------------------

/** Dev-instance domains serve Clerk avatars; production serves from self. */
const CLERK_DEV_IMG = "https://img.clerk.com";

function buildCsp(nonce: string, clerkFrontendApi: string | null): string {
  const isDev = process.env.NODE_ENV === "development";
  const connectSrc = [
    "'self'",
    ...(clerkFrontendApi ? [clerkFrontendApi] : []),
    "ws:",
    "wss:",
  ];
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    "'wasm-unsafe-eval'",
    ...(isDev ? ["'unsafe-eval'"] : []),
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
 * Extract the Clerk frontend API origin from the publishable key
 * (Clerk v6+ key format): pk_<env>_<base64url(instance origin)>.
 * e.g. pk_test_ZnVuLWJsb3dmaXNoLTU3OTgu... decodes to the instance
 * origin fun-blowfish-5798.clerk.accounts.dev — the origin the browser
 * talks to for session refresh and the one Clerk's injected scripts
 * load from (covered by the nonce under strict-dynamic).
 * Returns null for legacy or malformed keys; connect-src then falls
 * back to 'self' (production instances serve the frontend API from the
 * app's own domain behind Clerk's proxy).
 */
function clerkFrontendApiFromKey(key: string | undefined): string | null {
  if (!key) return null;
  const match = /^pk_(?:test|live)_([A-Za-z0-9_-]+)$/.exec(key);
  if (!match) return null;
  try {
    let decoded = Buffer.from(match[1], "base64url").toString("utf8");
    // Clerk key bodies end with a '$' separator before the key material;
    // the instance origin is what precedes it.
    decoded = decoded.replace(/\$$/, "");
    // Only accept a syntactically valid https origin (host, no path).
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(decoded)) return null;
    return `https://${decoded}`;
  } catch {
    return null;
  }
}

export default clerkMiddleware((auth, request: NextRequest) => {
  // Per-request nonce: base64(uuid) ≥ 128 bits of entropy; the CSP
  // nonce grammar is base64 chars, safe for a header value.
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const clerkApi = clerkFrontendApiFromKey(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  );
  const csp = buildCsp(nonce, clerkApi);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Both Next.js (framework script tags) and Clerk (injected scripts)
  // read the nonce out of the request CSP header.
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  // The static-header set from next.config.ts applies to every response
  // including static assets; restate them here so HTML responses carry
  // them even if the config is ever narrowed.
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return response;
}, {
  ...(appOrigin ? { authorizedParties: [appOrigin] } : {}),
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
    // Clerk's frontend API routes also require the middleware.
    '/__clerk/(.*)',
  ],
};
