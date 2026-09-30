import { afterEach, describe, expect, it, vi } from "vitest";

import { proxyRevisionRequest, proxyBranchRequest, proxyConcordpackRequest } from "@/server/gateway-history-proxy";

const documentId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("history gateway proxy", () => {
  it("forwards binary archives only to fixed paths with bounded, authenticated import context", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNC_GATEWAY_URL", "wss://sync.example.test/api/v1/sync");
    const upstream = vi.fn().mockImplementation(() => Promise.resolve(new Response("ok"))); vi.stubGlobal("fetch", upstream);
    const headers = { authorization: "Bearer token", "content-type": "application/vnd.concord.concordpack" };
    expect((await proxyConcordpackRequest(new Request("http://app.test", { headers }), documentId)).status).toBe(200);
    expect(upstream.mock.calls[0][0].toString()).toBe(`https://sync.example.test/api/v1/documents/${documentId}/concordpack`);
    const query = new URLSearchParams({ requestId: revisionId, title: "Restored RFC", documentId, seq: "12", baseSnapshotSeq: "3", publicKey: "a".repeat(64), workspace: "personal" });
    const binary = Uint8Array.of(1, 2, 3);
    const make = (params: URLSearchParams, extra = {}) => new Request(`http://app.test/import?${params}`, { method: "POST", headers: { ...headers, ...extra }, body: binary });
    expect((await proxyConcordpackRequest(make(query))).status).toBe(200);
    const [url, init] = upstream.mock.calls[1];
    expect(url.pathname).toBe("/api/v1/concordpack/import"); expect(url.searchParams.get("publicKey")).toBe("a".repeat(64));
    expect(init.body).toEqual(binary); expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
    const invalid = new URLSearchParams(query); invalid.set("targetUrl", "https://attacker.test");
    expect((await proxyConcordpackRequest(make(invalid))).status).toBe(400);
    expect((await proxyConcordpackRequest(make(query, { "content-length": String(65 * 1024 * 1024) }))).status).toBe(413);
    expect((await proxyConcordpackRequest(new Request("http://app.test/import", { method: "POST", body: binary }))).status).toBe(401);
    expect(upstream).toHaveBeenCalledTimes(2);
  });
  it("forwards review requests only to the configured gateway and rejects path escapes", async () => {
    vi.stubEnv("NEXT_PUBLIC_SYNC_GATEWAY_URL", "wss://sync.example.test/api/v1/sync");
    const upstream = vi.fn().mockResolvedValue(new Response('{"duplicate":true}', { status: 200 })); vi.stubGlobal("fetch", upstream);
    const request = new Request("http://app.test", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: '{"requestId":"fixed"}' });
    const response = await proxyBranchRequest(request, documentId, [revisionId, "merge"]);
    expect(response.status).toBe(200);
    expect(upstream.mock.calls[0][0].toString()).toBe(`https://sync.example.test/api/v1/documents/${documentId}/branches/${revisionId}/merge`);
    expect(upstream.mock.calls[0][1]).toMatchObject({ cache: "no-store", redirect: "error", body: '{"requestId":"fixed"}' });
    expect((await proxyBranchRequest(new Request("http://app.test"), documentId, [".."])).status).toBe(404);
    expect((await proxyBranchRequest(new Request("http://app.test"), documentId)).status).toBe(401);
  });
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
