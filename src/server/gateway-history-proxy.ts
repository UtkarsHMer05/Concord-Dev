import "server-only";

import { parseSyncGatewayOrigin } from "@/server/env";
import { readJsonRequest, readRequestBytes } from "@/server/request-body";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4096;

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function gatewayUrl(documentId: string, revisionId?: string, restore = false): URL | null {
  const raw = process.env.NEXT_PUBLIC_SYNC_GATEWAY_URL;
  try {
    if (!raw || !parseSyncGatewayOrigin(raw)) return null;
    const gateway = new URL(raw);
    gateway.protocol = gateway.protocol === "wss:" ? "https:" : "http:";
    gateway.pathname = gateway.pathname.replace(/\/api\/v1\/sync\/?$/, "").replace(/\/sync\/?$/, "").replace(/\/$/, "");
    gateway.search = "";
    gateway.hash = "";
    const suffix = revisionId ? `/${revisionId}${restore ? "/restore" : ""}` : "";
    const basePath = gateway.pathname === "/" ? "" : gateway.pathname.replace(/\/$/, "");
    gateway.pathname = `${basePath}/api/v1/documents/${documentId}/revisions${suffix}`;
    return gateway;
  } catch {
    return null;
  }
}

function proofUrl(documentId: string, seq: string | null): URL | null {
  const raw = process.env.NEXT_PUBLIC_SYNC_GATEWAY_URL;
  try {
    if (!raw || !parseSyncGatewayOrigin(raw)) return null;
    const gateway = new URL(raw);
    gateway.protocol = gateway.protocol === "wss:" ? "https:" : "http:";
    gateway.pathname = gateway.pathname.replace(/\/api\/v1\/sync\/?$/, "").replace(/\/sync\/?$/, "").replace(/\/$/, "");
    gateway.search = "";
    gateway.hash = "";
    const basePath = gateway.pathname === "/" ? "" : gateway.pathname.replace(/\/$/, "");
    gateway.pathname = `${basePath}/api/v1/documents/${documentId}/proof`;
    if (seq !== null) gateway.searchParams.set("seq", seq);
    return gateway;
  } catch {
    return null;
  }
}

/** Fixed archive paths: the caller cannot select an upstream host or path. */
export async function proxyConcordpackRequest(request: Request, documentId?: string, provenance = false): Promise<Response> {
  if (documentId !== undefined && !UUID.test(documentId)) return jsonError(404, "not_found");
  const importing = documentId === undefined;
  if (request.method !== (importing ? "POST" : "GET")) return jsonError(405, "method_not_allowed");
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 16_384 || !/^Bearer\s+\S+$/i.test(authorization)) return jsonError(401, "unauthorized");
  const target = gatewayUrl(documentId ?? "");
  if (!target) return jsonError(503, "concordpack_unavailable");
  target.pathname = target.pathname.replace(/\/documents\/[^/]*\/revisions$/, importing
    ? "/concordpack/import" : `/documents/${documentId}/concordpack${provenance ? "/provenance" : ""}`);
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (importing) {
    const query = new URL(request.url).searchParams;
    const required = ["requestId", "title", "publicKey", "documentId", "seq", "baseSnapshotSeq", "workspace"];
    if (required.some((key) => query.getAll(key).length !== 1) || [...query.keys()].some((key) =>
      ![...required, "revisionId"].includes(key) || query.getAll(key).length !== 1)) return jsonError(400, "invalid_request");
    if (!UUID.test(query.get("requestId")!) || !UUID.test(query.get("documentId")!) ||
      (query.has("revisionId") && !UUID.test(query.get("revisionId")!)) ||
      !/^[0-9a-f]{64}$/.test(query.get("publicKey")!) || query.get("workspace") !== "personal" ||
      !query.get("title")!.trim() || Array.from(query.get("title")!).length > 200 ||
      ["seq", "baseSnapshotSeq"].some((key) => !/^(0|[1-9][0-9]{0,18})$/.test(query.get(key)!) || BigInt(query.get(key)!) > 9223372036854775807n)) return jsonError(400, "invalid_request");
    target.search = query.toString();
    if (request.headers.get("content-type") !== "application/vnd.concord.concordpack") return jsonError(415, "concordpack_content_type_required");
    try {
      const bytes = await readRequestBytes(request, 64 * 1024 * 1024);
      if (bytes instanceof Response) return bytes;
      body = bytes;
    } catch { return jsonError(400, "invalid_request"); }
  }
  try {
    const response = await fetch(target, { method: request.method, headers: { authorization,
      ...(body ? { "content-type": "application/vnd.concord.concordpack" } : {}) }, body,
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(600_000) });
    return new Response(response.body, { status: response.status, headers: {
      "Cache-Control": "no-store", "Content-Type": response.headers.get("content-type") ?? "application/json",
      ...(response.headers.get("content-disposition") ? { "Content-Disposition": response.headers.get("content-disposition")! } : {}),
    } });
  } catch { return jsonError(503, "concordpack_unavailable"); }
}

