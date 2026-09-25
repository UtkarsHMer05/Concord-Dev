import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb, type Executor } from "../db/client";
import { documentSuggestions, users, type DocumentSuggestionRow } from "../db/schema";

/** Listed suggestions are bounded (200 newest); add keyset pagination if
 *  documents exceed this bound (same policy as comment threads). */
const SUGGESTION_LIMIT = 200;

export const suggestionsRepository = {
  async listSuggestions(documentId: string) {
    const rows = await getDb()
      .select({
        suggestion: documentSuggestions,
        authorName: users.displayName,
      })
      .from(documentSuggestions)
      .innerJoin(users, eq(documentSuggestions.createdByUserId, users.id))
      .where(eq(documentSuggestions.documentId, documentId))
      .orderBy(desc(documentSuggestions.createdAt), desc(documentSuggestions.id))
      .limit(SUGGESTION_LIMIT + 1);
    return {
      rows: rows
        .slice(0, SUGGESTION_LIMIT)
        .map(({ suggestion, authorName }) => ({ ...suggestion, authorName })),
      hasMore: rows.length > SUGGESTION_LIMIT,
    };
  },

  async findSuggestion(
    documentId: string,
    suggestionId: string,
    executor?: Executor,
  ): Promise<DocumentSuggestionRow | null> {
    const rows = await (executor ?? getDb())
      .select()
      .from(documentSuggestions)
      .where(
        and(eq(documentSuggestions.documentId, documentId), eq(documentSuggestions.id, suggestionId)),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /** Global id lookup for cross-document idempotency checks (comment pattern). */
  async findSuggestionById(suggestionId: string): Promise<DocumentSuggestionRow | null> {
    const rows = await getDb()
      .select()
      .from(documentSuggestions)
      .where(eq(documentSuggestions.id, suggestionId))
      .limit(1);
    return rows[0] ?? null;
  },
};
