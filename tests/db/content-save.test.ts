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
import { getTestPool, truncateAll } from "./helpers";

/**
 * M028 + M046: transitional content persistence with optimistic concurrency
 * — stale writers must never silently overwrite newer server content.
 */

async function seed(): Promise<{
  owner: ActorContext;
  editor: ActorContext;
  viewer: ActorContext;
  outsider: ActorContext;
  docId: string;
}> {
  const userO = await usersRepository.findOrCreateByClerkUserId("c_owner");
  const userE = await usersRepository.findOrCreateByClerkUserId("c_editor");
  const userV = await usersRepository.findOrCreateByClerkUserId("c_viewer");
  const userX = await usersRepository.findOrCreateByClerkUserId("c_outsider");
  const org = await organizationsRepository.findOrCreateByClerkOrganizationId("c_org");
  await membershipsRepository.upsert(org.id, userO.id, "admin");

  const owner: ActorContext = { userId: userO.id, clerkUserId: "c_owner", organization: null };
  const editor: ActorContext = { userId: userE.id, clerkUserId: "c_editor", organization: null };
  const viewer: ActorContext = { userId: userV.id, clerkUserId: "c_viewer", organization: null };
  const outsider: ActorContext = { userId: userX.id, clerkUserId: "c_outsider", organization: null };

  const doc = await documentsService.createDocument(owner, { title: "Concurrent" });
  await permissionsService.grantPermission(owner, doc.id, {
    targetUserId: userE.id,
    role: "EDITOR",
  });
  await permissionsService.grantPermission(owner, doc.id, {
    targetUserId: userV.id,
    role: "VIEWER",
  });
  return { owner, editor, viewer, outsider, docId: doc.id };
}

const ENVELOPE = (text: string) => ({ v: 1, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } });

