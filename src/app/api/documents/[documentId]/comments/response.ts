import { NextResponse } from "next/server";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/server/errors";

export function commentErrorResponse(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (error instanceof NotFoundError) {
    return NextResponse.json({ error: "Document or comment not found" }, { status: 404 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: "Comment access denied" }, { status: 403 });
  }
  if (error instanceof ValidationError) {
    return NextResponse.json({ error: "Invalid comment request" }, { status: 400 });
  }
  if (error instanceof ConflictError) {
    return NextResponse.json({ error: "Comment request conflicts with saved state" }, { status: 409 });
  }
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
