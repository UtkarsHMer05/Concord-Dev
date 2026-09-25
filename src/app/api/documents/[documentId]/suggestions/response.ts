import { NextResponse } from "next/server";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "@/server/errors";

export function suggestionErrorResponse(error: unknown): NextResponse {
  if (error instanceof UnauthenticatedError) {
    return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  }
  if (error instanceof NotFoundError) {
    return NextResponse.json({ error: "Document or suggestion not found" }, { status: 404 });
  }
  if (error instanceof ForbiddenError) {
    return NextResponse.json({ error: "Suggestion access denied" }, { status: 403 });
  }
  if (error instanceof ValidationError) {
    return NextResponse.json({ error: "Invalid suggestion request" }, { status: 400 });
  }
  if (error instanceof ConflictError) {
    return NextResponse.json({ error: "Suggestion request conflicts with saved state" }, { status: 409 });
  }
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}
