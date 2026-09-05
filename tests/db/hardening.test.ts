import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { ActorContext } from "../../src/server/auth/actor-context";
import { documentsService } from "../../src/server/services/documents";
import { permissionsService } from "../../src/server/services/permissions";
import { NotFoundError, ValidationError } from "../../src/server/errors";
import { usersRepository } from "../../src/server/repositories/users";
import { auditRepository } from "../../src/server/repositories/audit";
import { documentsRepository } from "../../src/server/repositories/documents";
import { getDb } from "../../src/server/db/client";
import { getTestPool, truncateAll } from "./helpers";

/**
 * M043–M046 extensions: revocation propagation, transactional rollback on
 * mid-operation failure, malformed role state backstop, and ACL races.
 */

async function seed(): Promise<{ owner: ActorContext; grantee: ActorContext; granteeUserId: string; docId: string }> {
  const userO = await usersRepository.findOrCreateByClerkUserId("ext_owner");
  const userG = await usersRepository.findOrCreateByClerkUserId("ext_grantee");
  const owner: ActorContext = { userId: userO.id, clerkUserId: "ext_owner", organization: null };
  const grantee: ActorContext = { userId: userG.id, clerkUserId: "ext_grantee", organization: null };
  const doc = await documentsService.createDocument(owner, { title: "Extension Doc" });
  return { owner, grantee, granteeUserId: userG.id, docId: doc.id };
}

describe("M043/M045 extension: grant lifecycle and revocation propagation", () => {
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

  it("revoked grants end access immediately (reauthorization per request)", async () => {
    const { owner, grantee, granteeUserId, docId } = await seed();
    await permissionsService.grantPermission(owner, docId, {
      targetUserId: granteeUserId,
      role: "VIEWER",
    });
    expect((await documentsService.getDocument(grantee, docId)).effectiveRole).toBe("VIEWER");

    await permissionsService.revokePermission(owner, docId, { targetUserId: granteeUserId });

    await expect(documentsService.getDocument(grantee, docId)).rejects.toThrow(NotFoundError);
  });

  it("malformed role state cannot exist (DB constraint is the backstop)", async () => {
    await expect(
      pool.query(
        `INSERT INTO document_user_permissions (document_id, user_id, role)
         SELECT id, owner_user_id, 'NINJA' FROM documents LIMIT 1`,
      ),
    ).rejects.toThrow(/document_role/);
  });

  it("ownership cannot be duplicated through the ACL path (OWNER not representable)", async () => {
    const { owner, granteeUserId, docId } = await seed();
    await expect(
      permissionsService.grantPermission(owner, docId, { targetUserId: granteeUserId, role: "OWNER" }),
    ).rejects.toThrow(ValidationError);
    await expect(
      pool.query(
        `INSERT INTO document_user_permissions (document_id, user_id, role)
         SELECT id, owner_user_id, 'OWNER' FROM documents LIMIT 1`,
      ),
    ).rejects.toThrow(/document_role/);
  });

  it("concurrent role changes converge on one valid grant row", async () => {
    const { owner, granteeUserId, docId } = await seed();
    await Promise.allSettled([
      permissionsService.grantPermission(owner, docId, { targetUserId: granteeUserId, role: "EDITOR" }),
      permissionsService.grantPermission(owner, docId, { targetUserId: granteeUserId, role: "VIEWER" }),
      permissionsService.grantPermission(owner, docId, { targetUserId: granteeUserId, role: "COMMENTER" }),
    ]);
    const grants = await pool.query("SELECT role FROM document_user_permissions");
    expect(grants.rows).toHaveLength(1);
    expect(["EDITOR", "VIEWER", "COMMENTER"]).toContain(grants.rows[0].role);
  });
});

describe("M044 extension: transactional rollback", () => {
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

  it("a mid-transaction failure leaves no partial document or audit rows", async () => {
    const user = await usersRepository.findOrCreateByClerkUserId("tx_owner");
    const db = getDb();

    await expect(
      db.transaction(async (tx) => {
        const doc = await documentsRepository.insert(
          {
            title: "Rollback Doc",
            ownerUserId: user.id,
            organizationId: null,
            initialContent: null,
          },
          tx,
        );
        await auditRepository.insert(
          {
            actorUserId: user.id,
            action: "document.create",
            resourceType: "document",
            resourceId: doc.id,
            organizationId: null,
          },
          tx,
        );
        throw new Error("intentional mid-operation failure");
      }),
    ).rejects.toThrow("intentional mid-operation failure");

    const counts = await pool.query(
      `SELECT (SELECT count(*)::int FROM documents) AS docs,
              (SELECT count(*)::int FROM audit_events) AS events`,
    );
    expect(counts.rows[0].docs).toBe(0);
    expect(counts.rows[0].events).toBe(0);
  });

  it("an aborted delete transaction leaves the document intact and writes no audit", async () => {
    const { owner, docId } = await seed();
    const db = getDb();

    await expect(
      db.transaction(async (tx) => {
        await auditRepository.insert(
          {
            actorUserId: owner.userId,
            action: "document.delete",
            resourceType: "document",
            resourceId: docId,
            organizationId: null,
          },
          tx,
        );
        await documentsRepository.deleteById(docId, tx);
        throw new Error("abort after delete statements");
      }),
    ).rejects.toThrow("abort after delete statements");

    // Rolled back: document still readable, no audit event persisted.
    expect((await documentsService.getDocument(owner, docId)).id).toBe(docId);
    expect(await auditRepository.listByResource(docId)).toHaveLength(
      // only the original document.create event
      1,
    );
  });
});
