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
function makeRequest(
  headers: Record<string, string> = {},
  url = "https://concord.example/",
) {
  return {
    headers: new Headers(headers),
    method: "GET",
    url,
  };
}

async function invokeMiddleware(
  requestEnv: Record<string, string>,
  requestUrl = "https://concord.example/",
) {
  for (const [k, v] of Object.entries(requestEnv)) {
    if (
      k.startsWith("NEXT_PUBLIC_") ||
      k === "NODE_ENV" ||
      k === "CONCORD_APP_ORIGIN" ||
      k === "CONCORD_REQUIRE_TLS"
    ) {
      vi.stubEnv(k, v);
    }
  }
  await import("../src/proxy");
  const handler = middlewareChain.at(-1);
  expect(handler).toBeDefined();
  return (handler as (req: unknown) => unknown)(makeRequest({}, requestUrl)) as {
    headers: Headers;
    requestHeaders: Headers;
  };
}

describe("Clerk ingress claim policy", () => {
  it("passes the exact cloud app origin to Clerk and includes API and frontend routes", async () => {
    vi.stubEnv("CONCORD_APP_ORIGIN", "https://concord.example");
    vi.stubEnv("CONCORD_REQUIRE_TLS", "0");
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

  it.each([
    "https://user:pass@concord.example",
    "https://concord.example/",
    "https://concord.example?preview=1",
    "https://concord.example#fragment",
  ])("rejects a non-exact app origin: %s", async (origin) => {
    vi.stubEnv("CONCORD_APP_ORIGIN", origin);
    vi.stubEnv("CONCORD_REQUIRE_TLS", "0");
    await expect(import("../src/proxy")).rejects.toThrow("CONCORD_APP_ORIGIN");
  });

  it("keeps the local no-origin configuration compatible", async () => {
    vi.stubEnv("CONCORD_APP_ORIGIN", "");
    vi.stubEnv("CONCORD_REQUIRE_TLS", "0");
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
      CONCORD_REQUIRE_TLS: "0",
      NEXT_PUBLIC_SYNC_GATEWAY_URL: "",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_ZnVuLWJsb3dmaXNoLTU3OTguY2xlcmsuYWNjb3VudHMuZGV2",
    });
    const second = await invokeMiddleware({
      CONCORD_REQUIRE_TLS: "0",
      NEXT_PUBLIC_SYNC_GATEWAY_URL: "",
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
      CONCORD_REQUIRE_TLS: "0",
      NEXT_PUBLIC_SYNC_GATEWAY_URL: "wss://sync.example:8443/api/v1/sync",
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
      CONCORD_REQUIRE_TLS: "0",
      NEXT_PUBLIC_SYNC_GATEWAY_URL: "ws://127.0.0.1:8890/api/v1/sync",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
    });
    const devCsp = dev.headers.get("content-security-policy") ?? "";
    expect(/script-src [^;]+/.exec(devCsp)?.[0]).toContain("'unsafe-eval'");
    expect(devCsp).not.toContain("upgrade-insecure-requests");
    expect(devCsp).toContain("connect-src 'self' ws://127.0.0.1:8890");
    expect(dev.headers.get("strict-transport-security")).toBeNull();
  });

  it("pins the dangerous directives closed", async () => {
    const res = await invokeMiddleware({
      CONCORD_REQUIRE_TLS: "0",
      NEXT_PUBLIC_SYNC_GATEWAY_URL: "",
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
      CONCORD_REQUIRE_TLS: "0",
      NEXT_PUBLIC_SYNC_GATEWAY_URL: "wss://sync.example:8443/api/v1/sync",
      // Real-format dev key: pk_<env>_<base64url(instance origin)>, the
      // instance origin decoding to fun-blowfish-5798.clerk.accounts.dev.
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:
        "pk_test_ZnVuLWJsb3dmaXNoLTU3OTguY2xlcmsuYWNjb3VudHMuZGV2",
    });
    const csp = res.headers.get("content-security-policy") ?? "";
    // Sync gateway WebSocket + Clerk frontend API only.
    expect(csp).toContain(
      "connect-src 'self' https://fun-blowfish-5798.clerk.accounts.dev wss://sync.example:8443",
    );
    const connectSrc = /connect-src ([^;]+)/.exec(csp)?.[1] ?? "";
    expect(connectSrc.split(/\s+/)).not.toContain("ws:");
    expect(connectSrc.split(/\s+/)).not.toContain("wss:");
    expect(connectSrc).not.toContain("ws://untrusted.example");
    expect(connectSrc).not.toContain("wss://untrusted.example");
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
      CONCORD_REQUIRE_TLS: "0",
      NEXT_PUBLIC_SYNC_GATEWAY_URL: "wss://sync.example/api/v1/sync",
      // Explicitly absent: a previously stubbed key must not leak in.
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
    });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' wss://sync.example");
  });

  it("does not widen connect-src when the gateway URL is absent", async () => {
    const res = await invokeMiddleware({
      NODE_ENV: "production",
      CONCORD_REQUIRE_TLS: "0",
      NEXT_PUBLIC_SYNC_GATEWAY_URL: "",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
    });
    const connectSrc =
      /connect-src ([^;]+)/.exec(
        res.headers.get("content-security-policy") ?? "",
      )?.[1] ?? "";
    expect(connectSrc).toBe("'self'");
    expect(connectSrc.split(/\s+/)).not.toContain("ws:");
    expect(connectSrc.split(/\s+/)).not.toContain("wss:");
  });

  it("derives the exact WSS origin and emits HSTS in secure production", async () => {
    const res = await invokeMiddleware({
      NODE_ENV: "production",
      CONCORD_REQUIRE_TLS: "1",
      CONCORD_APP_ORIGIN: "https://concord.example",
      NEXT_PUBLIC_SYNC_GATEWAY_URL:
        "wss://sync.example:8443/api/v1/sync?transport=websocket",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
    });
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("connect-src 'self' wss://sync.example:8443");
    const connectSrc = /connect-src ([^;]+)/.exec(csp)?.[1] ?? "";
    expect(connectSrc.split(/\s+/)).not.toContain("ws:");
    expect(connectSrc.split(/\s+/)).not.toContain("wss:");
    expect(res.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(res.headers.get("strict-transport-security")).not.toContain(
      "preload",
    );
  });

  it("does not emit HSTS when the explicit TLS mode is off", async () => {
    const res = await invokeMiddleware({
      NODE_ENV: "production",
      CONCORD_REQUIRE_TLS: "0",
      CONCORD_APP_ORIGIN: "http://concord.example",
      NEXT_PUBLIC_SYNC_GATEWAY_URL: "ws://127.0.0.1:8890/api/v1/sync",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
    });
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain(
      "connect-src 'self' ws://127.0.0.1:8890",
    );
  });

  it("does not emit HSTS for an HTTP request even with secure configuration", async () => {
    const res = await invokeMiddleware(
      {
        NODE_ENV: "production",
        CONCORD_REQUIRE_TLS: "1",
        CONCORD_APP_ORIGIN: "https://concord.example",
        NEXT_PUBLIC_SYNC_GATEWAY_URL: "wss://sync.example/api/v1/sync",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      },
      "http://concord.example/",
    );
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("rejects an HTTP app origin when explicit TLS mode is enabled", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONCORD_REQUIRE_TLS", "1");
    vi.stubEnv("CONCORD_APP_ORIGIN", "http://concord.example");
    vi.stubEnv(
      "NEXT_PUBLIC_SYNC_GATEWAY_URL",
      "wss://sync.example/api/v1/sync",
    );
    await expect(import("../src/proxy")).rejects.toThrow(
      "CONCORD_APP_ORIGIN",
    );
  });

  it.each([
    ["missing", ""],
    ["malformed", "not a URL"],
    ["unsupported protocol", "https://sync.example/api/v1/sync"],
    ["insecure protocol", "ws://sync.example:8890/api/v1/sync"],
    ["credentials", "wss://user:pass@sync.example/api/v1/sync"],
  ])(
    "rejects %s gateway URLs when explicit TLS mode is enabled",
    async (_name, gatewayUrl) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CONCORD_REQUIRE_TLS", "1");
      vi.stubEnv("CONCORD_APP_ORIGIN", "https://concord.example");
      vi.stubEnv("NEXT_PUBLIC_SYNC_GATEWAY_URL", gatewayUrl);
      await expect(import("../src/proxy")).rejects.toThrow(
        "NEXT_PUBLIC_SYNC_GATEWAY_URL",
      );
    },
  );

  it("rejects malformed app origins even when TLS mode is off", async () => {
    vi.stubEnv("CONCORD_APP_ORIGIN", "https://concord.example/path");
    vi.stubEnv("CONCORD_REQUIRE_TLS", "0");
    await expect(import("../src/proxy")).rejects.toThrow(
      "CONCORD_APP_ORIGIN",
    );
  });

  it.each(["true", "yes", "2", " 1", "1 "])(
    "rejects non-binary CONCORD_REQUIRE_TLS value %j",
    async (requireTls) => {
      vi.stubEnv("CONCORD_REQUIRE_TLS", requireTls);
      await expect(import("../src/proxy")).rejects.toThrow(
        "CONCORD_REQUIRE_TLS",
      );
    },
  );
});

