import { z } from "zod";
import { buildActorContext } from "@/server/auth/actor-context";
import { documentsService } from "@/server/services/documents";
import { permissionsService } from "@/server/services/permissions";
import { UnauthenticatedError, NotFoundError, ValidationError } from "@/server/errors";
import { readJsonRequest } from "@/server/request-body";

type Context = { params: Promise<{ documentId: string }> };
function errorResponse(error: unknown) {
  return Response.json({ error: error instanceof UnauthenticatedError ? "Sign in required" : error instanceof NotFoundError ? "Document unavailable" :
    error instanceof ValidationError ? error.message : "Sharing is temporarily unavailable" },
  { status: error instanceof UnauthenticatedError ? 401 : error instanceof NotFoundError ? 404 : error instanceof ValidationError ? 400 : 503 });
}
export async function GET(_request: Request, { params }: Context) {
  try {
    const actor = await buildActorContext(); const { documentId } = await params;
    const document = await documentsService.getDocument(actor, documentId);
    const canManage = document.effectiveRole === "OWNER";
    return Response.json({ collaborationId: actor.userId, canManage,
      grants: canManage ? await permissionsService.listGrants(actor, documentId) : [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const parsed = await readJsonRequest(request, 4096);
    if (parsed instanceof Response) return parsed;
    const body = z.discriminatedUnion("action", [
      z.object({ action: z.literal("grant"), targetUserId: z.uuid(), role: z.enum(["EDITOR", "COMMENTER", "VIEWER"]) }).strict(),
      z.object({ action: z.literal("revoke"), targetUserId: z.uuid() }).strict(),
    ]).safeParse(parsed);
    if (!body.success) return Response.json({ error: "Invalid sharing request" }, { status: 400 });
    const actor = await buildActorContext(); const { documentId } = await params;
    return Response.json(body.data.action === "grant" ? await permissionsService.grantPermission(actor, documentId, body.data) :
      await permissionsService.revokePermission(actor, documentId, body.data));
  } catch (error) { return errorResponse(error); }
}
