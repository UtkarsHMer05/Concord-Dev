import "server-only";

import type { DocumentRow, DocumentRole } from "../db/schema";
import { ForbiddenError } from "../errors";
import type { ActorContext } from "./actor-context";

/**
 * Central authorization policy (docs/AUTHORIZATION.md).
 *
 * Effective role precedence: OWNER (intrinsic) > direct ACL grant >
 * organization-derived EDITOR > deny. Roles are never additive.
 */

export type EffectiveRole = "OWNER" | "EDITOR" | "COMMENTER" | "VIEWER";

export const CAPABILITIES = {
  read: ["OWNER", "EDITOR", "COMMENTER", "VIEWER"],
  editContent: ["OWNER", "EDITOR"],
  rename: ["OWNER", "EDITOR"],
  delete: ["OWNER"],
  managePermissions: ["OWNER"],
  /** Create and reply to document comments. */
  comment: ["OWNER", "EDITOR", "COMMENTER"],
} as const satisfies Record<string, readonly EffectiveRole[]>;

export type Capability = keyof typeof CAPABILITIES;

/**
 * Resolves the actor's effective role on a document from verified inputs.
 * `directRole` is the actor's own ACL row for this document (or null).
 * Returns null when access must be denied (deny-by-default).
 */
export function resolveEffectiveRole(
  actor: ActorContext,
  document: Pick<DocumentRow, "ownerUserId" | "organizationId">,
  directRole: DocumentRole | null,
): EffectiveRole | null {
  if (document.ownerUserId === actor.userId) {
    return "OWNER";
  }
  if (directRole) {
    return directRole;
  }
  if (
    document.organizationId !== null &&
    actor.organization !== null &&
    document.organizationId === actor.organization.id
  ) {
    return "EDITOR";
  }
  return null;
}

/** Returns true when the role grants the capability. */
export function roleHasCapability(
  role: EffectiveRole | null,
  capability: Capability,
): boolean {
  if (!role) {
    return false;
  }
  return (CAPABILITIES[capability] as readonly EffectiveRole[]).includes(role);
}

/**
 * Throws ForbiddenError unless the role grants the capability; returns the
 * (non-null) effective role on success.
 */
export function assertCapability(
  role: EffectiveRole | null,
  capability: Capability,
): EffectiveRole {
  if (role === null || !roleHasCapability(role, capability)) {
    throw new ForbiddenError(`Missing ${capability} capability`);
  }
  return role;
}
