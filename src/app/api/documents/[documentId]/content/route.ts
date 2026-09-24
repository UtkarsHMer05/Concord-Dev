import { NextResponse } from "next/server";
import { z } from "zod";

import { buildActorContext } from "@/server/auth/actor-context";
import {
  ConflictError,
  DependencyError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/server/errors";
import { documentsService } from "@/server/services/documents";

/**
 * TRANSITIONAL pre-CRDT content save endpoint (Phase 1).
 *
 * The high-frequency, client-driven write path for the debounced editor
 * autosave. Replaced by the CRDT update-log sync path in Phases 2–3; do not
 * build on this as the final collaboration protocol.
 *
 * Every request reauthenticates and reauthorizes; a stale expected content
 * version yields 409 rather than overwriting newer server content.
 */

const saveSchema = z.object({
  content: z.object({ v: z.literal(1), doc: z.unknown() }).passthrough(),
  expectedContentVersion: z.number().int().min(1),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { type: "validation", message: "Invalid JSON body" } },
      { status: 400 },
    );
  }

  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { type: "validation", message: "Invalid save payload" } },
      { status: 400 },
    );
  }

  try {
    const actor = await buildActorContext();
    const result = await documentsService.saveDocumentContent(
      actor,
      documentId,
      {
        content: parsed.data.content,
        expectedContentVersion: parsed.data.expectedContentVersion,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json(
        { error: { type: "unauthenticated", message: "Sign in required" } },
        { status: 401 },
      );
    }
    if (error instanceof ValidationError) {
      return NextResponse.json(
        { error: { type: "validation", message: "Invalid save payload" } },
        { status: 400 },
      );
    }
    if (error instanceof NotFoundError) {
      return NextResponse.json(
        { error: { type: "not_found", message: "Document not found" } },
        { status: 404 },
      );
    }
    if (error instanceof ForbiddenError) {
      return NextResponse.json(
        { error: { type: "forbidden", message: "Not allowed" } },
        { status: 403 },
      );
    }
    if (error instanceof ConflictError) {
      return NextResponse.json(
        { error: { type: "conflict", message: "Content version conflict" } },
        { status: 409 },
      );
    }
    if (error instanceof DependencyError) {
      return NextResponse.json(
        { error: { type: "dependency", message: "Database unavailable" } },
        { status: 503 },
      );
    }
    return NextResponse.json(
      { error: { type: "unknown", message: "Something went wrong" } },
      { status: 500 },
    );
  }
}
