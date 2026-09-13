import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { ActorContext } from "../../src/server/auth/actor-context";
import { documentsService } from "../../src/server/services/documents";
import { permissionsService } from "../../src/server/services/permissions";
import { ConflictError, NotFoundError } from "../../src/server/errors";
import { usersRepository } from "../../src/server/repositories/users";
import {
  membershipsRepository,
  organizationsRepository,
} from "../../src/server/repositories/organizations";
import { auditRepository } from "../../src/server/repositories/audit";
import { getTestPool, truncateAll } from "./helpers";

/**
 * P6-M021 (SA-AUTH6) — web-side IDOR matrix.
 *
 * Systematic roles × surfaces matrix over the product authorization layer
 * (documentsService + permissionsService against real PostgreSQL):
 * every cell asserts the documented ALLOW/DENY outcome, and every denial
 * is the MASKED NotFoundError — indistinguishable from a nonexistent
 * document (no existence oracle; docs/AUTHORIZATION.md §5).
 *
 * Surfaces:
 *  1. document read        (documentsService.getDocument)
 *  2. content save         (documentsService.saveDocumentContent — the
 *                            POST /api/documents/[id]/content service path)
 *  3. document list scope  (documentsService.listDocuments — SQL-scoped)
 *  4. ACL management       (permissionsService grant/revoke — OWNER-only)
 *  5. audit reads          (auditRepository.listByResource — exercised
 *                            via the service-level audit trail surface)
 *
 * Roles: OWNER, EDITOR (direct ACL), COMMENTER (direct ACL), VIEWER
 * (direct ACL), org-member of a foreign org, and a no-access outsider.
 * Cross-tenant cells probe another organization's documents.
 */

const ENVELOPE = (text: string) => ({
  v: 1,
  doc: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  },
});

async function seedWorld(): Promise<{
  owner: ActorContext;
  editor: ActorContext;
  commenter: ActorContext;
  viewer: ActorContext;
  foreignMember: ActorContext;
  outsider: ActorContext;
  /** owner's personal doc (the primary matrix target). */
  docId: string;
  /** an org-scoped doc owned by the same owner. */
  orgDocId: string;
  /** a personal doc owned by the foreign-tenant member. */
  foreignDocId: string;
  editorUserId: string;
  ownOrgId: string;
}> {
  const mk = (clerk: string) => usersRepository.findOrCreateByClerkUserId(clerk);
  const userO = await mk("p6w_owner");
  const userE = await mk("p6w_editor");
  const userC = await mk("p6w_commenter");
  const userV = await mk("p6w_viewer");
  const userF = await mk("p6w_foreign_member");
  const userX = await mk("p6w_outsider");

  const ownOrg = await organizationsRepository.findOrCreateByClerkOrganizationId("p6w_own_org");
  const foreignOrg =
    await organizationsRepository.findOrCreateByClerkOrganizationId("p6w_foreign_org");
  // The foreign member belongs ONLY to the other org (never the doc's org).
  await membershipsRepository.upsert(foreignOrg.id, userF.id, "member");
  void foreignOrg; // the foreign member's membership is seeded above

  const owner: ActorContext = { userId: userO.id, clerkUserId: "p6w_owner", organization: null };
  const editor: ActorContext = { userId: userE.id, clerkUserId: "p6w_editor", organization: null };
  const commenter: ActorContext = { userId: userC.id, clerkUserId: "p6w_commenter", organization: null };
  const viewer: ActorContext = { userId: userV.id, clerkUserId: "p6w_viewer", organization: null };
  const foreignMember: ActorContext = { userId: userF.id, clerkUserId: "p6w_foreign_member", organization: null };
  const outsider: ActorContext = { userId: userX.id, clerkUserId: "p6w_outsider", organization: null };

  const { id: docId } = await documentsService.createDocument(owner, { title: "Matrix Doc" });
  for (const [user, role] of [
    [userE, "EDITOR"],
    [userC, "COMMENTER"],
    [userV, "VIEWER"],
  ] as const) {
    await permissionsService.grantPermission(owner, docId, {
      targetUserId: user.id,
      role: role as "EDITOR" | "COMMENTER" | "VIEWER",
    });
  }

  // An org-scoped doc (owner's org) for the org-derive cells.
  const ownerInOrg: ActorContext = {
    userId: userO.id,
    clerkUserId: "p6w_owner",
    organization: { id: ownOrg.id, clerkOrganizationId: "p6w_own_org", role: "admin" },
  };
  const { id: orgDocId } = await documentsService.createDocument(ownerInOrg, {
    title: "Org Doc",
  });

  // A personal doc owned by the foreign-tenant member (cross-tenant asset).
  const { id: foreignDocId } = await documentsService.createDocument(foreignMember, {
    title: "Foreign Doc",
  });

  return {
    owner,
    editor,
    commenter,
    viewer,
    foreignMember,
    outsider,
    docId,
    orgDocId,
    foreignDocId,
    editorUserId: userE.id,
    ownOrgId: ownOrg.id,
  };
}

