import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { ActorContext } from "../../src/server/auth/actor-context";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/server/errors";
import { usersRepository } from "../../src/server/repositories/users";
import { documentsService } from "../../src/server/services/documents";
import { permissionsService } from "../../src/server/services/permissions";
import { suggestionsService } from "../../src/server/services/suggestions";
import { getTestPool, truncateAll } from "./helpers";

const anchor = {
  start: { itemId: "7:1", side: "before" as const },
  end: { itemId: "7:8", side: "after" as const },
};

function suggestionInput(overrides: Partial<{ quote: string; proposedText: string; suggestionId: string }> = {}) {
  return {
    suggestionId: overrides.suggestionId ?? crypto.randomUUID(),
    anchor,
    quote: overrides.quote ?? "selected text",
    proposedText: overrides.proposedText ?? "better text",
  };
}

async function seedWorld() {
  const makeActor = async (name: string): Promise<ActorContext> => {
    const clerkUserId = `suggestion_${name}`;
    const user = await usersRepository.findOrCreateByClerkUserId(clerkUserId);
    return { userId: user.id, clerkUserId, organization: null };
  };
  const owner = await makeActor("owner");
  const editor = await makeActor("editor");
  const commenter = await makeActor("commenter");
  const viewer = await makeActor("viewer");
  const outsider = await makeActor("outsider");
  const document = await documentsService.createDocument(owner, { title: "Suggestion test" });

  for (const [actor, role] of [
    [editor, "EDITOR"],
    [commenter, "COMMENTER"],
    [viewer, "VIEWER"],
  ] as const) {
    await permissionsService.grantPermission(owner, document.id, {
      targetUserId: actor.userId,
      role,
    });
  }
  return { owner, editor, commenter, viewer, outsider, documentId: document.id };
}

describe("suggestions (PostgreSQL integration)", () => {
  let pool: Pool;

  beforeAll(() => { pool = getTestPool(); });
  afterEach(async () => { await truncateAll(pool); });
  afterAll(async () => { await pool.end(); });

  it("enforces propose/accept/reject roles and masks cross-user reads", async () => {
    const world = await seedWorld();
    const input = suggestionInput();

    // VIEWER cannot propose; COMMENTER can; outsiders cannot even read.
    await expect(suggestionsService.create(world.viewer, world.documentId, input)).rejects.toThrow(ForbiddenError);
    expect((await suggestionsService.create(world.commenter, world.documentId, input)).duplicate).toBe(false);
    expect((await suggestionsService.list(world.viewer, world.documentId)).suggestions.map(({ id }) => id))
      .toEqual([input.suggestionId]);
    await expect(suggestionsService.list(world.outsider, world.documentId)).rejects.toThrow(NotFoundError);

    // COMMENTER proposes but cannot accept (accept mutates the document).
    await expect(suggestionsService.resolve(world.commenter, world.documentId, input.suggestionId, { action: "accept" }))
      .rejects.toThrow(ForbiddenError);
    // EDITOR accepts.
    await expect(suggestionsService.resolve(world.editor, world.documentId, input.suggestionId, { action: "accept" }))
      .resolves.toEqual({ status: "accepted" });
    const [accepted] = (await suggestionsService.list(world.editor, world.documentId)).suggestions;
    expect(accepted.status).toBe("accepted");
    expect(accepted.resolvedAt).not.toBeNull();
  });

  it("lets the author reject or withdraw their own proposal but not accept it", async () => {
    const world = await seedWorld();
    const input = suggestionInput();
    await suggestionsService.create(world.commenter, world.documentId, input);

    await expect(suggestionsService.resolve(world.commenter, world.documentId, input.suggestionId, { action: "accept" }))
      .rejects.toThrow(ForbiddenError);
    await expect(suggestionsService.resolve(world.commenter, world.documentId, input.suggestionId, { action: "reject" }))
      .resolves.toEqual({ status: "rejected" });
  });

  it("makes retries idempotent and rejects conflicting terminal states", async () => {
    const world = await seedWorld();
    const input = suggestionInput();
    await suggestionsService.create(world.commenter, world.documentId, input);

    expect((await suggestionsService.create(world.commenter, world.documentId, input)).duplicate).toBe(true);
    // Same ID, different bytes: conflict (never a silent second suggestion).
    await expect(suggestionsService.create(world.commenter, world.documentId, suggestionInput({
      suggestionId: input.suggestionId,
      proposedText: "different",
    }))).rejects.toThrow(ConflictError);
    // Cross-document reuse of a suggestion ID: conflict (a retry must never
    // silently target another document).
    const otherDoc = await documentsService.createDocument(world.commenter, { title: "Other doc" });
    await expect(suggestionsService.create(world.commenter, otherDoc.id, suggestionInput({
      suggestionId: input.suggestionId,
    }))).rejects.toThrow(ConflictError);

    await suggestionsService.resolve(world.editor, world.documentId, input.suggestionId, { action: "accept" });
    // Same action retries are idempotent; the opposite action conflicts.
    expect((await suggestionsService.resolve(world.editor, world.documentId, input.suggestionId, { action: "accept" })))
      .toEqual({ status: "accepted" });
    await expect(suggestionsService.resolve(world.editor, world.documentId, input.suggestionId, { action: "reject" }))
      .rejects.toThrow(ConflictError);
    await expect(suggestionsService.resolve(world.editor, world.documentId, input.suggestionId, { action: "discharge" }))
      .rejects.toThrow(ConflictError);
    // Unknown suggestion: 404 semantics.
    await expect(suggestionsService.resolve(world.editor, world.documentId, crypto.randomUUID(), { action: "accept" }))
      .rejects.toThrow(NotFoundError);
  });

  it("discharge is reachable from proposed, author- or editor-driven, and idempotent", async () => {
    const world = await seedWorld();
    const input = suggestionInput();
    await suggestionsService.create(world.commenter, world.documentId, input);

    // The author can discharge their own proposal when the anchor orphans.
    expect((await suggestionsService.resolve(world.commenter, world.documentId, input.suggestionId, { action: "discharge" })))
      .toEqual({ status: "discharged" });
    expect((await suggestionsService.resolve(world.commenter, world.documentId, input.suggestionId, { action: "discharge" })))
      .toEqual({ status: "discharged" });
    await expect(suggestionsService.resolve(world.editor, world.documentId, input.suggestionId, { action: "accept" }))
      .rejects.toThrow(ConflictError);

    const [created] = (await suggestionsService.list(world.owner, world.documentId)).suggestions;
    expect(created.status).toBe("discharged");
  });
});
