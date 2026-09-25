import "server-only";

import { desc, eq } from "drizzle-orm";

import { getDb, type Executor } from "../db/client";
import { auditEvents, type AuditEventRow } from "../db/schema";

/**
 * Structured audit action names. Keep stable — audit consumers rely on them.
 */
export const AUDIT_ACTIONS = {
  documentCreate: "document.create",
  documentRename: "document.rename",
  documentDelete: "document.delete",
  documentPermissionGranted: "document.permission.granted",
  documentPermissionUpdated: "document.permission.updated",
  documentPermissionRevoked: "document.permission.revoked",
  documentCommentCreated: "document.comment.created",
  documentCommentReplied: "document.comment.replied",
  documentCommentResolved: "document.comment.resolved",
  documentSuggestionCreated: "document.suggestion.created",
  documentSuggestionResolved: "document.suggestion.resolved",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEventInput {
  actorUserId: string | null;
  action: AuditAction;
  resourceType: "document" | "document_permission" | "document_comment" | "document_suggestion";
  resourceId: string;
  organizationId: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit persistence. Events never contain secrets, tokens, or
 * document bodies — callers pass IDs, roles, and titles only.
 */
export const auditRepository = {
  async insert(input: AuditEventInput, executor?: Executor): Promise<AuditEventRow> {
    const db = executor ?? getDb();
    const rows = await db
      .insert(auditEvents)
      .values({
        actorUserId: input.actorUserId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        organizationId: input.organizationId,
        metadata: input.metadata ?? {},
      })
      .returning();
    if (!rows[0]) {
      throw new Error("Audit event insert failed");
    }
    return rows[0];
  },

  async listByResource(resourceId: string, executor?: Executor): Promise<AuditEventRow[]> {
    const db = executor ?? getDb();
    return db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, resourceId))
      .orderBy(desc(auditEvents.createdAt));
  },

  async listRecent(limit: number, executor?: Executor): Promise<AuditEventRow[]> {
    const db = executor ?? getDb();
    return db
      .select()
      .from(auditEvents)
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);
  },
};
