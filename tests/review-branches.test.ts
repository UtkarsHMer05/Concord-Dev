import { describe, expect, it } from "vitest";
import { saveMergeRequest, pendingMergeRequests, clearMergeRequest, type ReviewMergeRequest } from "@/lib/review-branches";
import { readJsonRequest } from "@/server/request-body";

class Storage {
  data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
const request: ReviewMergeRequest = { requestId: "22222222-2222-4222-8222-222222222222", expectedMainSeq: "9007199254740993", expectedBranchSeq: "2", selections: [{ id: "change-0", resolution: "apply" }] };
describe("review merge crash recovery", () => {
  it("retains exact identities and 64-bit sequences across reload, account and document scopes", () => {
    const storage = new Storage(); saveMergeRequest(storage, "alice", "main", "branch", request);
    expect(pendingMergeRequests(storage, "alice", "main", "branch")).toEqual([request]);
    expect(pendingMergeRequests(storage, "bob", "main", "branch")).toEqual([]);
    expect(pendingMergeRequests(storage, "alice", "other", "branch")).toEqual([]);
    expect(pendingMergeRequests(storage, "alice", "main", "other")).toEqual([]);
    clearMergeRequest(storage, "alice", "main", "branch", request.requestId);
    expect(pendingMergeRequests(storage, "alice", "main", "branch")).toEqual([]);
  });
  it("keeps simultaneous tab requests separately and fails before dispatch if storage fails", () => {
    const storage = new Storage(); const other = { ...request, requestId: "33333333-3333-4333-8333-333333333333" };
    saveMergeRequest(storage, "alice", "main", "branch", request); saveMergeRequest(storage, "alice", "main", "branch", other);
    clearMergeRequest(storage, "alice", "main", "branch", request.requestId);
    expect(pendingMergeRequests(storage, "alice", "main", "branch")).toEqual([other]);
    storage.setItem = () => { throw new Error("quota exceeded"); };
    expect(() => saveMergeRequest(storage, "alice", "main", "branch", request)).toThrow("quota exceeded");
  });
  it("refuses corrupted recovery requests without deleting the evidence", () => {
    const storage = new Storage(); saveMergeRequest(storage, "alice", "main", "branch", request);
    const key = storage.key(0)!; storage.setItem(key, "invalid");
    expect(() => pendingMergeRequests(storage, "alice", "main", "branch")).toThrow();
    expect(storage.getItem(key)).toBe("invalid");
  });
});
describe("bounded JSON mutation requests", () => {
  it("limits actual streamed bytes when content-length is absent", async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("12345")); controller.enqueue(new TextEncoder().encode("67890")); controller.close(); } });
    const request = new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    const response = await readJsonRequest(request, 8) as Response;
    expect(response.status).toBe(413);
  });
  it("rejects malformed JSON and form content before mutation", async () => {
    expect((await readJsonRequest(new Request("http://localhost", { method: "POST", body: "x" }), 100) as Response).status).toBe(415);
    expect((await readJsonRequest(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), 100) as Response).status).toBe(400);
    expect(await readJsonRequest(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"ok\":true}" }), 100)).toEqual({ ok: true });
  });
});
