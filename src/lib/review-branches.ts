import { z } from "zod";

export interface ReviewBranch {
  documentId: string; mainDocumentId: string; baseRevisionId: string;
  baseSeq: string; baseDigest: string; name: string; createdBy: string;
}
export interface ReviewChange {
  id: string; base: unknown[]; current: unknown[]; proposed: unknown[];
  conflict: boolean; alreadyApplied: boolean;
}
export interface MergeRecord {
  mergeId: string; sourceRevisionId: string; resultRevisionId: string;
  baseRevisionId: string; resultSeq: string; actorId: string;
}
export interface BranchComparison {
  branch: ReviewBranch; mainSeq: string; branchSeq: string; canMerge: boolean;
  mainDigest: string; branchDigest: string;
  changes: ReviewChange[]; merges: MergeRecord[];
}

export const mergeRequestSchema = z.object({
  requestId: z.uuid(), expectedMainSeq: z.string().regex(/^\d{1,19}$/),
  expectedBranchSeq: z.string().regex(/^\d{1,19}$/),
  selections: z.array(z.object({ id: z.string().regex(/^change-\d+$/), resolution: z.enum(["apply", "branch"]) }).strict()).min(1).max(2000),
}).strict();
export type ReviewMergeRequest = z.infer<typeof mergeRequestSchema>;

interface RecoveryStorage { length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
function prefix(user: string, main: string, branch: string) {
  return `concord.review-merge.v1.${encodeURIComponent(user)}.${main}.${branch}.`;
}
export function saveMergeRequest(storage: RecoveryStorage, user: string, main: string, branch: string, request: ReviewMergeRequest) {
  const value = mergeRequestSchema.parse(request);
  storage.setItem(prefix(user, main, branch) + value.requestId, JSON.stringify(value));
}
export function pendingMergeRequests(storage: RecoveryStorage, user: string, main: string, branch: string): ReviewMergeRequest[] {
  const keyPrefix = prefix(user, main, branch); const requests: ReviewMergeRequest[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i); if (!key?.startsWith(keyPrefix)) continue;
    const raw = storage.getItem(key); if (!raw || raw.length > 128 * 1024) throw new Error("Merge recovery storage is unreadable.");
    const value = mergeRequestSchema.parse(JSON.parse(raw));
    if (key !== keyPrefix + value.requestId) throw new Error("Merge recovery request ID does not match its key.");
    requests.push(value);
  }
  return requests;
}
export function clearMergeRequest(storage: RecoveryStorage, user: string, main: string, branch: string, id: string) {
  storage.removeItem(prefix(user, main, branch) + id);
}

export class ReviewRequestError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function reviewRequest<T>(url: string, getToken: () => Promise<string | null>, init?: RequestInit): Promise<T> {
  const token = await getToken();
  if (!token) throw new ReviewRequestError(401, "unauthorized", "Sign in again to continue your review.");
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body.error ?? "request_failed";
    const messages: Record<string, string> = {
      review_is_stale: "Main or the branch changed after this comparison. Refresh the review and choose changes again.",
      resolve_conflict_explicitly: "Choose Keep main or Use branch for each conflicting change.",
      request_id_conflicts: "This saved request differs from an existing merge. Keep it for recovery and contact the document owner.",
      review_too_large: "This review exceeds 2,000 blocks or 2 MiB. Split the proposal into smaller documents.",
      invalid_request: "Check the branch name, base revision, and selected changes.",
    };
    throw new ReviewRequestError(response.status, code, messages[code] ?? (response.status === 404 ? "This document or branch is unavailable, or you do not have access." :
      response.status === 401 ? "Sign in again to continue your review." : response.status === 429 ? "Too many review requests. Wait a minute, then retry." : "Review service unavailable. Reconnect and retry your saved request."));
  }
  return body as T;
}
