import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { ActorContext } from "../../src/server/auth/actor-context";
import { documentsService } from "../../src/server/services/documents";
import { permissionsService } from "../../src/server/services/permissions";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../src/server/errors";
import { usersRepository } from "../../src/server/repositories/users";
import {
  membershipsRepository,
  organizationsRepository,
} from "../../src/server/repositories/organizations";
import { auditRepository } from "../../src/server/repositories/audit";
import { getTestPool, truncateAll } from "./helpers";

/**
 * M022–M027 + M031: document service behavior against real PostgreSQL —
 * secure create, scoped listing/search, masked reads, rename/delete policy,
 * optimistic metadata concurrency, and audit durability.
 */

const USER_A_CLERK = "clerk_user_A";
const USER_B_CLERK = "clerk_user_B";
const ORG_1_CLERK = "clerk_org_1";
const ORG_2_CLERK = "clerk_org_2";

async function seedWorld(): Promise<{
  actorA: ActorContext;
  actorB: ActorContext;
  actorAInOrg1: ActorContext;
  actorBInOrg1: ActorContext;
  actorAInOrg2: ActorContext;
  actorBInOrg2: ActorContext;
}> {
  const userA = await usersRepository.findOrCreateByClerkUserId(USER_A_CLERK);
  const userB = await usersRepository.findOrCreateByClerkUserId(USER_B_CLERK);
  const org1 =
    await organizationsRepository.findOrCreateByClerkOrganizationId(ORG_1_CLERK);
  const org2 =
    await organizationsRepository.findOrCreateByClerkOrganizationId(ORG_2_CLERK);
  await membershipsRepository.upsert(org1.id, userA.id, "admin");
  await membershipsRepository.upsert(org1.id, userB.id, "member");
  await membershipsRepository.upsert(org2.id, userB.id, "member");

  const actorA: ActorContext = { userId: userA.id, clerkUserId: USER_A_CLERK, organization: null };
  const actorB: ActorContext = { userId: userB.id, clerkUserId: USER_B_CLERK, organization: null };
  const actorAInOrg1: ActorContext = {
    userId: userA.id,
    clerkUserId: USER_A_CLERK,
    organization: { id: org1.id, clerkOrganizationId: ORG_1_CLERK, role: "admin" },
  };
  const actorBInOrg1: ActorContext = {
    userId: userB.id,
    clerkUserId: USER_B_CLERK,
    organization: { id: org1.id, clerkOrganizationId: ORG_1_CLERK, role: "member" },
  };
  const actorAInOrg2: ActorContext = {
    userId: userA.id,
    clerkUserId: USER_A_CLERK,
    organization: { id: org2.id, clerkOrganizationId: ORG_2_CLERK, role: "member" },
  };
  const actorBInOrg2: ActorContext = {
    userId: userB.id,
    clerkUserId: USER_B_CLERK,
    organization: { id: org2.id, clerkOrganizationId: ORG_2_CLERK, role: "member" },
  };
  return { actorA, actorB, actorAInOrg1, actorBInOrg1, actorAInOrg2, actorBInOrg2 };
}

