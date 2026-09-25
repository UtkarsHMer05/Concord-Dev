import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";

import type { ActorContext } from "../auth/actor-context";
import type { EffectiveRole } from "../auth/authorization";
import { documentSuggestions } from "../db/schema";
import { getDb } from "../db/client";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { auditRepository, AUDIT_ACTIONS } from "../repositories/audit";
import { suggestionsRepository } from "../repositories/suggestions";
import { documentsService } from "./documents";

const uuid = z.string().uuid();
const itemId = z.string().regex(/^[1-9][0-9]*:[1-9][0-9]*$/).refine((value) => {
  const [replica, counter] = value.split(":").map(BigInt);
  return replica <= (1n << 64n) - 1n && counter <= (1n << 63n) - 1n;
});
const anchorPoint = z.object({ itemId, side: z.enum(["before", "after"]) });
const createSuggestionSchema = z.object({
  suggestionId: uuid,
  anchor: z.object({ start: anchorPoint, end: anchorPoint }),
  quote: z.string().max(1000),
  /** The replacement text: "" = deletion, anchored zero-width range = insertion. */
  proposedText: z.string().max(4000),
});
const resolveSchema = z.object({ action: z.enum(["accept", "reject", "discharge"]) });

function validateDocumentId(value: unknown): string {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new ValidationError("Invalid document id");
  return parsed.data;
}

/** Proposing is comment-level access (COMMENTER+); the proposal changes
 *  nothing by itself — only ACCEPT mutates the document, and that is
 *  editor-only below. */
function requirePropose(role: EffectiveRole): void {
  if (role !== "OWNER" && role !== "EDITOR" && role !== "COMMENTER") {
    throw new ForbiddenError("Suggestion access required");
  }
}

function toDto(suggestion: Awaited<ReturnType<typeof suggestionsRepository.listSuggestions>>["rows"][number]) {
  return {
    id: suggestion.id,
    documentId: suggestion.documentId,
    anchor: {
      start: { itemId: suggestion.startItemId, side: suggestion.startSide },
      end: { itemId: suggestion.endItemId, side: suggestion.endSide },
    },
    quote: suggestion.quotedText,
    proposedText: suggestion.proposedText,
    status: suggestion.status,
    createdBy: suggestion.createdByUserId,
    authorName: suggestion.authorName,
    createdAt: suggestion.createdAt.toISOString(),
    resolvedAt: suggestion.resolvedAt?.toISOString() ?? null,
  };
}

