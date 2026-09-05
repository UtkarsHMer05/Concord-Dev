import "server-only";

import { asc, eq } from "drizzle-orm";

import { getDb, type Executor } from "../db/client";
import {
  users,
  type UserRow,
} from "../db/schema";

/**
 * Local principal projection: verified Clerk identities mapped to durable
 * Concord users. Idempotent — concurrent first requests converge on one row
 * (unique constraint + ON CONFLICT DO NOTHING + re-read).
 */
export const usersRepository = {
  async findOrCreateByClerkUserId(
    clerkUserId: string,
    executor?: Executor,
  ): Promise<UserRow> {
    const db = executor ?? getDb();

    const existing = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);
    if (existing[0]) {
      return existing[0];
    }

    const inserted = await db
      .insert(users)
      .values({ clerkUserId })
      .onConflictDoNothing({ target: users.clerkUserId })
      .returning();
    if (inserted[0]) {
      return inserted[0];
    }

    const raced = await db
      .select()
      .from(users)
      .where(eq(users.clerkUserId, clerkUserId))
      .limit(1);
    if (!raced[0]) {
      throw new Error(`User projection failed for ${clerkUserId}`);
    }
    return raced[0];
  },

  async findById(id: string, executor?: Executor): Promise<UserRow | null> {
    const db = executor ?? getDb();
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async listAll(executor?: Executor): Promise<UserRow[]> {
    const db = executor ?? getDb();
    return db.select().from(users).orderBy(asc(users.createdAt));
  },
};
