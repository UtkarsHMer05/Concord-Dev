import { z } from "zod";
import { buildActorContext } from "@/server/auth/actor-context";
import { permissionsService } from "@/server/services/permissions";
import { UnauthenticatedError, NotFoundError, ValidationError } from "@/server/errors";
import { readJsonRequest } from "@/server/request-body";
import { getWebSecurityConfig } from "@/server/env";

type Context = { params: Promise<{ documentId: string }> };
function errorResponse(error: unknown) {
  return Response.json({ error: error instanceof UnauthenticatedError ? "Sign in required" : error instanceof NotFoundError ? "Document unavailable" :
    error instanceof ValidationError ? error.message : "Sharing is temporarily unavailable" },
  { status: error instanceof UnauthenticatedError ? 401 : error instanceof NotFoundError ? 404 : error instanceof ValidationError ? 400 : 503 });
}
export async function GET(request: Request, { params }: Context) {
  try {
    const actor = await buildActorContext(); const { documentId } = await params;
    return Response.json(await permissionsService.getSharing(actor, documentId, new URL(request.url).searchParams.get("status") === "1"), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const origin = request.headers.get("origin");
    const url = new URL(request.url);
    // Standalone request URLs use the bind address; Host is browser-facing.
    const expectedOrigin = getWebSecurityConfig().appOrigin ?? `${url.protocol}//${request.headers.get("host") ?? url.host}`;
    if ((origin && origin !== expectedOrigin) || request.headers.get("sec-fetch-site") === "cross-site") return Response.json({ error: "Use the Share dialog on this site" }, { status: 403 });
    const parsed = await readJsonRequest(request, 4096);
    if (parsed instanceof Response) return parsed;
    const body = z.union([
      z.object({ action: z.literal("grant"), targetUserId: z.uuid(), role: z.enum(["EDITOR", "COMMENTER", "VIEWER"]) }).strict(),
      z.object({ action: z.literal("grant"), email: z.email().max(254), role: z.enum(["EDITOR", "COMMENTER", "VIEWER"]) }).strict(),
      z.object({ action: z.literal("revoke"), targetUserId: z.uuid() }).strict(),
    ]).safeParse(parsed);
    if (!body.success) return Response.json({ error: "Invalid sharing request" }, { status: 400 });
    const actor = await buildActorContext(); const { documentId } = await params;
    return Response.json(body.data.action === "grant" ? await permissionsService.grantPermission(actor, documentId, body.data) :
      await permissionsService.revokePermission(actor, documentId, body.data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