export const suggestionsService = {
  async list(actor: ActorContext, documentIdInput: unknown) {
    const documentId = validateDocumentId(documentIdInput);
    await documentsService.getDocument(actor, documentId);
    const page = await suggestionsRepository.listSuggestions(documentId);
    return {
      suggestions: page.rows.map(toDto),
      truncated: { suggestions: page.hasMore },
    };
  },

  /** Suggestion IDs are global idempotency keys (comment-thread pattern):
   *  a retry with the same ID and bytes returns the committed suggestion. */
  async create(actor: ActorContext, documentIdInput: unknown, input: unknown) {
    const documentId = validateDocumentId(documentIdInput);
    const parsed = createSuggestionSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError("Invalid suggestion");
    const existingById = await suggestionsRepository.findSuggestionById(parsed.data.suggestionId);
    if (existingById && existingById.documentId !== documentId) {
      throw new ConflictError("Suggestion ID already exists");
    }
    const document = await documentsService.getDocument(actor, documentId);
    requirePropose(document.effectiveRole);

    const { suggestionId, anchor, quote, proposedText } = parsed.data;
    const sameBytes = (row: typeof existingById) =>
      row !== null &&
      row.createdByUserId === actor.userId &&
      row.startItemId === anchor.start.itemId &&
      row.startSide === anchor.start.side &&
      row.endItemId === anchor.end.itemId &&
      row.endSide === anchor.end.side &&
      row.quotedText === quote &&
      row.proposedText === proposedText;

    return getDb().transaction(async (tx) => {
      const existing = await suggestionsRepository.findSuggestion(documentId, suggestionId, tx);
      if (existing) {
        if (sameBytes(existing)) return { id: suggestionId, duplicate: true };
        throw new ConflictError("Suggestion ID already exists");
      }

      const inserted = await tx.insert(documentSuggestions).values({
        id: suggestionId,
        documentId,
        createdByUserId: actor.userId,
        startItemId: anchor.start.itemId,
        startSide: anchor.start.side,
        endItemId: anchor.end.itemId,
        endSide: anchor.end.side,
        quotedText: quote,
        proposedText,
      }).onConflictDoNothing().returning({ id: documentSuggestions.id });
      if (inserted.length === 0) {
        const raced = await suggestionsRepository.findSuggestion(documentId, suggestionId, tx);
        if (sameBytes(raced)) return { id: suggestionId, duplicate: true };
        throw new ConflictError("Suggestion ID already exists");
      }

      await auditRepository.insert({
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentSuggestionCreated,
        resourceType: "document_suggestion",
        resourceId: suggestionId,
        organizationId: document.organizationId,
        metadata: { documentId },
      }, tx);
      return { id: suggestionId, duplicate: false };
    });
  },

  /**
   * Accept/reject/discharge. Accepting is EDITOR+ (it authorizes a document
   * mutation, which the client then applies through the editor bridge as
   * durable CRDT edits); rejecting/withdrawing is EDITOR+ or the author;
   * discharge records the honest terminal state when the anchored text was
   * deleted before the suggestion was applied (same rule as comments'
   * orphan handling). Idempotent on the same action; a conflicting terminal
   * state (accept after reject, reject after accept) is a 409.
   */
  async resolve(actor: ActorContext, documentIdInput: unknown, suggestionIdInput: unknown, input: unknown) {
    const documentId = validateDocumentId(documentIdInput);
    const suggestionId = uuid.safeParse(suggestionIdInput);
    const parsed = resolveSchema.safeParse(input);
    if (!suggestionId.success || !parsed.success) throw new ValidationError("Invalid suggestion resolution");
    const document = await documentsService.getDocument(actor, documentId);
    const role = document.effectiveRole;
    const isEditor = role === "OWNER" || role === "EDITOR";

    return getDb().transaction(async (tx) => {
      const suggestion = await tx
        .select()
        .from(documentSuggestions)
        .where(eq(documentSuggestions.id, suggestionId.data))
        .for("update")
        .limit(1);
      const row = suggestion[0];
      if (!row || row.documentId !== documentId) throw new NotFoundError("Suggestion not found");

      const action = parsed.data.action;
      if (row.status === "proposed") {
        if (action === "accept" && !isEditor) {
          throw new ForbiddenError("Only editors can accept suggestions");
        }
        if (
          (action === "reject" || action === "discharge") &&
          !isEditor && row.createdByUserId !== actor.userId
        ) {
          throw new ForbiddenError("Only editors or the author can resolve a suggestion");
        }
      } else {
        // Terminal states: same-action retries stay idempotent; everything
        // else conflicts (accept-after-reject would resurrect dead intent).
        if (action === "accept" && row.status === "accepted") return { status: "accepted" as const };
        if (action === "reject" && row.status === "rejected") return { status: "rejected" as const };
        if (row.status === "discharged") {
          // Discharge is the honest terminal state (anchor orphaned); a
          // retried discharge (or an editor acknowledging it) is idempotent.
          if (action === "discharge") return { status: "discharged" as const };
          throw new ConflictError("Suggestion was discharged");
        }
        throw new ConflictError("Suggestion already resolved");
      }

      const nextStatus = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "discharged";
      await tx
        .update(documentSuggestions)
        .set({
          status: nextStatus,
          resolvedAt: new Date(),
          resolvedByUserId: actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(documentSuggestions.id, row.id));
      await auditRepository.insert({
        actorUserId: actor.userId,
        action: AUDIT_ACTIONS.documentSuggestionResolved,
        resourceType: "document_suggestion",
        resourceId: row.id,
        organizationId: document.organizationId,
        metadata: { documentId, action },
      }, tx);
      return { status: nextStatus };
    });
  },
};