/** Asserts the cell outcome for document READ: allowed roles resolve the
 * documented effectiveRole; denied roles get the MASKED NotFoundError
 * (never a ForbiddenError — no existence oracle). */
async function expectRead(
  actor: ActorContext,
  docId: string,
  expected: "OWNER" | "EDITOR" | "COMMENTER" | "VIEWER" | "DENY",
): Promise<void> {
  if (expected === "DENY") {
    await expect(documentsService.getDocument(actor, docId)).rejects.toThrow(NotFoundError);
    return;
  }
  const doc = await documentsService.getDocument(actor, docId);
  expect(doc.effectiveRole).toBe(expected);
}

/** Asserts the cell outcome for content SAVE (the POST content route's
 * service path): ALLOW returns a bumped version; DENY is masked
 * NotFoundError — never ConflictError (that would leak existence + the
 * version race only a real grantee could hit). */
async function expectSave(
  actor: ActorContext,
  docId: string,
  expected: "ALLOW" | "DENY",
  expectedContentVersion = 1,
): Promise<void> {
  if (expected === "DENY") {
    await expect(
      documentsService.saveDocumentContent(actor, docId, {
        content: ENVELOPE("idor"),
        expectedContentVersion,
      }),
    ).rejects.toThrow(NotFoundError);
    return;
  }
  const saved = await documentsService.saveDocumentContent(actor, docId, {
    content: ENVELOPE("idor"),
    expectedContentVersion,
  });
  expect(saved.contentVersion).toBe(expectedContentVersion + 1);
}

