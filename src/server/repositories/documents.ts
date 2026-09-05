import "server-only";

import { and, eq, ilike, sql } from "drizzle-orm";

import { getDb, type Executor } from "../db/client";
import { documents, type DocumentRow } from "../db/schema";

/** Escapes SQL LIKE wildcards so user input matches literally. */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const DOCUMENT_COLUMNS = {
  id: documents.id,
  title: documents.title,
  ownerUserId: documents.ownerUserId,
  organizationId: documents.organizationId,
  initialContent: documents.initialContent,
  content: documents.content,
  contentVersion: documents.contentVersion,
  metadataVersion: documents.metadataVersion,
  legacyConvexId: documents.legacyConvexId,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
};

export interface ListOptions {
  limit: number;
  offset: number;
  /** Pre-escaped substring pattern (use escapeLikePattern), or null for no search. */
  titlePattern?: string | null;
}

/**
 * Durable document persistence. Authorization is NOT this module's concern —
 * services resolve the actor's effective role before calling these methods.
 */
export const documentsRepository = {
  async findById(id: string, executor?: Executor): Promise<DocumentRow | null> {
    const db = executor ?? getDb();
    const rows = await db
      .select(DOCUMENT_COLUMNS)
      .from(documents)
      .where(eq(documents.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  async insert(
    values: {
      title: string;
      ownerUserId: string;
      organizationId: string | null;
      initialContent: string | null;
    },
    executor?: Executor,
  ): Promise<DocumentRow> {
    const db = executor ?? getDb();
    const rows = await db.insert(documents).values(values).returning();
    if (!rows[0]) {
      throw new Error("Document insert failed");
    }
    return rows[0];
  },

  /** Personal workspace listing (optionally filtered by title substring). */
  async listByOwner(
    ownerUserId: string,
    { limit, offset, titlePattern }: ListOptions,
    executor?: Executor,
  ): Promise<DocumentRow[]> {
    const db = executor ?? getDb();
    return db
      .select(DOCUMENT_COLUMNS)
      .from(documents)
      .where(
        titlePattern
          ? and(
              eq(documents.ownerUserId, ownerUserId),
              ilike(documents.title, `%${titlePattern}%`),
            )
          : eq(documents.ownerUserId, ownerUserId),
      )
      .orderBy(sql`${documents.updatedAt} DESC`, sql`${documents.id} DESC`)
      .limit(limit)
      .offset(offset);
  },

  /** Organization workspace listing (optionally filtered by title substring). */
  async listByOrganization(
    organizationId: string,
    { limit, offset, titlePattern }: ListOptions,
    executor?: Executor,
  ): Promise<DocumentRow[]> {
    const db = executor ?? getDb();
    return db
      .select(DOCUMENT_COLUMNS)
      .from(documents)
      .where(
        titlePattern
          ? and(
              eq(documents.organizationId, organizationId),
              ilike(documents.title, `%${titlePattern}%`),
            )
          : eq(documents.organizationId, organizationId),
      )
      .orderBy(sql`${documents.updatedAt} DESC`, sql`${documents.id} DESC`)
      .limit(limit)
      .offset(offset);
  },

  /**
   * Optimistic-concurrency content save: applies only when the stored
   * content version still equals the caller's expected version. Returns the
   * updated row, or null when the version did not match (conflict) / the
   * document no longer exists.
   */
  async updateContentConditional(
    id: string,
    expectedContentVersion: number,
    content: unknown,
    executor?: Executor,
  ): Promise<DocumentRow | null> {
    const db = executor ?? getDb();
    const rows = await db
      .update(documents)
      .set({
        content: content as DocumentRow["content"],
        contentVersion: sql`${documents.contentVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documents.id, id),
          eq(documents.contentVersion, expectedContentVersion),
        ),
      )
      .returning(DOCUMENT_COLUMNS);
    return rows[0] ?? null;
  },

  /**
   * Optimistic-concurrency rename: applies only when the stored metadata
   * version still equals the caller's expected version.
   */
  async renameConditional(
    id: string,
    expectedMetadataVersion: number,
    title: string,
    executor?: Executor,
  ): Promise<DocumentRow | null> {
    const db = executor ?? getDb();
    const rows = await db
      .update(documents)
      .set({
        title,
        metadataVersion: sql`${documents.metadataVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documents.id, id),
          eq(documents.metadataVersion, expectedMetadataVersion),
        ),
      )
      .returning(DOCUMENT_COLUMNS);
    return rows[0] ?? null;
  },

  async deleteById(id: string, executor?: Executor): Promise<boolean> {
    const db = executor ?? getDb();
    const rows = await db
      .delete(documents)
      .where(eq(documents.id, id))
      .returning({ id: documents.id });
    return rows.length > 0;
  },

  async countByOwner(ownerUserId: string, executor?: Executor): Promise<number> {
    const db = executor ?? getDb();
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(documents)
      .where(eq(documents.ownerUserId, ownerUserId));
    return rows[0]?.count ?? 0;
  },

  /** Test/migration helper: exists-check by legacy id. */
  async findByLegacyConvexId(
    legacyConvexId: string,
    executor?: Executor,
  ): Promise<DocumentRow | null> {
    const db = executor ?? getDb();
    const rows = await db
      .select(DOCUMENT_COLUMNS)
      .from(documents)
      .where(eq(documents.legacyConvexId, legacyConvexId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Test helper used by concurrency suites to observe version progression. */
  async contentVersionOf(id: string, executor?: Executor): Promise<number | null> {
    const row = await this.findById(id, executor);
    return row?.contentVersion ?? null;
  },
};
