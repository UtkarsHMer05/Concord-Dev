import { NextResponse } from "next/server";
import { z } from "zod";

import { buildActorContext } from "@/server/auth/actor-context";
import { UnauthenticatedError } from "@/server/errors";
import { documentsService } from "@/server/services/documents";

const querySchema = z.object({
  search: z.string().max(200).default(""),
  // Preserve exact offsets because deleting a loaded row can make the next
  // request non-aligned with the page size.
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

/** Authorized, scoped document listing for client-side incremental loading. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    search: url.searchParams.get("search") ?? undefined,
    offset: url.searchParams.get("offset") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: { type: "validation", message: "Invalid query" } },
      { status: 400 },
    );
  }

  const { search, offset, limit } = parsed.data;

  try {
    const actor = await buildActorContext();
    const result = await documentsService.listDocuments(actor, {
      search,
      offset,
      pageSize: limit,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return NextResponse.json(
        { error: { type: "unauthenticated", message: "Sign in required" } },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: { type: "unknown", message: "Something went wrong" } },
      { status: 500 },
    );
  }
}
