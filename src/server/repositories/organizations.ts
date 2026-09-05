import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb, type Executor } from "../db/client";
import {
  organizationMemberships,
  organizations,
  type OrganizationMembershipRow,
  type OrganizationMemberRole,
  type OrganizationRow,
} from "../db/schema";

/**
 * Local organization + membership projection from verified Clerk context.
 * Idempotent (unique constraints + ON CONFLICT) so concurrent projections and
 * role changes converge deterministically.
 */
export const organizationsRepository = {
  async findOrCreateByClerkOrganizationId(
    clerkOrganizationId: string,
    executor?: Executor,
  ): Promise<OrganizationRow> {
    const db = executor ?? getDb();

    const existing = await db
      .select()
      .from(organizations)
      .where(eq(organizations.clerkOrganizationId, clerkOrganizationId))
      .limit(1);
    if (existing[0]) {
      return existing[0];
    }

    const inserted = await db
      .insert(organizations)
      .values({ clerkOrganizationId })
      .onConflictDoNothing({ target: organizations.clerkOrganizationId })
      .returning();
    if (inserted[0]) {
      return inserted[0];
    }

    const raced = await db
      .select()
      .from(organizations)
      .where(eq(organizations.clerkOrganizationId, clerkOrganizationId))
      .limit(1);
    if (!raced[0]) {
      throw new Error(
        `Organization projection failed for ${clerkOrganizationId}`,
      );
    }
    return raced[0];
  },

  async findById(id: string, executor?: Executor): Promise<OrganizationRow | null> {
    const db = executor ?? getDb();
    const rows = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
};

export const membershipsRepository = {
  async upsert(
    organizationId: string,
    userId: string,
    role: OrganizationMemberRole,
    executor?: Executor,
  ): Promise<OrganizationMembershipRow> {
    const db = executor ?? getDb();
    const rows = await db
      .insert(organizationMemberships)
      .values({ organizationId, userId, role })
      .onConflictDoUpdate({
        target: [
          organizationMemberships.organizationId,
          organizationMemberships.userId,
        ],
        set: { role, updatedAt: new Date() },
      })
      .returning();
    if (!rows[0]) {
      throw new Error("Membership upsert failed");
    }
    return rows[0];
  },

  async findMembership(
    organizationId: string,
    userId: string,
    executor?: Executor,
  ): Promise<OrganizationMembershipRow | null> {
    const db = executor ?? getDb();
    const rows = await db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, organizationId),
          eq(organizationMemberships.userId, userId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },
};
