/**
 * Typed domain errors shared across the server layer.
 *
 * Services throw these; one mapping layer (server actions / route handlers)
 * converts them to client outcomes. `NotFoundError` is intentionally used for
 * both missing resources and resources the actor is not allowed to know
 * exist (no existence leak — see docs/AUTHORIZATION.md §5).
 */

export class DomainError extends Error {
  constructor(
    message = "",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UnauthenticatedError extends DomainError {}
export class NotFoundError extends DomainError {}
export class ForbiddenError extends DomainError {}
export class ConflictError extends DomainError {}
export class ValidationError extends DomainError {}
export class DependencyError extends DomainError {}
