import { NextResponse } from "next/server";

import { buildActorContext } from "@/server/auth/actor-context";
import { commentsService } from "@/server/services/comments";

import { commentErrorResponse } from "../../response";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string; threadId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const actor = await buildActorContext();
    const { documentId, threadId } = await params;
    return NextResponse.json(
      await commentsService.addMessage(actor, documentId, threadId, body),
      { status: 201 },
    );
  } catch (error) {
    return commentErrorResponse(error);
  }
}
