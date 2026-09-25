import "server-only";

import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { getDb, type Executor } from "../db/client";
import {
  commentMessages,
  commentThreads,
  users,
  type CommentMessageRow,
  type CommentThreadRow,
} from "../db/schema";

const THREAD_LIMIT = 200;
/**
 * Messages are ranked per thread, not under one global cap: a single busy
 * thread must never push another listed thread's rows — including its own
 * root comment — out of the result. One extra row per thread is fetched to
 * report per-thread truncation.
 */
const MESSAGE_LIMIT_PER_THREAD = 50;

export const commentsRepository = {
  async listThreads(documentId: string) {
    const rows = await getDb()
      .select({ thread: commentThreads, authorName: users.displayName })
      .from(commentThreads)
      .innerJoin(users, eq(commentThreads.createdByUserId, users.id))
      .where(eq(commentThreads.documentId, documentId))
      .orderBy(desc(commentThreads.updatedAt), desc(commentThreads.id))
      // ponytail: latest 200 threads only; add keyset pagination if documents exceed this bound.
      .limit(THREAD_LIMIT + 1);
    return {
      rows: rows.slice(0, THREAD_LIMIT).map(({ thread, authorName }) => ({ ...thread, authorName })),
      hasMore: rows.length > THREAD_LIMIT,
    };
  },

  async listMessages(threadIds: string[]) {
    if (threadIds.length === 0) return { rows: [], hasMore: false };
    const ranked = getDb()
      .select({
        id: commentMessages.id,
        threadId: commentMessages.threadId,
        createdByUserId: commentMessages.createdByUserId,
        body: commentMessages.body,
        createdAt: commentMessages.createdAt,
        authorName: users.displayName,
        rank: sql<number>`(row_number() over (partition by ${commentMessages.threadId} order by ${commentMessages.createdAt} desc, ${commentMessages.id} desc))::int`.as("rank"),
      })
      .from(commentMessages)
      .innerJoin(users, eq(commentMessages.createdByUserId, users.id))
      .where(inArray(commentMessages.threadId, threadIds))
      .as("ranked");
    const rows = await getDb()
      .select({
        id: ranked.id,
        threadId: ranked.threadId,
        createdByUserId: ranked.createdByUserId,
        body: ranked.body,
        createdAt: ranked.createdAt,
        authorName: ranked.authorName,
        rank: ranked.rank,
      })
      .from(ranked)
      .where(lte(ranked.rank, MESSAGE_LIMIT_PER_THREAD + 1));
    return {
      rows: rows
        .filter((row) => row.rank <= MESSAGE_LIMIT_PER_THREAD)
        .map((row) => ({
          id: row.id,
          threadId: row.threadId,
          createdByUserId: row.createdByUserId,
          body: row.body,
          createdAt: row.createdAt,
          authorName: row.authorName,
        })),
      hasMore: rows.some((row) => row.rank > MESSAGE_LIMIT_PER_THREAD),
    };
  },

  async findThread(
    documentId: string,
    threadId: string,
    executor?: Executor,
  ): Promise<CommentThreadRow | null> {
    const rows = await (executor ?? getDb())
      .select()
      .from(commentThreads)
      .where(and(eq(commentThreads.documentId, documentId), eq(commentThreads.id, threadId)))
      .limit(1);
    return rows[0] ?? null;
  },

  async findThreadById(threadId: string, executor?: Executor): Promise<CommentThreadRow | null> {
    const rows = await (executor ?? getDb())
      .select()
      .from(commentThreads)
      .where(eq(commentThreads.id, threadId))
      .limit(1);
    return rows[0] ?? null;
  },

  async findThreadForUpdate(
    documentId: string,
    threadId: string,
    executor: Executor,
  ): Promise<CommentThreadRow | null> {
    const rows = await executor
      .select()
      .from(commentThreads)
      .where(and(eq(commentThreads.documentId, documentId), eq(commentThreads.id, threadId)))
      .limit(1)
      .for("update");
    return rows[0] ?? null;
  },

  async findMessage(messageId: string, executor?: Executor): Promise<CommentMessageRow | null> {
    const rows = await (executor ?? getDb())
      .select()
      .from(commentMessages)
      .where(eq(commentMessages.id, messageId))
      .limit(1);
    return rows[0] ?? null;
  },
};
