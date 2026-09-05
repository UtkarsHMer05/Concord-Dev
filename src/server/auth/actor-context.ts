import "server-only";

import { auth } from "@clerk/nextjs/server";

import { UnauthenticatedError } from "../errors";
import {
  membershipsRepository,
  organizationsRepository,
} from "../repositories/organizations";
import { usersRepository } from "../repositories/users";
import type { OrganizationMemberRole } from "../db/schema";

/**
 * Server-only, verified actor representation used for every authorization
 * decision. Built from Clerk's server APIs + local principal projection —
 * never from client-supplied fields.
 */
export interface ActorOrganization {
  id: string;
  clerkOrganizationId: string;
  role: OrganizationMemberRole;
}

export interface ActorContext {
  /** Local Concord user ID. */
  userId: string;
  clerkUserId: string;
  /** Verified active organization, or null in the personal workspace. */
  organization: ActorOrganization | null;
}

function normalizeClerkOrgRole(orgRole: string | null | undefined): OrganizationMemberRole {
  // Clerk emits "org:admin" / "org:member" (and custom roles); treat anything
  // explicitly admin-shaped as admin, everything else as plain member.
  return orgRole && orgRole.includes("admin") ? "admin" : "member";
}

/**
 * Builds the ActorContext for the current request:
 * 1. Resolves the verified Clerk user (throws UnauthenticatedError if none).
 * 2. Projects the local user row (idempotent).
 * 3. When an active organization claim is present, projects the local
 *    organization + membership (idempotent, keeps role fresh per request).
 *
 * A request can never select an organization scope through its own payload —
 * only the verified session claim can.
 */
export async function buildActorContext(): Promise<ActorContext> {
  const clerk = await auth();

  if (!clerk.userId) {
    throw new UnauthenticatedError();
  }

  const user = await usersRepository.findOrCreateByClerkUserId(clerk.userId);

  if (clerk.orgId) {
    const role = normalizeClerkOrgRole(clerk.orgRole);
    const organization = await organizationsRepository.findOrCreateByClerkOrganizationId(
      clerk.orgId,
    );
    // Keep the local membership authoritative-ish: this request's verified
    // claim wins (covers role changes; revocation removes the claim entirely,
    // which lands in the personal branch below).
    await membershipsRepository.upsert(organization.id, user.id, role);
    return {
      userId: user.id,
      clerkUserId: clerk.userId,
      organization: {
        id: organization.id,
        clerkOrganizationId: clerk.orgId,
        role,
      },
    };
  }

  return {
    userId: user.id,
    clerkUserId: clerk.userId,
    organization: null,
  };
}
