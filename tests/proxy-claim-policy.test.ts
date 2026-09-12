import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  clerkMiddleware: vi.fn(() => () => "middleware"),
}));
vi.mock("@clerk/nextjs/server", () => mocked);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  mocked.clerkMiddleware.mockClear();
});

describe("Clerk ingress claim policy", () => {
  it("passes the exact cloud app origin to Clerk and includes API and frontend routes", async () => {
    vi.stubEnv("CONCORD_APP_ORIGIN", "https://concord.example");
    const { config } = await import("../src/proxy");
    expect(mocked.clerkMiddleware).toHaveBeenCalledWith({
      authorizedParties: ["https://concord.example"],
    });
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
    expect(mocked.clerkMiddleware).toHaveBeenCalledWith({});
  });
});
