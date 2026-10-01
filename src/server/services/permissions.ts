import "server-only";

import { z } from "zod";
import { clerkClient } from "@clerk/nextjs/server";

import { assertCapability } from "../auth/authorization";
import type { ActorContext } from "../auth/actor-context";
import type { DocumentRole } from "../db/schema";
import { getDb } from "../db/client";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { AUDIT_ACTIONS, auditRepository } from "../repositories/audit";
import { documentsRepository } from "../repositories/documents";
import { permissionsRepository } from "../repositories/permissions";
import { usersRepository } from "../repositories/users";
import { documentsService } from "./documents";

/**
 * Direct document ACL management (docs/AUTHORIZATION.md §6):
 * - OWNER-only management;
 * - grantable roles are EDITOR / COMMENTER / VIEWER (never OWNER);
 * - grants for the owner are rejected (ownership is intrinsic);
 * - every change writes an audit event.
 *
 * The Share tab and its authenticated route use this same service.
 */

export const GRANTABLE_ROLES: readonly DocumentRole[] = [
  "EDITOR",
  "COMMENTER",
  "VIEWER",
];

const targetUserIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "Invalid target user id",
  );

const roleSchema = z.enum(["EDITOR", "COMMENTER", "VIEWER"]);

async function requireOwnedDocument(actor: ActorContext, documentId: string) {
  const document = await documentsRepository.findById(documentId);
  if (!document) {
    throw new NotFoundError("Document not found");
  }
  const grant = await permissionsRepository.findGrant(documentId, actor.userId);
  const effective =
    document.ownerUserId === actor.userId
      ? "OWNER"
      : (grant?.role ?? null);
  try {
    assertCapability(effective, "managePermissions");
  } catch (error) {
    if (error instanceof ForbiddenError) {
      throw new NotFoundError("Document not found");
    }
    throw error;
  }
  return document;
}

function validateTarget(actor: ActorContext, targetUserId: unknown): string {
  const parsed = targetUserIdSchema.safeParse(targetUserId);
  if (!parsed.success) {
    throw new ValidationError("Invalid target user");
  }
  if (parsed.data === actor.userId) {
    // Self-grant would be redundant for the owner and privilege escalation
    // for anyone else; reject explicitly.
    throw new ValidationError("Cannot grant permissions to yourself");
  }
  return parsed.data;
}

