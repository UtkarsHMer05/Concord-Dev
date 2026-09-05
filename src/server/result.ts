import "server-only";

import {
  ConflictError,
  DependencyError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from "./errors";

/**
 * Typed result envelope for server actions. Client components branch on
 * `ok` and receive stable, non-leaky error categories + UI-safe messages.
 */
export type ActionErrorType =
  | "unauthenticated"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "validation"
  | "dependency"
  | "unknown";

export interface ActionError {
  type: ActionErrorType;
  message: string;
}

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ActionError };

const USER_SAFE_MESSAGES: Record<ActionErrorType, string> = {
  unauthenticated: "You must be signed in.",
  not_found: "Document not found.",
  forbidden: "You do not have permission to do that.",
  conflict: "Document was modified in another tab. Reload to continue.",
  validation: "That input is not valid.",
  dependency: "The database is unavailable. Try again shortly.",
  unknown: "Something went wrong.",
};

/** Maps any thrown error to a client-safe action error (no internals leak). */
export function toActionError(error: unknown): ActionError {
  let type: ActionErrorType;
  if (error instanceof UnauthenticatedError) {
    type = "unauthenticated";
  } else if (error instanceof NotFoundError) {
    type = "not_found";
  } else if (error instanceof ForbiddenError) {
    type = "forbidden";
  } else if (error instanceof ConflictError) {
    type = "conflict";
  } else if (error instanceof ValidationError) {
    type = "validation";
  } else if (error instanceof DependencyError) {
    type = "dependency";
  } else {
    type = "unknown";
  }
  return { type, message: USER_SAFE_MESSAGES[type] };
}

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail(error: unknown): ActionResult<never> {
  return { ok: false, error: toActionError(error) };
}