describe("content save (optimistic concurrency)", () => {
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

  it("saves content and returns the incremented version; second save uses the returned version", async () => {
    const { owner, docId } = await seed();
    const first = await documentsService.saveDocumentContent(owner, docId, {
      content: ENVELOPE("hello"),
      expectedContentVersion: 1,
    });
    expect(first.contentVersion).toBe(2);

    const second = await documentsService.saveDocumentContent(owner, docId, {
      content: ENVELOPE("hello world"),
      expectedContentVersion: first.contentVersion,
    });
    expect(second.contentVersion).toBe(3);

    const doc = await documentsService.getDocument(owner, docId);
    expect(doc.content).toEqual(ENVELOPE("hello world"));
    expect(doc.contentVersion).toBe(3);
  });

  it("bumps updated_at on content save (list ordering freshness)", async () => {
    const { owner, docId } = await seed();
    const before = (await documentsService.getDocument(owner, docId)).updatedAt;
    await documentsService.saveDocumentContent(owner, docId, {
      content: ENVELOPE("tick"),
      expectedContentVersion: 1,
    });
    const after = (await documentsService.getDocument(owner, docId)).updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it("EDITOR can save; VIEWER cannot (masked); outsider cannot", async () => {
    const { editor, viewer, outsider, docId } = await seed();
    const ok = await documentsService.saveDocumentContent(editor, docId, {
      content: ENVELOPE("editor edit"),
      expectedContentVersion: 1,
    });
    expect(ok.contentVersion).toBe(2);

    await expect(
      documentsService.saveDocumentContent(viewer, docId, {
        content: ENVELOPE("viewer edit"),
        expectedContentVersion: 2,
      }),
    ).rejects.toThrow(NotFoundError);

    await expect(
      documentsService.saveDocumentContent(outsider, docId, {
        content: ENVELOPE("hax"),
        expectedContentVersion: 2,
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("stale expected version → ConflictError; server content preserved", async () => {
    const { owner, docId } = await seed();
    const v2 = await documentsService.saveDocumentContent(owner, docId, {
      content: ENVELOPE("newest"),
      expectedContentVersion: 1,
    });
    await expect(
      documentsService.saveDocumentContent(owner, docId, {
        content: ENVELOPE("stale"),
        expectedContentVersion: 1,
      }),
    ).rejects.toThrow(ConflictError);
    const doc = await documentsService.getDocument(owner, docId);
    expect(doc.content).toEqual(ENVELOPE("newest"));
    expect(doc.contentVersion).toBe(v2.contentVersion);
  });

  it("two concurrent saves with the same expected version: exactly one wins, one conflicts", async () => {
    const { owner, docId } = await seed();
    const [r1, r2] = await Promise.allSettled([
      documentsService.saveDocumentContent(owner, docId, {
        content: ENVELOPE("tab A"),
        expectedContentVersion: 1,
      }),
      documentsService.saveDocumentContent(owner, docId, {
        content: ENVELOPE("tab B"),
        expectedContentVersion: 1,
      }),
    ]);
    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    // The winner's content is on the server, version advanced to 2.
    // (JSONB normalizes key order, so compare structurally.)
    const doc = await documentsService.getDocument(owner, docId);
    expect(doc.contentVersion).toBe(2);
    expect([ENVELOPE("tab A"), ENVELOPE("tab B")]).toContainEqual(doc.content);
  });

  it("sequential (non-concurrent) stale saves always conflict", async () => {
    const { owner, docId } = await seed();
    await documentsService.saveDocumentContent(owner, docId, { content: ENVELOPE("1"), expectedContentVersion: 1 });
    await documentsService.saveDocumentContent(owner, docId, { content: ENVELOPE("2"), expectedContentVersion: 2 });
    for (const stale of [1, 2]) {
      await expect(
        documentsService.saveDocumentContent(owner, docId, { content: ENVELOPE("stale"), expectedContentVersion: stale }),
      ).rejects.toThrow(ConflictError);
    }
  });

  it("rejects malformed payloads: non-envelope, arrays, non-serializable, oversized", async () => {
    const { owner, docId } = await seed();
    await expect(
      documentsService.saveDocumentContent(owner, docId, { content: "string", expectedContentVersion: 1 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      documentsService.saveDocumentContent(owner, docId, { content: [1, 2], expectedContentVersion: 1 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      documentsService.saveDocumentContent(owner, docId, { content: { v: 1 }, expectedContentVersion: 1 }),
    ).rejects.toThrow(ValidationError); // missing doc field
    await expect(
      documentsService.saveDocumentContent(owner, docId, { content: { v: 2, doc: {} }, expectedContentVersion: 1 }),
    ).rejects.toThrow(ValidationError); // unsupported content version
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await expect(
      documentsService.saveDocumentContent(owner, docId, { content: circular, expectedContentVersion: 1 }),
    ).rejects.toThrow(ValidationError);
    const oversized = ENVELOPE("x".repeat(2 * 1024 * 1024 + 10));
    await expect(
      documentsService.saveDocumentContent(owner, docId, { content: oversized, expectedContentVersion: 1 }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects invalid expected versions and malformed document ids", async () => {
    const { owner, docId } = await seed();
    await expect(
      documentsService.saveDocumentContent(owner, docId, { content: ENVELOPE("x"), expectedContentVersion: 0 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      documentsService.saveDocumentContent(owner, docId, { content: ENVELOPE("x"), expectedContentVersion: 1.5 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      documentsService.saveDocumentContent(owner, "bad-id", { content: ENVELOPE("x"), expectedContentVersion: 1 }),
    ).rejects.toThrow(ValidationError);
  });

  it("save to a deleted document → NotFoundError", async () => {
    const { owner, docId } = await seed();
    await documentsService.deleteDocument(owner, docId);
    await expect(
      documentsService.saveDocumentContent(owner, docId, { content: ENVELOPE("x"), expectedContentVersion: 1 }),
    ).rejects.toThrow(NotFoundError);
  });
});