export const permissionsService = {
  /** Grants (or updates) a direct role for a target user. OWNER-only. */
  async grantPermission(
    actor: ActorContext,
    documentId: unknown,
    input: { targetUserId?: unknown; email?: unknown; role: unknown },
  ): Promise<{ role: DocumentRole }> {
    const idSchema = z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const idParsed = idSchema.safeParse(documentId);
    if (!idParsed.success) {
      throw new ValidationError("Invalid document id");
    }
    const document = await requireOwnedDocument(actor, idParsed.data);
    const role = roleSchema.safeParse(input.role);
    if (!role.success) {
      throw new ValidationError("Invalid role");
    }

    // Ownership is checked before account lookup: this is not a public directory.
    let target = input.targetUserId;
    if (input.email !== undefined) {
      if (target !== undefined) throw new ValidationError("Use either email or collaboration ID");
      const parsed = z.email().max(254).safeParse(typeof input.email === "string" ? input.email.trim().toLowerCase() : input.email);
      if (!parsed.success) throw new ValidationError("Enter a valid email address");
      const client = await clerkClient();
      const result = await client.users.getUserList({ emailAddress: [parsed.data], limit: 100 });
      const matches = result.data.filter((user) => user.emailAddresses.some((address) =>
        address.emailAddress.toLowerCase() === parsed.data && address.verification?.status === "verified"));
      if (matches.length !== 1) throw new ValidationError("No account with this verified email. Ask them to sign up and verify their email, then try again.");
      target = (await usersRepository.findOrCreateByClerkUserId(matches[0].id)).id;
    }
    const targetUserId = validateTarget(actor, target);

    const targetUser = await usersRepository.findById(targetUserId);
    if (!targetUser) {
      throw new ValidationError("Target user does not exist");
    }
    if (targetUser.id === document.ownerUserId) {
      throw new ValidationError("Cannot change the owner's role");
    }

    return getDb().transaction(async (tx) => {
      const existing = await permissionsRepository.findGrant(document.id, targetUserId, tx);
      const row = await permissionsRepository.upsertGrant({
        documentId: document.id,
        userId: targetUserId,
        role: role.data,
        grantedByUserId: actor.userId,
      }, tx);
      await auditRepository.insert({
        actorUserId: actor.userId,
        action: existing
          ? AUDIT_ACTIONS.documentPermissionUpdated
          : AUDIT_ACTIONS.documentPermissionGranted,
        resourceType: "document_permission",
        resourceId: document.id,
        organizationId: document.organizationId,
        metadata: { targetUserId, role: role.data },
      }, tx);
      return { role: row.role };
    });
  },

  /** Revokes a direct role. OWNER-only. Revoking a non-existent grant is a no-op success. */
  async revokePermission(
    actor: ActorContext,
    documentId: unknown,
    input: { targetUserId: unknown },
  ): Promise<{ revoked: boolean }> {
    const idSchema = z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const idParsed = idSchema.safeParse(documentId);
    if (!idParsed.success) {
      throw new ValidationError("Invalid document id");
    }
    const document = await requireOwnedDocument(actor, idParsed.data);
    const targetUserId = validateTarget(actor, input.targetUserId);

    return getDb().transaction(async (tx) => {
      const revoked = await permissionsRepository.deleteGrant(document.id, targetUserId, tx);
      if (revoked) {
        await auditRepository.insert({
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.documentPermissionRevoked,
          resourceType: "document_permission",
          resourceId: document.id,
          organizationId: document.organizationId,
          metadata: { targetUserId },
        }, tx);
      }
      return { revoked };
    });
  },

  /** Lists direct grants for a document. OWNER-only (management view). */
  async listGrants(actor: ActorContext, documentId: unknown) {
    const idSchema = z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const idParsed = idSchema.safeParse(documentId);
    if (!idParsed.success) {
      throw new ValidationError("Invalid document id");
    }
    const document = await requireOwnedDocument(actor, idParsed.data);
    return permissionsRepository.listByDocument(document.id);
  },

  async getSharing(actor: ActorContext, documentId: unknown, statusOnly = false) {
    const document = await documentsService.getDocument(actor, documentId);
    const status = { collaborationId: actor.userId, canManage: document.effectiveRole === "OWNER",
      effectiveRole: document.effectiveRole, organizationAccess: document.organizationId !== null };
    if (statusOnly || !status.canManage) return { ...status, grants: [], owner: null, profileWarning: false };
    const grants = await permissionsRepository.listPeople(document.id);
    const owner = await usersRepository.findById(actor.userId);
    const people = [{ userId: actor.userId, clerkUserId: actor.clerkUserId, displayName: owner?.displayName ?? null, role: "OWNER" as const }, ...grants];
    const profiles = new Map<string, { name: string; email: string | null }>();
    let profileWarning = false;
    try {
      const client = await clerkClient();
      for (let offset = 0; offset < people.length; offset += 100) {
        const page = await client.users.getUserList({ userId: people.slice(offset, offset + 100).map((person) => person.clerkUserId), limit: 100 });
        for (const user of page.data) {
          const email = user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId && address.verification?.status === "verified")?.emailAddress ?? null;
          profiles.set(user.id, { name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || email || "Collaborator", email });
        }
      }
    } catch { profileWarning = true; } // Access management still works if profile lookup is unavailable.
    const describe = (person: typeof people[number]) => ({ userId: person.userId, role: person.role,
      name: profiles.get(person.clerkUserId)?.name ?? person.displayName ?? person.userId,
      email: profiles.get(person.clerkUserId)?.email ?? null });
    return { ...status, owner: describe(people[0]), grants: grants.map(describe), profileWarning };
  },
};