async function checkpointBody(request: Request): Promise<{ label: string; targetSeq?: number } | Response> {
  const body = await readJsonRequest(request, MAX_BODY_BYTES);
  if (body instanceof Response) return body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return jsonError(400, "invalid_request");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "label" && key !== "targetSeq")) return jsonError(400, "invalid_request");
  if (typeof input.label !== "string" || !input.label.trim() || Array.from(input.label).length > 200) {
    return jsonError(400, "invalid_label");
  }
  if (input.targetSeq !== undefined && (!Number.isSafeInteger(input.targetSeq) || (input.targetSeq as number) < 0)) {
    return jsonError(400, "invalid_boundary");
  }
  return {
    label: input.label.trim(),
    ...(input.targetSeq === undefined ? {} : { targetSeq: input.targetSeq as number }),
  };
}

export async function proxyRevisionRequest(
  request: Request,
  documentId: string,
  segments: string[] = [],
): Promise<Response> {
  if (!UUID.test(documentId)) return jsonError(404, "not_found");
  const revisionId = segments[0];
  const restore = segments.length === 2 && segments[1] === "restore";
  if (segments.length > 2 || (revisionId !== undefined && !UUID.test(revisionId)) || (segments.length === 2 && !restore)) {
    return jsonError(404, "not_found");
  }
  if (revisionId === undefined && request.method !== "GET" && request.method !== "POST") return jsonError(405, "method_not_allowed");
  if (revisionId !== undefined && request.method !== (restore ? "POST" : "GET")) return jsonError(405, "method_not_allowed");

  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 16_384 || !/^Bearer\s+\S+$/i.test(authorization)) {
    return jsonError(401, "unauthorized");
  }

  const target = gatewayUrl(documentId, revisionId, restore);
  if (!target) return jsonError(503, "history_unavailable");
  let body: string | undefined;
  if (request.method === "POST" && !restore) {
    const parsed = await checkpointBody(request);
    if (parsed instanceof Response) return parsed;
    body = JSON.stringify(parsed);
  }
  if (request.method === "GET" && revisionId === undefined) {
    const query = new URL(request.url).searchParams;
    const limits = query.getAll("limit");
    if (limits.length > 1 || (limits[0] !== undefined && (!/^\d+$/.test(limits[0]) || Number(limits[0]) < 1 || Number(limits[0]) > 100))) {
      return jsonError(400, "invalid_limit");
    }
    if (limits[0]) target.searchParams.set("limit", limits[0]);
  }

  try {
    const response = await fetch(target, {
      method: request.method,
      headers: {
        authorization,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      redirect: "error",
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return jsonError(503, "gateway_unavailable");
  }
}

/**
 * GET /api/gateway/documents/{documentId}/proof — server-side proof fetch
 * (Feature 5). Same hardening surface as the revisions proxy: strict UUID,
 * bearer-only auth passthrough, no redirects, no caching, bounded query.
 */
export async function proxyProofRequest(
  request: Request,
  documentId: string,
): Promise<Response> {
  if (!UUID.test(documentId)) return jsonError(404, "not_found");
  if (request.method !== "GET") return jsonError(405, "method_not_allowed");

  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 16_384 || !/^Bearer\s+\S+$/i.test(authorization)) {
    return jsonError(401, "unauthorized");
  }

  const query = new URL(request.url).searchParams;
  const seq = query.get("seq");
  if (seq !== null && !/^\d{1,19}$/.test(seq)) return jsonError(400, "invalid_boundary");
  const target = proofUrl(documentId, seq);
  if (!target) return jsonError(503, "history_unavailable");

  try {
    const response = await fetch(target, {
      method: "GET",
      headers: { authorization, accept: "application/json" },
      cache: "no-store",
      redirect: "error",
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch {
    return jsonError(503, "gateway_unavailable");
  }
}

/** Shared reviews use the gateway's transaction, never the transitional save API. */
export async function proxyBranchRequest(request: Request, documentId: string, segments: string[] = []): Promise<Response> {
  if (!UUID.test(documentId) || segments.length > 2 || (segments[0] && !UUID.test(segments[0])) ||
    (segments.length === 2 && segments[1] !== "merge")) return jsonError(404, "not_found");
  const merge = segments.length === 2;
  if ((merge && request.method !== "POST") || (!merge && segments.length === 1 && request.method !== "GET") ||
    (!["GET", "POST"].includes(request.method))) return jsonError(405, "method_not_allowed");
  const authorization = request.headers.get("authorization");
  if (!authorization || authorization.length > 16_384 || !/^Bearer\s+\S+$/i.test(authorization)) return jsonError(401, "unauthorized");
  const target = gatewayUrl(documentId);
  if (!target) return jsonError(503, "branches_unavailable");
  target.pathname = target.pathname.replace(/\/revisions$/, "/branches") + (segments.length ? "/" + segments.join("/") : "");
  let body: string | undefined;
  if (request.method === "POST") {
    const parsed = await readJsonRequest(request, 128 * 1024);
    if (parsed instanceof Response) return parsed;
    body = JSON.stringify(parsed);
  }
  try {
    const response = await fetch(target, { method: request.method, headers: { authorization, accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, body,
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60_000) });
    return new Response(response.body, { status: response.status, headers: { "Cache-Control": "no-store",
      "Content-Type": response.headers.get("content-type") ?? "application/json" } });
  } catch { return jsonError(503, "gateway_unavailable"); }
}
