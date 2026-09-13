import { afterEach, describe, expect, it, vi } from "vitest";

const middlewareChain: Array<(req: unknown) => unknown> = [];
const mocked = vi.hoisted(() => ({
  clerkMiddleware: vi.fn(
    (handler: (auth: unknown, req: unknown) => unknown, options?: unknown) => {
      void options;
      const wrapped = (req: unknown) => handler(undefined, req);
      middlewareChain.push(wrapped);
      return wrapped;
    },
  ),
  NextResponse: {
    next: vi.fn((init: { request: { headers: Headers } }) => ({
      headers: new Headers(),
      requestHeaders: init.request.headers,
    })),
  },
}));
vi.mock("@clerk/nextjs/server", () => mocked);
vi.mock("next/server", () => ({
  NextResponse: mocked.NextResponse,
  NextRequest: class {},
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  middlewareChain.length = 0;
  mocked.clerkMiddleware.mockClear();
  mocked.NextResponse.next.mockClear();
});

/**
 * The middleware handler IS the web ingress security contract: the
 * authorizedParties option (who may hold a session) and the generated
 * Content-Security-Policy (what the page may load/execute). These tests
 * drive the real handler with a synthetic request and pin the EFFECTIVE
 * header — not the options object — so the Clerk directive-merge and any
 * future refactor cannot silently weaken the policy.
 */
function makeRequest(headers: Record<string, string> = {}) {
  return {
    headers: new Headers(headers),
    method: "GET",
    url: "https://concord.example/",
  };
}

async function invokeMiddleware(requestEnv: Record<string, string>) {
  for (const [k, v] of Object.entries(requestEnv)) {
    if (k.startsWith("NEXT_PUBLIC_") || k === "NODE_ENV") {
      vi.stubEnv(k, v);
    }
  }
  await import("../src/proxy");
  const handler = middlewareChain.at(-1);
  expect(handler).toBeDefined();
  return (handler as (req: unknown) => unknown)(makeRequest()) as {
    headers: Headers;
    requestHeaders: Headers;
  };
}

describe("Clerk ingress claim policy", () => {
  it("passes the exact cloud app origin to Clerk and includes API and frontend routes", async () => {
    vi.stubEnv("CONCORD_APP_ORIGIN", "https://concord.example");
    const { config } = await import("../src/proxy");
    expect(mocked.clerkMiddleware).toHaveBeenCalledWith(
      expect.any(Function),
      { authorizedParties: ["https://concord.example"] },
    );
    expect(config.matcher).toContain("/(api|trpc)(.*)");
    expect(config.matcher).toContain("/__clerk/(.*)");
  });

  it("rejects a misconfigured origin before installing middleware", async () => {
    vi.stubEnv("CONCORD_APP_ORIGIN", "https://concord.example/path");
    await expect(import("../src/proxy")).rejects.toThrow("CONCORD_APP_ORIGIN");
    expect(mocked.clerkMiddleware).not.toHaveBeenCalled();
  });

  it("keeps the local no-origin configuration compatible", async () => {
    vi.stubEnv("CONCORD_APP_ORIGIN", "");
    await import("../src/proxy");
    expect(mocked.clerkMiddleware).toHaveBeenCalledWith(
      expect.any(Function),
      {},
    );
  });
});

describe("Content-Security-Policy contract (nonce-based)", () => {
  it("generates a per-request nonce and sets it on request and response headers", async () => {
    const first = await invokeMiddleware({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZnVuLWJsb3dmaXNoLTU3OTguY2xlcmsuYWNjb3VudHMuZGV2",
    });
    const second = await invokeMiddleware({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZnVuLWJsb3dmaXNoLTU3OTguY2xlcmsuYWNjb3VudHMuZGV2",
    });

    const nonceOf = (h: Headers) =>
      /'nonce-([^']+)'/.exec(h.get("content-security-policy") ?? "")?.[1];
    const n1 = nonceOf(first.headers);
    const n2 = nonceOf(second.headers);
    expect(n1).toBeDefined();
    expect(n2).toBeDefined();
    expect(n1).not.toBe(n2); // fresh nonce per request
    // The nonce must be visible to Next.js script stamping AND readable
    // as x-nonce (the documented discovery channel).
    expect(first.requestHeaders.get("x-nonce")).toBe(n1);
    expect(
      first.requestHeaders.get("content-security-policy"),
    ).toBe(first.headers.get("content-security-policy"));
  });

  it("never allows unsafe-inline/unsafe-eval/open https: scripts in production", async () => {
    const res = await invokeMiddleware({
      NODE_ENV: "production",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZnVuLWJsb3dmaXNoLTU3OTguY2xlcmsuYWNjb3VudHMuZGV2",
    });
    const csp = res.headers.get("content-security-policy") ?? "";
    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? "";
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'"); // WASM gate for the CRDT worker
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    // No open https:/http: script sources and no third-party script origins.
    expect(scriptSrc).not.toMatch(/(^|\s)https?:/);
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("keeps dev-only relaxations out of production shape", async () => {
    const dev = await invokeMiddleware({
      NODE_ENV: "development",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZnVuLWJsb3dmaXNoLTU3OTguY2xlcmsuYWNjb3VudHMuZGV2",
    });
    const devCsp = dev.headers.get("content-security-policy") ?? "";
    expect(/script-src [^;]+/.exec(devCsp)?.[0]).toContain("'unsafe-eval'");
    expect(devCsp).not.toContain("upgrade-insecure-requests");
  });

  it("pins the dangerous directives closed", async () => {
    const res = await invokeMiddleware({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZnVuLWJsb3dmaXNoLTU3OTguY2xlcmsuYWNjb3VudHMuZGV2",
    });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("allows exactly the origins the product needs", async () => {
    const res = await invokeMiddleware({
      NODE_ENV: "production",
      // Real-format dev key: pk_<env>_<base64url(instance origin)>, the
      // instance origin decoding to fun-blowfish-5798.clerk.accounts.dev.
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        "pk_test_ZnVuLWJsb3dmaXNoLTU3OTguY2xlcmsuYWNjb3VudHMuZGV2",
    });
    const csp = res.headers.get("content-security-policy") ?? "";
    // Sync gateway WebSocket + Clerk frontend API only.
    expect(csp).toContain(
      "connect-src 'self' https://fun-blowfish-5798.clerk.accounts.dev ws: wss:",
    );
    // No Stripe/maps/telemetry endpoints (Clerk's defaults carry them).
    expect(csp).not.toContain("stripe.com");
    expect(csp).not.toContain("maps.googleapis.com");
    expect(csp).not.toContain("clerk-telemetry.com");
    // CRDT worker: same-origin script + blob: import URL.
    expect(csp).toContain("worker-src 'self' blob:");
    // Other hardening headers present on the same response.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("degrades connect-src to 'self' when no publishable key is set", async () => {
    const res = await invokeMiddleware({
      NODE_ENV: "production",
      // Explicitly absent: a previously stubbed key must not leak in.
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
    });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' ws: wss:");
  });
});