describe("documents service (PostgreSQL integration)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = getTestPool();
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("M022 create", () => {
    it("creates a personal document with server-derived owner", async () => {
      const { actorA } = await seedWorld();
      const { id } = await documentsService.createDocument(actorA, { title: "My Doc" });
      const doc = await documentsService.getDocument(actorA, id);
      expect(doc.title).toBe("My Doc");
      expect(doc.organizationId).toBeNull();
      expect(doc.effectiveRole).toBe("OWNER");
      expect(doc.contentVersion).toBe(1);
      expect(doc.metadataVersion).toBe(1);
    });

    it("creates an organization document scoped to the verified active org only", async () => {
      const { actorAInOrg1 } = await seedWorld();
      const { id } = await documentsService.createDocument(actorAInOrg1, { title: "Team Doc" });
      const doc = await documentsService.getDocument(actorAInOrg1, id);
      expect(doc.organizationId).not.toBeNull();
      expect(doc.organizationId).toBe(actorAInOrg1.organization!.id);
    });

    it("defaults blank title and stores template initialContent", async () => {
      const { actorA } = await seedWorld();
      const blank = await documentsService.createDocument(actorA, {});
      expect((await documentsService.getDocument(actorA, blank.id)).title).toBe("Untitled document");

      const templated = await documentsService.createDocument(actorA, {
        title: "Proposal",
        initialContent: "<h1>Proposal</h1>",
      });
      expect((await documentsService.getDocument(actorA, templated.id)).initialContent).toBe(
        "<h1>Proposal</h1>",
      );
    });

    it("rejects oversized titles and non-string titles (validation)", async () => {
      const { actorA } = await seedWorld();
      await expect(
        documentsService.createDocument(actorA, { title: "x".repeat(201) }),
      ).rejects.toThrow(ValidationError);
      await expect(
        documentsService.createDocument(actorA, { title: 42 as unknown as string }),
      ).rejects.toThrow(ValidationError);
    });

    it("enforces the 200-char title constraint at the DB level too", async () => {
      const { actorA } = await seedWorld();
      const doc = await documentsService.createDocument(actorA, { title: "ok" });
      await expect(
        pool.query("UPDATE documents SET title = $1 WHERE id = $2", [
          "y".repeat(201),
          doc.id,
        ]),
      ).rejects.toThrow(/documents_title_length_check/);
    });

    it("writes a document.create audit event", async () => {
      const { actorA } = await seedWorld();
      const { id } = await documentsService.createDocument(actorA, { title: "Audited" });
      const events = await auditRepository.listByResource(id);
      expect(events.map((e) => e.action)).toContain("document.create");
      expect(events[0].actorUserId).toBe(actorA.userId);
      expect(JSON.stringify(events[0].metadata)).not.toContain("content");
    });
  });

  describe("M023 list + M025 search scoping", () => {
    it("personal listing shows only own documents", async () => {
      const { actorA, actorB } = await seedWorld();
      const a1 = await documentsService.createDocument(actorA, { title: "A personal 1" });
      const a2 = await documentsService.createDocument(actorA, { title: "A personal 2" });
      await documentsService.createDocument(actorB, { title: "B personal" });

      const list = await documentsService.listDocuments(actorA, {});
      expect(list.documents.map((d) => d.id).sort()).toEqual([a1.id, a2.id].sort());
      expect(list.hasMore).toBe(false);
    });

    it("org listing shows only that organization's documents", async () => {
      const { actorAInOrg1, actorA, actorBInOrg1 } = await seedWorld();
      const o1 = await documentsService.createDocument(actorAInOrg1, { title: "Org doc" });
      await documentsService.createDocument(actorA, { title: "Personal doc" });

      const list = await documentsService.listDocuments(actorBInOrg1, {});
      expect(list.documents.map((d) => d.id)).toEqual([o1.id]);
    });

    it("org listing excludes documents of other organizations", async () => {
      const { actorAInOrg1, actorAInOrg2 } = await seedWorld();
      await documentsService.createDocument(actorAInOrg1, { title: "Org1 doc" });
      await documentsService.createDocument(actorAInOrg2, { title: "Org2 doc" });

      const list = await documentsService.listDocuments(actorAInOrg1, {});
      expect(list.documents.map((d) => d.title)).toEqual(["Org1 doc"]);
    });

    it("orders deterministically by updated_at DESC with id tie-break", async () => {
      const { actorA } = await seedWorld();
      const ids = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await documentsService.createDocument(actorA, { title: `Doc ${i}` })).id);
      }
      // Force identical updated_at so the id tie-break decides the order.
      await pool.query("UPDATE documents SET updated_at = '2026-01-01T00:00:00Z'");
      const list = await documentsService.listDocuments(actorA, {});
      expect(list.documents.map((d) => d.id)).toEqual(
        [...ids].sort((a, b) => (a > b ? -1 : 1)),
      );
      // Re-running returns the same order (deterministic).
      const again = await documentsService.listDocuments(actorA, {});
      expect(again.documents.map((d) => d.id)).toEqual(list.documents.map((d) => d.id));
    });

    it("paginates with hasMore", async () => {
      const { actorA } = await seedWorld();
      for (let i = 0; i < 7; i++) {
        await documentsService.createDocument(actorA, { title: `Page ${i}` });
      }
      const page1 = await documentsService.listDocuments(actorA, { page: 1 });
      expect(page1.documents).toHaveLength(5);
      expect(page1.hasMore).toBe(true);
      const page2 = await documentsService.listDocuments(actorA, { page: 2 });
      expect(page2.documents).toHaveLength(2);
      expect(page2.hasMore).toBe(false);
    });

    it("uses exact offsets after a loaded document is deleted", async () => {
      const { actorA } = await seedWorld();
      for (let i = 0; i < 11; i++) {
        await documentsService.createDocument(actorA, { title: `Offset ${i}` });
      }
      const all = await documentsService.listDocuments(actorA, { pageSize: 50 });
      const firstPage = await documentsService.listDocuments(actorA, { pageSize: 5 });
      await documentsService.deleteDocument(actorA, firstPage.documents[0]!.id);

      const next = await documentsService.listDocuments(actorA, {
        offset: firstPage.documents.length - 1,
        pageSize: 5,
      });
      expect(next.documents[0]?.id).toBe(all.documents[5]?.id);
    });

    it("search filters within scope, case-insensitively", async () => {
      const { actorA, actorB } = await seedWorld();
      const hit = await documentsService.createDocument(actorA, { title: "Quarterly Report" });
      await documentsService.createDocument(actorA, { title: "Groceries" });
      await documentsService.createDocument(actorB, { title: "Quarterly Secret" });

      const results = await documentsService.listDocuments(actorA, { search: "quarterly" });
      expect(results.documents.map((d) => d.id)).toEqual([hit.id]);
    });

    it("treats LIKE wildcards and injection-like strings as literal data", async () => {
      const { actorA, actorB } = await seedWorld();
      const literal = await documentsService.createDocument(actorA, { title: "100% done_now" });
      await documentsService.createDocument(actorB, { title: "unrelated" });

      const percent = await documentsService.listDocuments(actorA, { search: "100%" });
      expect(percent.documents.map((d) => d.id)).toEqual([literal.id]);

      const underscore = await documentsService.listDocuments(actorA, { search: "done_now" });
      expect(underscore.documents.map((d) => d.id)).toEqual([literal.id]);

      const injection = await documentsService.listDocuments(actorA, {
        search: "'; DROP TABLE documents; --",
      });
      expect(injection.documents).toHaveLength(0);
      // Table still exists — the string remained data.
      const count = await pool.query("SELECT count(*)::int AS c FROM documents");
      expect(count.rows[0].c).toBe(2);
    });

    it("handles empty and long searches safely", async () => {
      const { actorA } = await seedWorld();
      await documentsService.createDocument(actorA, { title: "Anything" });
      expect((await documentsService.listDocuments(actorA, { search: "" })).documents).toHaveLength(1);
      expect((await documentsService.listDocuments(actorA, { search: "   " })).documents).toHaveLength(1);
      const long = await documentsService.listDocuments(actorA, { search: "z".repeat(5000) });
      expect(long.documents).toHaveLength(0);
    });
  });

  describe("M024 read/open", () => {
    it("creator is OWNER even in an org; the other org member resolves to EDITOR", async () => {
      const { actorAInOrg1, actorBInOrg1 } = await seedWorld();
      const orgDoc = await documentsService.createDocument(actorBInOrg1, { title: "Shared" });
      expect((await documentsService.getDocument(actorBInOrg1, orgDoc.id)).effectiveRole).toBe("OWNER");
      expect((await documentsService.getDocument(actorAInOrg1, orgDoc.id)).effectiveRole).toBe("EDITOR");
    });

    it("owner retains access to own document even with a different active org", async () => {
      const { actorAInOrg1, actorAInOrg2 } = await seedWorld();
      const org1Doc = await documentsService.createDocument(actorAInOrg1, { title: "Mine in org1" });
      expect((await documentsService.getDocument(actorAInOrg2, org1Doc.id)).effectiveRole).toBe("OWNER");
    });

    it("masks membership in a DIFFERENT org as not found", async () => {
      const { actorAInOrg1, actorBInOrg2 } = await seedWorld();
      const org1Doc = await documentsService.createDocument(actorAInOrg1, { title: "Org1" });
      await expect(documentsService.getDocument(actorBInOrg2, org1Doc.id)).rejects.toThrow(
        NotFoundError,
      );
    });

    it("masks unauthorized access as NotFoundError (no existence leak)", async () => {
      const { actorA, actorB } = await seedWorld();
      const aDoc = await documentsService.createDocument(actorA, { title: "Secret" });
      await expect(documentsService.getDocument(actorB, aDoc.id)).rejects.toThrow(NotFoundError);
    });

    it("missing document and unauthorized document are indistinguishable", async () => {
      const { actorA, actorB } = await seedWorld();
      const aDoc = await documentsService.createDocument(actorA, { title: "Real" });
      const missingId = "00000000-0000-4000-8000-000000000000";
      const errA = await documentsService.getDocument(actorB, aDoc.id).catch((e) => e);
      const errB = await documentsService.getDocument(actorB, missingId).catch((e) => e);
      expect(errA.constructor).toBe(errB.constructor);
      expect(errA.message).toBe(errB.message);
    });

    it("rejects malformed ids with ValidationError (no SQL errors)", async () => {
      const { actorA } = await seedWorld();
      await expect(documentsService.getDocument(actorA, "not-a-uuid")).rejects.toThrow(ValidationError);
      await expect(documentsService.getDocument(actorA, "1' OR '1'='1")).rejects.toThrow(ValidationError);
      await expect(documentsService.getDocument(actorA, null)).rejects.toThrow(ValidationError);
    });
  });

  describe("M026 rename", () => {
    it("owner and org members (EDITOR) may rename; writes audit", async () => {
      const { actorAInOrg1, actorBInOrg1 } = await seedWorld();
      const orgDoc = await documentsService.createDocument(actorAInOrg1, { title: "Old" });
      const renamed = await documentsService.renameDocument(actorBInOrg1, orgDoc.id, {
        title: "New",
        expectedMetadataVersion: 1,
      });
      expect(renamed.metadataVersion).toBe(2);
      const events = await auditRepository.listByResource(orgDoc.id);
      expect(events.map((e) => e.action)).toContain("document.rename");
    });

    it("unrelated users cannot rename (masked not-found)", async () => {
      const { actorA, actorB } = await seedWorld();
      const doc = await documentsService.createDocument(actorA, { title: "Mine" });
      await expect(
        documentsService.renameDocument(actorB, doc.id, { title: "Hax", expectedMetadataVersion: 1 }),
      ).rejects.toThrow(NotFoundError);
    });

    it("stale metadata version conflicts instead of silently winning", async () => {
      const { actorA } = await seedWorld();
      const doc = await documentsService.createDocument(actorA, { title: "V1" });
      await documentsService.renameDocument(actorA, doc.id, { title: "V2", expectedMetadataVersion: 1 });
      await expect(
        documentsService.renameDocument(actorA, doc.id, { title: "Stale", expectedMetadataVersion: 1 }),
      ).rejects.toThrow(ConflictError);
    });

    it("rolls back rename and permission mutations when the audit write fails", async () => {
      const { actorA, actorB } = await seedWorld();
      const doc = await documentsService.createDocument(actorA, { title: "Before" });
      await pool.query(`
        CREATE FUNCTION reject_selected_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.action IN ('document.rename', 'document.permission.granted') THEN
            RAISE EXCEPTION 'forced audit failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_selected_audit
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION reject_selected_audit();
      `);

      try {
        await expect(
          documentsService.renameDocument(actorA, doc.id, {
            title: "After",
            expectedMetadataVersion: 1,
          }),
        ).rejects.toThrow();
        expect((await documentsService.getDocument(actorA, doc.id)).title).toBe("Before");
        expect((await documentsService.getDocument(actorA, doc.id)).metadataVersion).toBe(1);

        await expect(
          permissionsService.grantPermission(actorA, doc.id, {
            targetUserId: actorB.userId,
            role: "VIEWER",
          }),
        ).rejects.toThrow();
        const grants = await pool.query(
          "SELECT count(*)::int AS count FROM document_user_permissions WHERE document_id = $1 AND user_id = $2",
          [doc.id, actorB.userId],
        );
        expect(grants.rows[0].count).toBe(0);
      } finally {
        await pool.query(`
          DROP TRIGGER IF EXISTS reject_selected_audit ON audit_events;
          DROP FUNCTION IF EXISTS reject_selected_audit();
        `);
      }
    });

    it("empty/whitespace title falls back to default; >200 chars rejected", async () => {
      const { actorA } = await seedWorld();
      const doc = await documentsService.createDocument(actorA, { title: "T" });
      const r = await documentsService.renameDocument(actorA, doc.id, {
        title: "   ",
        expectedMetadataVersion: 1,
      });
      expect(r.metadataVersion).toBe(2);
      expect((await documentsService.getDocument(actorA, doc.id)).title).toBe("Untitled document");
      await expect(
        documentsService.renameDocument(actorA, doc.id, { title: "x".repeat(201), expectedMetadataVersion: 2 }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejected rename does not bump metadataVersion", async () => {
      const { actorA, actorB } = await seedWorld();
      const doc = await documentsService.createDocument(actorA, { title: "T" });
      await documentsService.renameDocument(actorA, doc.id, { title: "T2", expectedMetadataVersion: 1 });
      await documentsService.createDocument(actorB, { title: "other" });
      await expect(
        documentsService.renameDocument(actorA, doc.id, { title: "T3", expectedMetadataVersion: 1 }),
      ).rejects.toThrow(ConflictError);
      expect((await documentsService.getDocument(actorA, doc.id)).metadataVersion).toBe(2);
    });
  });

  describe("M027 delete", () => {
    it("owner can delete; deletion writes a durable audit event", async () => {
      const { actorA } = await seedWorld();
      const doc = await documentsService.createDocument(actorA, { title: "Doomed" });
      await documentsService.deleteDocument(actorA, doc.id);
      await expect(documentsService.getDocument(actorA, doc.id)).rejects.toThrow(NotFoundError);
      const events = await auditRepository.listByResource(doc.id);
      expect(events.map((e) => e.action)).toContain("document.delete");
      expect(events[0].resourceId).toBe(doc.id);
    });

    it("EDITORS (org members) cannot delete — tightened from Phase 0 parity", async () => {
      const { actorAInOrg1, actorBInOrg1 } = await seedWorld();
      const orgDoc = await documentsService.createDocument(actorAInOrg1, { title: "Team" });
      await expect(documentsService.deleteDocument(actorBInOrg1, orgDoc.id)).rejects.toThrow(NotFoundError);
      // Still exists:
      expect((await documentsService.getDocument(actorBInOrg1, orgDoc.id)).title).toBe("Team");
    });

    it("unrelated users cannot delete and cannot detect existence", async () => {
      const { actorA, actorB } = await seedWorld();
      const doc = await documentsService.createDocument(actorA, { title: "Mine" });
      await expect(documentsService.deleteDocument(actorB, doc.id)).rejects.toThrow(NotFoundError);
    });

    it("ACL rows cascade with the document; audit rows survive", async () => {
      const { actorA, actorB } = await seedWorld();
      const doc = await documentsService.createDocument(actorA, { title: "Shared" });
      await permissionsService.grantPermission(actorA, doc.id, {
        targetUserId: actorB.userId,
        role: "VIEWER",
      });
      await documentsService.deleteDocument(actorA, doc.id);
      const grants = await pool.query("SELECT count(*)::int AS c FROM document_user_permissions");
      expect(grants.rows[0].c).toBe(0);
      const events = await auditRepository.listByResource(doc.id);
      expect(events.length).toBeGreaterThanOrEqual(2); // create + grant + delete
      expect(events.map((e) => e.action)).toContain("document.delete");
    });
  });
});
