import "server-only";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { ActorContext } from "../auth/actor-context";
import type { EffectiveRole } from "../auth/authorization";
import { commentMessages, commentThreads } from "../db/schema";
import { getDb } from "../db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { auditRepository, AUDIT_ACTIONS } from "../repositories/audit";
import { commentsRepository } from "../repositories/comments";
import { documentsService } from "./documents";

const uuid = z.string().uuid();
const itemId = z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/).refine((value) => {
  const [replica, counter] = value.split(":").map(BigInt);
  return replica <= (1n << 64n) - 1n && counter <= (1n << 63n) - 1n;
});
const anchorPoint = z.object({ itemId, side: z.enum(["before", "after"]) });
const createThreadSchema = z.object({
  threadId: uuid,
  messageId: uuid,
  anchor: z.object({ start: anchorPoint, end: anchorPoint }),
  quote: z.string().max(1000),
  body: z.string().trim().min(1).max(4000),
});
const replySchema = z.object({ messageId: uuid, body: z.string().trim().min(1).max(4000) });
const statusSchema = z.enum(["open", "resolved"]);

function validateDocumentId(value: unknown): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid document id");
  return parsed.data;
}

function requireComment(role: EffectiveRole): void {
  if (role !== "OWNER" && role !== "EDITOR" && role !== "COMMENTER") {
    throw new ForbiddenError("Comment access required");
  }
}

