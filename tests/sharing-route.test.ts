import { afterEach, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/documents/[documentId]/permissions/route";
const mocks = vi.hoisted(() => ({ grant: vi.fn(), actor: { userId: "owner" } }));
vi.mock("../src/server/auth/actor-context", () => ({ buildActorContext: async () => mocks.actor }));
vi.mock("../src/server/services/permissions", () => ({ permissionsService: { grantPermission: mocks.grant } }));
const context = { params: Promise.resolve({ documentId: "doc" }) };
afterEach(() => { vi.unstubAllEnvs(); mocks.grant.mockReset(); });
it("accepts the browser Host behind a standalone bind address, rejects foreign origins and injected sharing fields", async () => {
  vi.stubEnv("CONCORD_APP_ORIGIN", "");
  mocks.grant.mockResolvedValue({ role: "VIEWER" });
  const body = { action: "grant", email: "ada@example.com", role: "VIEWER" };
  const request = (origin: string, payload = body) => new Request("http://0.0.0.0:3111/api/documents/doc/permissions", {
    method: "POST", headers: { host: "localhost:3111", origin, "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  expect((await POST(request("http://localhost:3111"), context)).status).toBe(200);
  expect(mocks.grant).toHaveBeenCalledWith(mocks.actor, "doc", body);
  mocks.grant.mockClear();
  expect((await POST(request("https://foreign.example"), context)).status).toBe(403);
  expect((await POST(request("http://localhost:3111", { ...body, role: "OWNER" }), context)).status).toBe(400);
  expect((await POST(request("http://localhost:3111", { ...body, ownerUserId: "spoofed" } as typeof body), context)).status).toBe(400);
  expect(mocks.grant).not.toHaveBeenCalled();
  vi.stubEnv("CONCORD_APP_ORIGIN", "https://concord.example");
  expect((await POST(request("http://localhost:3111"), context)).status).toBe(403);
  expect((await POST(request("https://concord.example"), context)).status).toBe(200);
});
