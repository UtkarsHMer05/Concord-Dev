import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../../src/server/auth/actor-context";
import { documentsService } from "../../src/server/services/documents";
import { permissionsService } from "../../src/server/services/permissions";
import { usersRepository } from "../../src/server/repositories/users";
import { membershipsRepository, organizationsRepository } from "../../src/server/repositories/organizations";
import { NotFoundError, ValidationError } from "../../src/server/errors";
import { getTestPool, truncateAll } from "./helpers";

const clerk = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: async () => ({ users: { getUserList: clerk.list } }) }));
const pool = getTestPool();
afterEach(async () => { clerk.list.mockReset(); await truncateAll(pool); });
afterAll(() => pool.end());
const actor = async (clerkUserId: string): Promise<ActorContext> => ({ userId: (await usersRepository.findOrCreateByClerkUserId(clerkUserId)).id, clerkUserId, organization: null });
const profile = (id: string, email: string, verified = true) => ({ id, firstName: "Ada", lastName: "Lovelace", username: null, primaryEmailAddressId: "address", emailAddresses: [{ id: "address", emailAddress: email, verification: { status: verified ? "verified" : "unverified" } }] });

describe("Sharing and document discovery", () => {
  it("shares by exact verified email, projects a first-time recipient, and shows readable profiles", async () => {
    const owner = await actor("owner"); const doc = await documentsService.createDocument(owner);
    clerk.list.mockResolvedValue({ data: [profile("recipient", "ada@example.com"), profile("other", "ada@example.com.evil"), profile("reserved", "ada@example.com", false)] });
    expect((await permissionsService.grantPermission(owner, doc.id, { email: " ADA@EXAMPLE.COM ", role: "COMMENTER" })).role).toBe("COMMENTER");
    const recipient = await actor("recipient");
    expect((await documentsService.getDocument(recipient, doc.id)).effectiveRole).toBe("COMMENTER");
    expect(clerk.list).toHaveBeenCalledWith({ emailAddress: ["ada@example.com"], limit: 100 });
    const sharing = await permissionsService.getSharing(owner, doc.id);
    expect(sharing.grants[0]).toMatchObject({ name: "Ada Lovelace", email: "ada@example.com", role: "COMMENTER" });
    const recipientView = await permissionsService.getSharing(recipient, doc.id);
    expect(recipientView).toMatchObject({ canManage: false, grants: [], owner: null });
  });

  it("checks ownership before account lookup and rejects invalid, unverified, and self grants", async () => {
    const owner = await actor("owner"); const stranger = await actor("stranger"); const doc = await documentsService.createDocument(owner);
    await expect(permissionsService.grantPermission(stranger, doc.id, { email: "ada@example.com", role: "EDITOR" })).rejects.toThrow(NotFoundError);
    expect(clerk.list).not.toHaveBeenCalled();
    for (const input of [{ email: "bad", role: "EDITOR" }, { email: "ada@example.com", role: "OWNER" }, { email: "ada@example.com", targetUserId: stranger.userId, role: "VIEWER" }]) {
      await expect(permissionsService.grantPermission(owner, doc.id, input)).rejects.toThrow(ValidationError);
    }
    clerk.list.mockResolvedValue({ data: [profile("recipient", "ada@example.com", false)] });
    await expect(permissionsService.grantPermission(owner, doc.id, { email: "ada@example.com", role: "EDITOR" })).rejects.toThrow(/verified email/);
    clerk.list.mockResolvedValue({ data: [profile("owner", "ada@example.com")] });
    await expect(permissionsService.grantPermission(owner, doc.id, { email: "ada@example.com", role: "EDITOR" })).rejects.toThrow(/yourself/);
    expect((await permissionsService.listGrants(owner, doc.id))).toHaveLength(0);
  });

  it("Shared with me is account-scoped across active workspaces, paginated, searchable, and follows role changes and revocation", async () => {
    const owner = await actor("owner"); const recipient = await actor("recipient"); const stranger = await actor("stranger");
    const org = await organizationsRepository.findOrCreateByClerkOrganizationId("recipient_org");
    const recipientInOrg = { ...recipient, organization: { id: org.id, clerkOrganizationId: org.clerkOrganizationId, role: "member" as const } };
    await documentsService.createDocument(recipient, { title: "Private recipient document" });
    const ids = [];
    for (const title of ["Project 100%", "Project 1000", "Third proposal"]) {
      const doc = await documentsService.createDocument(owner, { title }); ids.push(doc.id);
      await permissionsService.grantPermission(owner, doc.id, { targetUserId: recipient.userId, role: "VIEWER" });
    }
    const first = await documentsService.listDocuments(recipientInOrg, { scope: "shared", pageSize: 2 });
    expect(first.documents).toHaveLength(2); expect(first.hasMore).toBe(true);
    const next = await documentsService.listDocuments(recipientInOrg, { scope: "shared", pageSize: 2, offset: 2 });
    expect(next.documents).toHaveLength(1); expect(next.hasMore).toBe(false);
    expect(new Set([...first.documents, ...next.documents].map((doc) => doc.id)).size).toBe(3);
    const exact = await documentsService.listDocuments(recipient, { scope: "shared", search: "100%" });
    expect(exact.documents.map((doc) => doc.title)).toEqual(["Project 100%"]);
    expect((await documentsService.listDocuments(stranger, { scope: "shared" })).documents).toHaveLength(0);
    expect((await documentsService.listDocuments(owner, { scope: "shared" })).documents).toHaveLength(0);
    expect((await documentsService.listDocuments(recipient)).documents.map((doc) => doc.title)).toEqual(["Private recipient document"]);
    await permissionsService.grantPermission(owner, ids[0], { targetUserId: recipient.userId, role: "EDITOR" });
    expect((await documentsService.listDocuments(recipient, { scope: "shared", search: "100%" })).documents[0].effectiveRole).toBe("EDITOR");
    await permissionsService.revokePermission(owner, ids[0], { targetUserId: recipient.userId });
    expect((await documentsService.listDocuments(recipient, { scope: "shared", search: "100%" })).documents).toHaveLength(0);
    await expect(documentsService.getDocument(recipient, ids[0])).rejects.toThrow(NotFoundError);
    await expect(documentsService.listDocuments(recipient, { scope: "all" })).rejects.toThrow(ValidationError);
  });

  it("removing a direct role restores existing organization access, and profile failures preserve access management", async () => {
    const owner = await actor("owner"); const recipient = await actor("recipient");
    const org = await organizationsRepository.findOrCreateByClerkOrganizationId("team");
    await membershipsRepository.upsert(org.id, recipient.userId, "member");
    const organization = { id: org.id, clerkOrganizationId: org.clerkOrganizationId, role: "member" as const };
    const doc = await documentsService.createDocument({ ...owner, organization });
    await permissionsService.grantPermission(owner, doc.id, { targetUserId: recipient.userId, role: "VIEWER" });
    expect((await documentsService.listDocuments({ ...recipient, organization })).documents[0].effectiveRole).toBe("VIEWER");
    clerk.list.mockRejectedValue(new Error("Provider offline"));
    expect(await permissionsService.getSharing(owner, doc.id)).toMatchObject({ profileWarning: true, grants: [{ userId: recipient.userId, role: "VIEWER" }] });
    await permissionsService.revokePermission(owner, doc.id, { targetUserId: recipient.userId });
    expect((await documentsService.getDocument({ ...recipient, organization }, doc.id)).effectiveRole).toBe("EDITOR");
    expect((await documentsService.listDocuments({ ...recipient, organization }, { scope: "shared" })).documents).toHaveLength(0);
  });
});
