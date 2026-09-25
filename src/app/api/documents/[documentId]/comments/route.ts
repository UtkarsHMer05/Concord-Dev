import { NextResponse } from "next/server";

import { buildActorContext } from "@/server/auth/actor-context";
import { commentsService } from "@/server/services/comments";

import { commentErrorResponse } from "./response";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const actor = await buildActorContext();
    const { documentId } = await params;
    return NextResponse.json(await commentsService.list(actor, documentId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return commentErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const actor = await buildActorContext();
    const { documentId } = await params;
    return NextResponse.json(await commentsService.createThread(actor, documentId, body), {
      status: 201,
    });
  } catch (error) {
    return commentErrorResponse(error);
  }
}
