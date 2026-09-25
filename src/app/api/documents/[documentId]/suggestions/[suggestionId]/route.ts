import { NextResponse } from "next/server";

import { buildActorContext } from "@/server/auth/actor-context";
import { suggestionsService } from "@/server/services/suggestions";

import { suggestionErrorResponse } from "../response";


export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string; suggestionId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    const actor = await buildActorContext();
    const { documentId, suggestionId } = await params;
    return NextResponse.json(
      await suggestionsService.resolve(actor, documentId, suggestionId, body),
    );
  } catch (error) {
    return suggestionErrorResponse(error);
  }
}
