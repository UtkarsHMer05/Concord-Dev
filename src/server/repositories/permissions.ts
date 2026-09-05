import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb, type Executor } from "../db/client";
import {
  documentUserPermissions,
  type DocumentRole,
  type DocumentUserPermissionRow,
} from "../db/schema";

/**
 * Direct user-per-document grants. OWNER is intentionally not expressible
 * here — ownership lives on documents.owner_user_id (docs/AUTHORIZATION.md).
 */
export const permissionsRepository = {
  async findGrant(
    documentId: string,
    userId: string,
    executor?: Executor,
  ): Promise<DocumentUserPermissionRow | null> {
    const db = executor ?? getDb();
    const rows = await db
      .select()
      .from(documentUserPermissions)
      .where(
        and(
          eq(documentUserPermissions.documentId, documentId),
          eq(documentUserPermissions.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertGrant(
    values: {
      documentId: string;
      userId: string;
      role: DocumentRole;
      grantedByUserId: string | null;
    },
    executor?: Executor,
  ): Promise<DocumentUserPermissionRow> {
    const db = executor ?? getDb();
    const rows = await db
      .insert(documentUserPermissions)
      .values(values)
      .onConflictDoUpdate({
        target: [
          documentUserPermissions.documentId,
          documentUserPermissions.userId,
        ],
        set: {
          role: values.role,
          grantedByUserId: values.grantedByUserId,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!rows[0]) {
      throw new Error("Grant upsert failed");
    }
    return rows[0];
  },

  async deleteGrant(
    documentId: string,
    userId: string,
    executor?: Executor,
  ): Promise<boolean> {
    const db = executor ?? getDb();
    const rows = await db
      .delete(documentUserPermissions)
      .where(
        and(
          eq(documentUserPermissions.documentId, documentId),
          eq(documentUserPermissions.userId, userId),
        ),
      )
      .returning({ id: documentUserPermissions.id });
    return rows.length > 0;
  },

  async listByDocument(
    documentId: string,
    executor?: Executor,
  ): Promise<DocumentUserPermissionRow[]> {
    const db = executor ?? getDb();
    return db
      .select()
      .from(documentUserPermissions)
      .where(eq(documentUserPermissions.documentId, documentId));
  },
};
