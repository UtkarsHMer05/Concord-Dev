import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  membershipsRepository,
  organizationsRepository,
} from "../../src/server/repositories/organizations";
import { usersRepository } from "../../src/server/repositories/users";
import { getTestPool, truncateAll } from "./helpers";

/**
 * M019/M020: principal projection (users, organizations, memberships) —
 * idempotency, uniqueness, and concurrent-projection safety against real
 * PostgreSQL.
 */

describe("principal projection", () => {
  let pool: ReturnType<typeof getTestPool>;

  beforeAll(() => {
    pool = getTestPool();
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("users", () => {
    it("creates a user once and returns the same row on repeat lookups", async () => {
      const first = await usersRepository.findOrCreateByClerkUserId("user_a");
      const second = await usersRepository.findOrCreateByClerkUserId("user_a");
      expect(second.id).toBe(first.id);
      const count = await pool.query("SELECT count(*)::int AS c FROM users");
      expect(count.rows[0].c).toBe(1);
    });

    it("separates distinct Clerk identities", async () => {
      const a = await usersRepository.findOrCreateByClerkUserId("user_a");
      const b = await usersRepository.findOrCreateByClerkUserId("user_b");
      expect(a.id).not.toBe(b.id);
    });

    it("survives concurrent first projection without duplicates", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          usersRepository.findOrCreateByClerkUserId("user_race"),
        ),
      );
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(1);
      const count = await pool.query("SELECT count(*)::int AS c FROM users");
      expect(count.rows[0].c).toBe(1);
    });

    it("rejects duplicate clerk ids at the constraint level", async () => {
      await usersRepository.findOrCreateByClerkUserId("user_uq");
      await expect(
        pool.query("INSERT INTO users (clerk_user_id) VALUES ($1)", ["user_uq"]),
      ).rejects.toThrow(/unique/i);
    });
  });

  describe("organizations + memberships", () => {
    it("projects an organization once and reuses the row", async () => {
      const first =
        await organizationsRepository.findOrCreateByClerkOrganizationId("org_a");
      const second =
        await organizationsRepository.findOrCreateByClerkOrganizationId("org_a");
      expect(second.id).toBe(first.id);
      const count = await pool.query("SELECT count(*)::int AS c FROM organizations");
      expect(count.rows[0].c).toBe(1);
    });

    it("upserts membership role changes instead of duplicating rows", async () => {
      const org =
        await organizationsRepository.findOrCreateByClerkOrganizationId("org_m");
      const user = await usersRepository.findOrCreateByClerkUserId("user_m1");
      await membershipsRepository.upsert(org.id, user.id, "member");
      const updated = await membershipsRepository.upsert(org.id, user.id, "admin");
      expect(updated.role).toBe("admin");
      const count = await pool.query(
        "SELECT count(*)::int AS c FROM organization_memberships",
      );
      expect(count.rows[0].c).toBe(1);
    });

    it("keeps membership unique per (organization, user) under concurrency", async () => {
      const org =
        await organizationsRepository.findOrCreateByClerkOrganizationId("org_c");
      const user = await usersRepository.findOrCreateByClerkUserId("user_c1");
      await Promise.all([
        membershipsRepository.upsert(org.id, user.id, "member"),
        membershipsRepository.upsert(org.id, user.id, "member"),
        membershipsRepository.upsert(org.id, user.id, "admin"),
      ]);
      const count = await pool.query(
        "SELECT count(*)::int AS c FROM organization_memberships",
      );
      expect(count.rows[0].c).toBe(1);
    });

    it("distinguishes members of different organizations", async () => {
      const orgA =
        await organizationsRepository.findOrCreateByClerkOrganizationId("org_x");
      const orgB =
        await organizationsRepository.findOrCreateByClerkOrganizationId("org_y");
      const user = await usersRepository.findOrCreateByClerkUserId("user_xy");
      await membershipsRepository.upsert(orgA.id, user.id, "member");
      expect(
        (await membershipsRepository.findMembership(orgA.id, user.id))?.role,
      ).toBe("member");
      expect(await membershipsRepository.findMembership(orgB.id, user.id)).toBeNull();
    });
  });
});