describe("HSTS Next.js route-header contract", () => {
  async function configuredHeaders() {
    const { default: nextConfig } = await import("../next.config");
    return (await nextConfig.headers?.()) ?? [];
  }

  it("adds HSTS to static route headers only in secure production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONCORD_REQUIRE_TLS", "1");
    const headers = await configuredHeaders();
    expect(headers[0]?.headers).toContainEqual({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
    expect(headers[0]?.headers).not.toContainEqual(
      expect.objectContaining({ value: expect.stringContaining("preload") }),
    );
  });

  it("does not add HSTS to route headers when TLS mode is off", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CONCORD_REQUIRE_TLS", "0");
    const headers = await configuredHeaders();
    expect(headers[0]?.headers).not.toContainEqual(
      expect.objectContaining({ key: "Strict-Transport-Security" }),
    );
  });
});

describe("typed web-security environment contract", () => {
  async function getConfig(env: Record<string, string | undefined>) {
    const { getWebSecurityConfig } = await import("../src/server/env");
    return getWebSecurityConfig(env);
  }

  it("returns canonical origins while retaining local plaintext allowances", async () => {
    await expect(
      getConfig({
        NODE_ENV: "development",
        CONCORD_REQUIRE_TLS: "0",
        CONCORD_APP_ORIGIN: "http://localhost:3000",
        NEXT_PUBLIC_SYNC_GATEWAY_URL:
          "ws://127.0.0.1:8890/api/v1/sync?transport=websocket",
      }),
    ).resolves.toEqual({
      requireTls: false,
      appOrigin: "http://localhost:3000",
      syncGatewayOrigin: "ws://127.0.0.1:8890",
    });
  });

  it("fails closed when secure mode omits either origin", async () => {
    await expect(
      getConfig({ CONCORD_REQUIRE_TLS: "1" }),
    ).rejects.toThrow("CONCORD_APP_ORIGIN");
    await expect(
      getConfig({
        CONCORD_REQUIRE_TLS: "1",
        CONCORD_APP_ORIGIN: "https://concord.example",
      }),
    ).rejects.toThrow("NEXT_PUBLIC_SYNC_GATEWAY_URL");
  });

  it.each([
    "https://sync.example/api/v1/sync",
    "wss://user:pass@sync.example/api/v1/sync",
    "wss://sync.example/api/v1/sync#fragment",
    "wss://sync.example/api/v1/sync ",
  ])("rejects malformed gateway URLs even when TLS mode is off: %s", async (gatewayUrl) => {
    await expect(
      getConfig({
        NODE_ENV: "development",
        CONCORD_REQUIRE_TLS: "0",
        NEXT_PUBLIC_SYNC_GATEWAY_URL: gatewayUrl,
      }),
    ).rejects.toThrow("NEXT_PUBLIC_SYNC_GATEWAY_URL");
  });
});
