import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import type { ActorContext } from "../../src/server/auth/actor-context";
import { ConflictError, ForbiddenError, NotFoundError } from "../../src/server/errors";
import { auditRepository } from "../../src/server/repositories/audit";
import { usersRepository } from "../../src/server/repositories/users";
import { commentsService } from "../../src/server/services/comments";
import { documentsService } from "../../src/server/services/documents";
import { permissionsService } from "../../src/server/services/permissions";
import { getTestPool, truncateAll } from "./helpers";

const anchor = {
  start: { itemId: "7:1", side: "before" as const },
  end: { itemId: "7:8", side: "after" as const },
};

async function seedWorld() {
  const makeActor = async (name: string): Promise<ActorContext> => {
    const clerkUserId = `comment_${name}`;
    const user = await usersRepository.findOrCreateByClerkUserId(clerkUserId);
    return { userId: user.id, clerkUserId, organization: null };
  };
  const owner = await makeActor("owner");
  const editor = await makeActor("editor");
  const commenter = await makeActor("commenter");
  const viewer = await makeActor("viewer");
  const outsider = await makeActor("outsider");
  const document = await documentsService.createDocument(owner, { title: "Review test" });

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

describe("comment threads (PostgreSQL integration)", () => {
  let pool: Pool;

  beforeAll(() => { pool = getTestPool(); });
  afterEach(async () => { await truncateAll(pool); });
  afterAll(async () => { await pool.end(); });

  it("enforces read/comment/resolve roles and masks cross-user reads", async () => {
    const world = await seedWorld();
    const threadId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const input = { threadId, messageId, anchor, quote: "selected text", body: "Please review" };

    await expect(commentsService.createThread(world.viewer, world.documentId, input)).rejects.toThrow(ForbiddenError);
    expect((await commentsService.createThread(world.commenter, world.documentId, input)).duplicate).toBe(false);
    expect((await commentsService.list(world.viewer, world.documentId)).threads.map(({ id }) => id)).toEqual([threadId]);
    await expect(commentsService.list(world.outsider, world.documentId)).rejects.toThrow(NotFoundError);
    await expect(commentsService.setStatus(world.commenter, world.documentId, threadId, "resolved"))
      .rejects.toThrow(ForbiddenError);
    const reply = { messageId: crypto.randomUUID(), body: "Offline reply" };
    expect((await commentsService.addMessage(world.commenter, world.documentId, threadId, reply)).duplicate).toBe(false);
    await expect(commentsService.setStatus(world.editor, world.documentId, threadId, "resolved"))
      .resolves.toEqual({ status: "resolved" });
    expect((await commentsService.addMessage(world.commenter, world.documentId, threadId, reply)).duplicate).toBe(true);
    await expect(commentsService.addMessage(world.commenter, world.documentId, threadId, {
      messageId: crypto.randomUUID(), body: "Too late",
    })).rejects.toThrow(ConflictError);
  });

  it("makes concurrent offline retries idempotent and rejects changed payloads", async () => {
    const world = await seedWorld();
    const threadId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    const input = { threadId, messageId, anchor, quote: "selected text", body: "Offline note" };

    const retries = await Promise.all([
      commentsService.createThread(world.commenter, world.documentId, input),
      commentsService.createThread(world.commenter, world.documentId, input),
    ]);
    expect(retries.map(({ duplicate }) => duplicate).sort()).toEqual([false, true]);
    await expect(commentsService.createThread(world.commenter, world.documentId, {
      ...input,
      body: "Different bytes under the same IDs",
    })).rejects.toThrow(ConflictError);

    const replyId = crypto.randomUUID();
    const reply = { messageId: replyId, body: "Reply after reconnect" };
    expect((await commentsService.addMessage(world.editor, world.documentId, threadId, reply)).duplicate).toBe(false);
    expect((await commentsService.addMessage(world.editor, world.documentId, threadId, reply)).duplicate).toBe(true);
    await expect(commentsService.addMessage(world.owner, world.documentId, threadId, {
      messageId: replyId, body: "Different reply bytes",
    })).rejects.toThrow(ConflictError);

    const events = await auditRepository.listByResource(threadId);
    expect(events.map(({ action }) => action).sort()).toEqual([
      "document.comment.created",
      "document.comment.replied",
    ]);
  });

  it("rejects a thread ID from another document or author", async () => {
    const world = await seedWorld();
    const other = await documentsService.createDocument(world.owner, { title: "Other document" });
    const threadId = crypto.randomUUID();
    const first = {
      threadId,
      messageId: crypto.randomUUID(),
      anchor,
      quote: "selected text",
      body: "Owner's comment",
    };
    await commentsService.createThread(world.owner, world.documentId, first);
    await expect(commentsService.createThread(world.editor, other.id, {
      ...first,
      messageId: crypto.randomUUID(),
    })).rejects.toThrow(ConflictError);
    await expect(commentsService.addMessage(world.outsider, world.documentId, threadId, {
      messageId: crypto.randomUUID(),
      body: "Forged cross-user reply",
    })).rejects.toThrow(NotFoundError);
  });

  it("ranks messages per thread so a busy thread cannot starve another thread's root", async () => {
    // Mirrors MESSAGE_LIMIT_PER_THREAD in the repository. A global cap would
    // let one very active thread evict a quiet thread's only (root) comment;
    // per-thread ranking bounds each thread independently instead.
    const perThreadLimit = 50;
    const world = await seedWorld();

    const quietThreadId = crypto.randomUUID();
    await commentsService.createThread(world.owner, world.documentId, {
      threadId: quietThreadId,
      messageId: crypto.randomUUID(),
      anchor,
      quote: "quiet passage",
      body: "The only comment on a quiet thread",
    });

    const busyThreadId = crypto.randomUUID();
    await commentsService.createThread(world.owner, world.documentId, {
      threadId: busyThreadId,
      messageId: crypto.randomUUID(),
      anchor,
      quote: "busy passage",
      body: "Busy thread root",
    });
    for (let index = 0; index < perThreadLimit; index += 1) {
      await commentsService.addMessage(world.owner, world.documentId, busyThreadId, {
        messageId: crypto.randomUUID(),
        body: `Busy reply ${index}`,
      });
    }

    const listed = await commentsService.list(world.owner, world.documentId);
    const quiet = listed.threads.find((thread) => thread.id === quietThreadId);
    const busy = listed.threads.find((thread) => thread.id === busyThreadId);

    // The quiet thread's root survives despite the busy thread's volume.
    expect(quiet?.messages.map((message) => message.body)).toEqual([
      "The only comment on a quiet thread",
    ]);
    // The busy thread is bounded to the per-thread limit and flags truncation.
    expect(busy?.messages).toHaveLength(perThreadLimit);
    expect(listed.truncated.messages).toBe(true);
  });
});
