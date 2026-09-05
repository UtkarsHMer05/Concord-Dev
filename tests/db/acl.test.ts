import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { ActorContext } from "../../src/server/auth/actor-context";
import { documentsService } from "../../src/server/services/documents";
import { permissionsService } from "../../src/server/services/permissions";
import { ValidationError } from "../../src/server/errors";
import { usersRepository } from "../../src/server/repositories/users";
import { auditRepository } from "../../src/server/repositories/audit";
import { permissionsRepository } from "../../src/server/repositories/permissions";
import { getTestPool, truncateAll } from "./helpers";

/**
 * M030: direct document ACL management — OWNER-only, role validation,
 * anti-escalation, audit trail.
 */

async function seed(): Promise<{
  owner: ActorContext;
  member: ActorContext;
  memberUserId: string;
  docId: string;
}> {
  const userO = await usersRepository.findOrCreateByClerkUserId("acl_owner");
  const userM = await usersRepository.findOrCreateByClerkUserId("acl_member");
  const owner: ActorContext = { userId: userO.id, clerkUserId: "acl_owner", organization: null };
  const member: ActorContext = { userId: userM.id, clerkUserId: "acl_member", organization: null };
  const doc = await documentsService.createDocument(owner, { title: "ACL Doc" });
  return { owner, member, memberUserId: userM.id, docId: doc.id };
}

describe("ACL management service", () => {
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

  it("owner grants, updates, and revokes direct roles; audit events written", async () => {
    const { owner, member, memberUserId, docId } = await seed();

    const granted = await permissionsService.grantPermission(owner, docId, {
      targetUserId: memberUserId,
      role: "COMMENTER",
    });
    expect(granted.role).toBe("COMMENTER");

    const updated = await permissionsService.grantPermission(owner, docId, {
      targetUserId: memberUserId,
      role: "EDITOR",
    });
    expect(updated.role).toBe("EDITOR");
    const rows = await permissionsRepository.listByDocument(docId);
    expect(rows).toHaveLength(1); // upsert, no duplicate

    const revoked = await permissionsService.revokePermission(owner, docId, {
      targetUserId: memberUserId,
    });
    expect(revoked.revoked).toBe(true);
    expect(await permissionsRepository.listByDocument(docId)).toHaveLength(1 - 1);

    const events = (await auditRepository.listByResource(docId)).map((e) => e.action);
    expect(events).toContain("document.create");
    expect(events).toContain("document.permission.granted");
    expect(events).toContain("document.permission.updated");
    expect(events).toContain("document.permission.revoked");
  });

  it("grantee gains exactly the granted capability (COMMENTER: read yes, edit no)", async () => {
    const { owner, member, memberUserId, docId } = await seed();
    await permissionsService.grantPermission(owner, docId, {
      targetUserId: memberUserId,
      role: "COMMENTER",
    });
    const detail = await documentsService.getDocument(member, docId);
    expect(detail.effectiveRole).toBe("COMMENTER");
    await expect(
      documentsService.saveDocumentContent(member, docId, {
        content: { v: 1, doc: {} },
        expectedContentVersion: 1,
      }),
    ).rejects.toThrow(); // masked NotFoundError
    // Read still works:
    expect((await documentsService.getDocument(member, docId)).title).toBe("ACL Doc");
  });

  it("non-owners cannot manage ACLs (masked not-found)", async () => {
    const { owner, member, memberUserId, docId } = await seed();
    await expect(
      permissionsService.grantPermission(member, docId, {
        targetUserId: memberUserId,
        role: "EDITOR",
      }),
    ).rejects.toThrow(); // NotFoundError masking
    await expect(
      permissionsService.revokePermission(member, docId, { targetUserId: memberUserId }),
    ).rejects.toThrow();
    // Owner's doc untouched:
    expect((await documentsService.getDocument(owner, docId)).title).toBe("ACL Doc");
  });

  it("rejects invalid roles — OWNER not grantable, bogus role rejected", async () => {
    const { owner, memberUserId, docId } = await seed();
    await expect(
      permissionsService.grantPermission(owner, docId, {
        targetUserId: memberUserId,
        role: "OWNER",
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      permissionsService.grantPermission(owner, docId, {
        targetUserId: memberUserId,
        role: "SUPERADMIN",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects self-grants and grants to the owner", async () => {
    const { owner, docId } = await seed();
    await expect(
      permissionsService.grantPermission(owner, docId, {
        targetUserId: owner.userId,
        role: "EDITOR",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects unknown target users and malformed ids", async () => {
    const { owner, docId } = await seed();
    await expect(
      permissionsService.grantPermission(owner, docId, {
        targetUserId: "00000000-0000-4000-8000-000000000000",
        role: "VIEWER",
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      permissionsService.grantPermission(owner, "not-a-uuid", {
        targetUserId: owner.userId,
        role: "VIEWER",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("revoking a non-existent grant is a no-op success without audit", async () => {
    const { owner, memberUserId, docId } = await seed();
    const result = await permissionsService.revokePermission(owner, docId, {
      targetUserId: memberUserId,
    });
    expect(result.revoked).toBe(false);
    const events = (await auditRepository.listByResource(docId)).map((e) => e.action);
    expect(events).not.toContain("document.permission.revoked");
  });

  it("a granted EDITOR still cannot manage ACLs or delete (escalation attempt fails)", async () => {
    const { owner, member, memberUserId, docId } = await seed();
    await permissionsService.grantPermission(owner, docId, {
      targetUserId: memberUserId,
      role: "EDITOR",
    });
    // EDITOR tries to promote themselves:
    await expect(
      permissionsService.grantPermission(member, docId, {
        targetUserId: memberUserId,
        role: "EDITOR",
      }),
    ).rejects.toThrow();
    // EDITOR tries to delete:
    await expect(documentsService.deleteDocument(member, docId)).rejects.toThrow();
    // EDITOR tries to revoke someone:
    await expect(
      permissionsService.revokePermission(member, docId, { targetUserId: memberUserId }),
    ).rejects.toThrow();
  });
});