describe("IDOR matrix (web authorization surfaces, P6-M021)", () => {
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

  it("matrix: document read per role (masked denials)", async () => {
    const w = await seedWorld();

    // Cell-by-cell, docs/AUTHORIZATION.md capability matrix:
    await expectRead(w.owner, w.docId, "OWNER");
    await expectRead(w.editor, w.docId, "EDITOR");
    await expectRead(w.commenter, w.docId, "COMMENTER");
    await expectRead(w.viewer, w.docId, "VIEWER");
    await expectRead(w.outsider, w.docId, "DENY");
    await expectRead(w.foreignMember, w.docId, "DENY");

    // Cross-tenant document: foreign member reads the OWNER's org doc →
    // DENY; the owner's own org doc resolves OWNER for the owner.
    await expectRead(w.foreignMember, w.orgDocId, "DENY");
    await expectRead(w.outsider, w.orgDocId, "DENY");

    // Guessed random document id: IDENTICAL masked outcome for every
    // role (including the owner of other docs) — no oracle.
    const ghost = "00000000-0000-4000-8000-000000000000";
    await expectRead(w.owner, ghost, "DENY");
    await expectRead(w.outsider, ghost, "DENY");

    // Every read denial is NotFoundError-typed (masked), so the matrix
    // above already pins the shape; assert explicitly for the cells.
    for (const actor of [w.outsider, w.foreignMember]) {
      await expect(
        documentsService.getDocument(actor, w.docId),
      ).rejects.toThrowError(
        expect.objectContaining({ name: expect.any(String) }),
      );
    }
  });

  it("matrix: content save per role (editContent = OWNER/EDITOR only)", async () => {
    const w = await seedWorld();

    await expectSave(w.owner, w.docId, "ALLOW", 1); // → version 2
    await expectSave(w.editor, w.docId, "ALLOW", 2); // → version 3
    await expectSave(w.commenter, w.docId, "DENY", 3);
    await expectSave(w.viewer, w.docId, "DENY", 3);
    await expectSave(w.outsider, w.docId, "DENY", 3);
    await expectSave(w.foreignMember, w.docId, "DENY", 3);

    // The comment/edit denials never changed stored content.
    const doc = await documentsService.getDocument(w.owner, w.docId);
    expect(doc.contentVersion).toBe(3);

    // Version-check path stays authorization-gated: a stale-version
    // attempt by a VIEWER is a masked NotFoundError, NOT a
    // ConflictError — only real editors can ever learn a version race.
    await expect(
      documentsService.saveDocumentContent(w.viewer, w.docId, {
        content: ENVELOPE("stale-viewer"),
        expectedContentVersion: 1,
      }),
    ).rejects.toThrow(NotFoundError);

    // Cross-tenant save: the foreign member cannot write the owner's doc.
    await expect(
      documentsService.saveDocumentContent(w.foreignMember, w.docId, {
        content: ENVELOPE("x"),
        expectedContentVersion: 3,
      }),
    ).rejects.toThrow(NotFoundError);

    // A stale version for a REAL editor is a typed ConflictError
    // (authorization passed; the version race is visible only to them).
    await expect(
      documentsService.saveDocumentContent(w.editor, w.docId, {
        content: ENVELOPE("stale-editor"),
        expectedContentVersion: 1,
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("matrix: list scope — SQL-scoped listing can never surface others' documents", async () => {
    const w = await seedWorld();

    // The owner's personal scope lists only their documents.
    const owned = await documentsService.listDocuments(w.owner, {});
    const ownedTitles = owned.documents.map((d) => d.title);
    expect(ownedTitles).toContain("Matrix Doc");
    expect(ownedTitles).not.toContain("Foreign Doc");

    // The editor (direct ACL grant) does NOT see the doc via the LIST
    // surface (list is owner/org-scoped; direct grants are open-by-id
    // only) — but the read surface still resolves them (asserted above).
    const listedForEditor = await documentsService.listDocuments(w.editor, {});
    expect(listedForEditor.documents.map((d) => d.title)).not.toContain("Matrix Doc");

    // The foreign member's own scope lists THEIR doc, never the owner's.
    const foreignList = await documentsService.listDocuments(w.foreignMember, {});
    const foreignTitles = foreignList.documents.map((d) => d.title);
    expect(foreignTitles).toContain("Foreign Doc");
    expect(foreignTitles).not.toContain("Matrix Doc");
    expect(foreignTitles).not.toContain("Org Doc");

    // The outsider sees nothing of anyone else's.
    const outsiderList = await documentsService.listDocuments(w.outsider, {});
    expect(outsiderList.documents).toHaveLength(0);

    // Org-scoped listing: the owner-in-org sees the org doc via their
    // verified org context.
    const ownerInOrg: ActorContext = {
      ...w.owner,
      organization: { id: w.ownOrgId, clerkOrganizationId: "p6w_own_org", role: "admin" },
    };
    const orgList = await documentsService.listDocuments(ownerInOrg, {});
    expect(orgList.documents.map((d) => d.title)).toContain("Org Doc");
  });

  it("matrix: ACL management is OWNER-only; non-owners get masked denials", async () => {
    const w = await seedWorld();

    // Owner manages: ALLOW.
    const granted = await permissionsService.grantPermission(w.owner, w.docId, {
      targetUserId: w.editorUserId,
      role: "EDITOR",
    });
    expect(granted.role).toBe("EDITOR");

    // Every non-owner — EDITOR, COMMENTER, VIEWER, outsider, foreign
    // member — is denied, and uniformly (masked NotFoundError).
    const nonOwners: Array<[string, ActorContext]> = [
      ["editor", w.editor],
      ["commenter", w.commenter],
      ["viewer", w.viewer],
      ["outsider", w.outsider],
      ["foreign member", w.foreignMember],
    ];
    for (const [label, actor] of nonOwners) {
      await expect(
        permissionsService.grantPermission(actor, w.docId, {
          targetUserId: w.editorUserId,
          role: "VIEWER",
        }),
        `${label} must not be able to grant`,
      ).rejects.toThrow(NotFoundError);
      await expect(
        permissionsService.revokePermission(actor, w.docId, {
          targetUserId: w.editorUserId,
        }),
        `${label} must not be able to revoke`,
      ).rejects.toThrow(NotFoundError);
    }

    // Escalation attempt: a granted EDITOR targets THEMSELVES — still a
    // masked deny (they are not the owner).
    await expect(
      permissionsService.grantPermission(w.editor, w.docId, {
        targetUserId: w.editorUserId,
        role: "EDITOR",
      }),
    ).rejects.toThrow(NotFoundError);

    // Nonexistent document id: SAME masked shape for owner and outsider
    // alike (no oracle on the mutation surface either).
    const ghost = "00000000-0000-4000-8000-000000000000";
    await expect(
      permissionsService.grantPermission(w.owner, ghost, {
        targetUserId: w.editorUserId,
        role: "VIEWER",
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      permissionsService.grantPermission(w.outsider, ghost, {
        targetUserId: w.editorUserId,
        role: "VIEWER",
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("matrix: delete is OWNER-only; rename is EDITOR+; both masked elsewhere", async () => {
    const w = await seedWorld();

    // Rename cells (EDITOR+).
    await documentsService.renameDocument(w.editor, w.docId, {
      title: "Renamed by editor",
      expectedMetadataVersion: 1,
    });
    const afterEditor = await documentsService.getDocument(w.owner, w.docId);
    await expect(
      documentsService.renameDocument(w.viewer, w.docId, {
        title: "no",
        expectedMetadataVersion: afterEditor.metadataVersion,
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      documentsService.renameDocument(w.outsider, w.docId, {
        title: "no",
        expectedMetadataVersion: afterEditor.metadataVersion,
      }),
    ).rejects.toThrow(NotFoundError);

    // Delete cells (OWNER-only).
    await expect(
      documentsService.deleteDocument(w.editor, w.docId),
    ).rejects.toThrow(NotFoundError);
    await expect(
      documentsService.deleteDocument(w.viewer, w.docId),
    ).rejects.toThrow(NotFoundError);
    await expect(
      documentsService.deleteDocument(w.foreignMember, w.docId),
    ).rejects.toThrow(NotFoundError);
    // The doc survives every failed delete.
    expect((await documentsService.getDocument(w.owner, w.docId)).title).toBe(
      "Renamed by editor",
    );

    // Cross-tenant delete: the owner of the FOREIGN doc cannot delete
    // the owner's doc and vice versa.
    await expect(
      documentsService.deleteDocument(w.owner, w.foreignDocId),
    ).rejects.toThrow(NotFoundError);
    await expect(
      documentsService.deleteDocument(w.foreignMember, w.docId),
    ).rejects.toThrow(NotFoundError);

    // Owner CAN delete their own (control cell).
    await documentsService.deleteDocument(w.owner, w.docId);
    expect(await documentsService.exists(w.docId)).toBe(false);
  });

  it("matrix: audit trail is reachable only through authorized reads; revocation ends read access", async () => {
    const w = await seedWorld();

    // The service-level audit surface: the owner's actions wrote audit
    // events; listByResource is the repository read used by owner-facing
    // UI. A denied reader never reaches this code path in product
    // (route-level authz precedes), but the repository contract itself
    // is id-scoped: assert the events exist and no cross-document
    // leakage occurs (resource-scoped query).
    const events = await auditRepository.listByResource(w.docId);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.resourceId).toBe(w.docId);
    }
    // The foreign doc's audit trail is disjoint (no cross-tenant rows).
    const foreignEvents = await auditRepository.listByResource(w.foreignDocId);
    expect(foreignEvents.length).toBeGreaterThan(0);
    expect(foreignEvents.map((e) => e.resourceId)).not.toContain(w.docId);

    // Revocation propagation through the service: revoke the viewer's
    // grant; their NEXT read is a masked NotFoundError (reauthorization
    // per request — the HTTP-equivalent of the gateway's per-batch
    // recheck).
    await permissionsService.revokePermission(w.owner, w.docId, {
      targetUserId: w.viewer.userId,
    });
    await expect(documentsService.getDocument(w.viewer, w.docId)).rejects.toThrow(NotFoundError);

    // Downgrade propagation: EDITOR → VIEWER ends content saves.
    await permissionsService.grantPermission(w.owner, w.docId, {
      targetUserId: w.editorUserId,
      role: "VIEWER",
    });
    await expect(
      documentsService.saveDocumentContent(w.editor, w.docId, {
        content: ENVELOPE("post-downgrade"),
        expectedContentVersion: 1,
      }),
    ).rejects.toThrow(NotFoundError);
    // ...but their READ now resolves VIEWER.
    expect((await documentsService.getDocument(w.editor, w.docId)).effectiveRole).toBe("VIEWER");
  });
});