function toDto(
  thread: Awaited<ReturnType<typeof commentsRepository.listThreads>>["rows"][number],
  messages: Awaited<ReturnType<typeof commentsRepository.listMessages>>["rows"],
) {
  return {
    id: thread.id,
    documentId: thread.documentId,
    anchor: {
      start: { itemId: thread.startItemId, side: thread.startSide },
      end: { itemId: thread.endItemId, side: thread.endSide },
    },
    quote: thread.quotedText,
    status: thread.status,
    createdBy: thread.createdByUserId,
    authorName: thread.authorName,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    messages: messages
      .filter((message) => message.threadId === thread.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((message) => ({
        id: message.id,
        createdBy: message.createdByUserId,
        authorName: message.authorName,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
      })),
  };
}

export const commentsService = {
  async list(actor: ActorContext, documentIdInput: unknown) {
    const documentId = validateDocumentId(documentIdInput);
    await documentsService.getDocument(actor, documentId);
    const threadPage = await commentsRepository.listThreads(documentId);
    const messagePage = await commentsRepository.listMessages(threadPage.rows.map((thread) => thread.id));
    const grouped = new Map<string, typeof messagePage.rows>();
    for (const message of messagePage.rows) {
      const rows = grouped.get(message.threadId) ?? [];
      rows.push(message);
      grouped.set(message.threadId, rows);
    }
    return {
      threads: threadPage.rows.map((thread) => toDto(thread, grouped.get(thread.id) ?? [])),
      truncated: { threads: threadPage.hasMore, messages: messagePage.hasMore },
    };
  },

  /** A retry with the same IDs and bytes returns the committed thread. */
  async createThread(actor: ActorContext, documentIdInput: unknown, input: unknown) {
    const documentId = validateDocumentId(documentIdInput);
    const parsed = createThreadSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError("Invalid comment thread");
    // Thread IDs are global idempotency keys. Reject a reused ID before
    // document authorization so a retry cannot silently target another
    // document; same-document retries continue through the normal ACL path.
    const existingById = await commentsRepository.findThreadById(parsed.data.threadId);
    if (existingById && existingById.documentId !== documentId) {
      throw new ConflictError("Comment ID already exists");
    }
    const document = await documentsService.getDocument(actor, documentId);
    requireComment(document.effectiveRole);

    const { threadId, messageId, anchor, quote, body } = parsed.data;
    return getDb().transaction(async (tx) => {
      const existing = await commentsRepository.findThread(documentId, threadId, tx);
      if (existing) {
        const existingMessage = await commentsRepository.findMessage(messageId, tx);
        if (
          existing.createdByUserId === actor.userId &&
          existing.startItemId === anchor.start.itemId &&
          existing.startSide === anchor.start.side &&
          existing.endItemId === anchor.end.itemId &&
          existing.endSide === anchor.end.side &&
          existing.quotedText === quote &&
          existingMessage?.threadId === threadId &&
          existingMessage.createdByUserId === actor.userId &&
          existingMessage.body === body
        ) return { id: threadId, duplicate: true };
        throw new ConflictError("Comment ID already exists");
      }

      const inserted = await tx.insert(commentThreads).values({
        id: threadId,
        documentId,
        createdByUserId: actor.userId,
        startItemId: anchor.start.itemId,
        startSide: anchor.start.side,
        endItemId: anchor.end.itemId,
        endSide: anchor.end.side,
        quotedText: quote,
      }).onConflictDoNothing().returning({ id: commentThreads.id });
      if (inserted.length === 0) {
        // A concurrent retry may have committed between the read and insert.
        const raced = await commentsRepository.findThread(documentId, threadId, tx);
        const racedMessage = await commentsRepository.findMessage(messageId, tx);
        if (
          raced?.createdByUserId === actor.userId &&
          raced.startItemId === anchor.start.itemId && raced.startSide === anchor.start.side &&
          raced.endItemId === anchor.end.itemId && raced.endSide === anchor.end.side &&
          raced.quotedText === quote &&
          racedMessage?.threadId === threadId &&
          racedMessage.createdByUserId === actor.userId &&
          racedMessage.body === body
        ) return { id: threadId, duplicate: true };
        throw new ConflictError("Comment ID already exists");
      }

      await tx.insert(commentMessages).values({
        id: messageId,
        threadId,
        createdByUserId: actor.userId,
        body,
      });
      await auditRepository.insert({
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentCommentCreated,
        resourceType: "document_comment",
        resourceId: threadId,
        organizationId: document.organizationId,
        metadata: { documentId },
      }, tx);
      return { id: threadId, duplicate: false };
    });
  },

  /** Reply IDs make offline retries safe without storing duplicate messages. */
  async addMessage(actor: ActorContext, documentIdInput: unknown, threadIdInput: unknown, input: unknown) {
    const documentId = validateDocumentId(documentIdInput);
    const threadId = uuid.safeParse(threadIdInput);
    const parsed = replySchema.safeParse(input);
    if (!threadId.success || !parsed.success) throw new ValidationError("Invalid comment reply");
    const document = await documentsService.getDocument(actor, documentId);
    requireComment(document.effectiveRole);

    return getDb().transaction(async (tx) => {
      // Serialize replies with status changes so a reply cannot race a resolve.
      const thread = await commentsRepository.findThreadForUpdate(documentId, threadId.data, tx);
      if (!thread) throw new NotFoundError("Comment thread not found");

      // An ambiguous offline retry must succeed even if the first attempt
      // committed just before another editor resolved the thread.
      const existing = await commentsRepository.findMessage(parsed.data.messageId, tx);
      if (existing) {
        if (
          existing.threadId === thread.id && existing.createdByUserId === actor.userId &&
          existing.body === parsed.data.body
        ) return { id: existing.id, duplicate: true };
        throw new ConflictError("Comment message ID already exists");
      }
      if (thread.status === "resolved") throw new ConflictError("Comment thread is resolved");

      const inserted = await tx.insert(commentMessages).values({
        id: parsed.data.messageId,
        threadId: thread.id,
        createdByUserId: actor.userId,
        body: parsed.data.body,
      }).onConflictDoNothing().returning({ id: commentMessages.id });
      if (inserted.length === 0) {
        const raced = await commentsRepository.findMessage(parsed.data.messageId, tx);
        if (raced?.threadId === thread.id && raced.createdByUserId === actor.userId && raced.body === parsed.data.body) {
          return { id: raced.id, duplicate: true };
        }
        throw new ConflictError("Comment message ID already exists");
      }

      await tx.update(commentThreads).set({ updatedAt: new Date() }).where(eq(commentThreads.id, thread.id));
      await auditRepository.insert({
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentCommentReplied,
        resourceType: "document_comment",
        resourceId: thread.id,
        organizationId: document.organizationId,
        metadata: { documentId, messageId: parsed.data.messageId },
      }, tx);
      return { id: parsed.data.messageId, duplicate: false };
    });
  },

  async setStatus(actor: ActorContext, documentIdInput: unknown, threadIdInput: unknown, statusInput: unknown) {
    const documentId = validateDocumentId(documentIdInput);
    const threadId = uuid.safeParse(threadIdInput);
    const status = statusSchema.safeParse(statusInput);
    if (!threadId.success || !status.success) throw new ValidationError("Invalid comment thread status");
    const document = await documentsService.getDocument(actor, documentId);
    const role = document.effectiveRole;
    if (role !== "OWNER" && role !== "EDITOR") throw new ForbiddenError("Only editors can resolve comments");

    return getDb().transaction(async (tx) => {
      const thread = await commentsRepository.findThreadForUpdate(documentId, threadId.data, tx);
      if (!thread) throw new NotFoundError("Comment thread not found");
      if (thread.status === status.data) return { status: status.data };
      await tx.update(commentThreads).set({ status: status.data, updatedAt: new Date() }).where(
        and(eq(commentThreads.documentId, documentId), eq(commentThreads.id, thread.id)),
      );
      await auditRepository.insert({
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentCommentResolved,
        resourceType: "document_comment",
        resourceId: thread.id,
        organizationId: document.organizationId,
        metadata: { documentId, status: status.data },
      }, tx);
      return { status: status.data };
    });
  },
};
