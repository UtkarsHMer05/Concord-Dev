import "server-only";

import { z } from "zod";

import { assertCapability } from "../auth/authorization";
import type { ActorContext } from "../auth/actor-context";
import type { DocumentRole } from "../db/schema";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { AUDIT_ACTIONS, auditRepository } from "../repositories/audit";
import { documentsRepository } from "../repositories/documents";
import { permissionsRepository } from "../repositories/permissions";
import { usersRepository } from "../repositories/users";

/**
 * Direct document ACL management (docs/AUTHORIZATION.md §6):
 * - OWNER-only management;
 * - grantable roles are EDITOR / COMMENTER / VIEWER (never OWNER);
 * - grants for the owner are rejected (ownership is intrinsic);
 * - every change writes an audit event.
 *
 * There is no sharing UI in Phase 1; this service is exercised by tests and
 * forms the foundation for the later sharing product surface.
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
    input: { targetUserId: unknown; role: unknown },
  ): Promise<{ role: DocumentRole }> {
    const idSchema = z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const idParsed = idSchema.safeParse(documentId);
    if (!idParsed.success) {
      throw new ValidationError("Invalid document id");
    }
    const document = await requireOwnedDocument(actor, idParsed.data);
    const targetUserId = validateTarget(actor, input.targetUserId);
    const role = roleSchema.safeParse(input.role);
    if (!role.success) {
      throw new ValidationError("Invalid role");
    }

    const targetUser = await usersRepository.findById(targetUserId);
    if (!targetUser) {
      throw new ValidationError("Target user does not exist");
    }
    if (targetUser.id === document.ownerUserId) {
      throw new ValidationError("Cannot change the owner's role");
    }

    const existing = await permissionsRepository.findGrant(
      document.id,
      targetUserId,
    );
    const row = await permissionsRepository.upsertGrant({
      documentId: document.id,
      userId: targetUserId,
      role: role.data,
      grantedByUserId: actor.userId,
    });

    await auditRepository.insert({
      actorUserId: actor.userId,
      action: existing
        ? AUDIT_ACTIONS.documentPermissionUpdated
        : AUDIT_ACTIONS.documentPermissionGranted,
      resourceType: "document_permission",
      resourceId: document.id,
      organizationId: document.organizationId,
      metadata: { targetUserId, role: role.data },
    });

    return { role: row.role };
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

    const revoked = await permissionsRepository.deleteGrant(
      document.id,
      targetUserId,
    );
    if (revoked) {
      await auditRepository.insert({
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentPermissionRevoked,
        resourceType: "document_permission",
        resourceId: document.id,
        organizationId: document.organizationId,
        metadata: { targetUserId },
      });
    }
    return { revoked };
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
};
