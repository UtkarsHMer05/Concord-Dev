import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyRevisionRequest } from "@/server/gateway-history-proxy";

const documentId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("history gateway proxy", () => {
  it("forwards only the fixed history endpoint and the Clerk bearer token", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNC_GATEWAY_URL", "wss://sync.example.test/api/v1/sync");
    const upstream = vi.fn().mockResolvedValue(new Response('{"revisions":[]}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", upstream);

    const response = await proxyRevisionRequest(new Request(
      `https://app.example.test/api/gateway/documents/${documentId}/revisions/${revisionId}`,
      { headers: { authorization: "Bearer clerk-token" } },
    ), documentId, [revisionId]);

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(`https://sync.example.test/api/v1/documents/${documentId}/revisions/${revisionId}`);
    expect(init.headers).toEqual({ authorization: "Bearer clerk-token", accept: "application/json" });
    expect(await response.json()).toEqual({ revisions: [] });
  });

  it("validates checkpoint input and rejects an attempted path escape before forwarding", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNC_GATEWAY_URL", "ws://127.0.0.1:8791/api/v1/sync");
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);

    const pathEscape = await proxyRevisionRequest(new Request("http://app.test/api/gateway"), documentId, ["..", "restore"]);
    expect(pathEscape.status).toBe(404);

    const invalidBody = await proxyRevisionRequest(new Request("http://app.test/api/gateway", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ label: "Checkpoint", targetUrl: "https://attacker.test" }),
    }), documentId);
    expect(invalidBody.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("fails closed for missing authorization and unavailable gateway", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNC_GATEWAY_URL", "ws://127.0.0.1:8791/api/v1/sync");
    const unauthorized = await proxyRevisionRequest(new Request("http://app.test"), documentId);
    expect(unauthorized.status).toBe(401);

    vi.stubEnv("NEXT_PUBLIC_SYNC_GATEWAY_URL", "");
    const unavailable = await proxyRevisionRequest(new Request("http://app.test", {
      headers: { authorization: "Bearer token" },
    }), documentId);
    expect(unavailable.status).toBe(503);
  });
});
