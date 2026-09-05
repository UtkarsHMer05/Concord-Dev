import "server-only";

import { z } from "zod";

import { StoredContentEnvelope } from "@/lib/collaboration/content";

import {
  resolveEffectiveRole,
  roleHasCapability,
  type Capability,
  type EffectiveRole,
} from "../auth/authorization";
import type { ActorContext } from "../auth/actor-context";
import { getDb } from "../db/client";
import type { DocumentRow } from "../db/schema";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../errors";
import { AUDIT_ACTIONS, auditRepository } from "../repositories/audit";
import {
  documentsRepository,
  escapeLikePattern,
} from "../repositories/documents";
import { permissionsRepository } from "../repositories/permissions";

/**
 * Document business logic + authorization orchestration.
 *
 * Repositories own persistence; this layer enforces policy (docs/AUTHORIZATION.md):
 * - owner/org scope is derived from ActorContext, never from input;
 * - every operation reauthorizes;
 * - reads mask denial as NotFoundError (no existence leak);
 * - content/metadata writes are guarded by optimistic concurrency.
 */

export const DEFAULT_TITLE = "Untitled document";
export const MAX_TITLE_LENGTH = 200;
export const MAX_INITIAL_CONTENT_LENGTH = 512_000;
export const MAX_CONTENT_JSON_BYTES = 2 * 1024 * 1024; // 2 MiB transitional cap
export const DEFAULT_PAGE_SIZE = 5;
export const MAX_PAGE_SIZE = 50;
export const MAX_SEARCH_LENGTH = 200;

export interface DocumentSummaryDto {
  id: string;
  title: string;
  organizationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetailDto extends DocumentSummaryDto {
  /** Transitional template HTML (origin record; empty for blank docs). */
  initialContent: string | null;
  /** Transitional stored envelope {v:1, doc} or null until the first save. */
  content: StoredContentEnvelope | null;
  contentVersion: number;
  metadataVersion: number;
  effectiveRole: EffectiveRole;
}

export interface DocumentListResult {
  documents: DocumentSummaryDto[];
  hasMore: boolean;
}

function normalizeTitle(input: unknown): string {
  if (input === undefined || input === null) {
    return DEFAULT_TITLE;
  }
  if (typeof input !== "string") {
    throw new ValidationError("Title must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return DEFAULT_TITLE;
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      `Title must be at most ${MAX_TITLE_LENGTH} characters`,
    );
  }
  return trimmed;
}

function validateInitialContent(input: unknown): string | null {
  if (input === undefined || input === null || input === "") {
    return null;
  }
  if (typeof input !== "string") {
    throw new ValidationError("initialContent must be a string");
  }
  if (input.length > MAX_INITIAL_CONTENT_LENGTH) {
    throw new ValidationError("initialContent is too large");
  }
  return input;
}

function parseDocumentId(input: unknown): string {
  const parsed = z.string().regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  ).safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid document id");
  }
  return parsed.data;
}

interface AccessContext {
  document: DocumentRow;
  effectiveRole: EffectiveRole;
}

/**
 * Loads the document and resolves the actor's effective role. Denials are
 * masked as NotFoundError so unauthorized actors cannot distinguish a
 * missing document from one they cannot access.
 */
async function requireAccess(
  actor: ActorContext,
  documentId: string,
  capability: Capability,
): Promise<AccessContext> {
  const document = await documentsRepository.findById(documentId);
  if (!document) {
    throw new NotFoundError("Document not found");
  }
  const grant = await permissionsRepository.findGrant(documentId, actor.userId);
  const effectiveRole = resolveEffectiveRole(actor, document, grant?.role ?? null);
  if (effectiveRole === null || !roleHasCapability(effectiveRole, capability)) {
    // Mask: forbidden reads/mutations are indistinguishable from missing.
    throw new NotFoundError("Document not found");
  }
  return { document, effectiveRole };
}

function toSummaryDto(row: DocumentRow): DocumentSummaryDto {
  return {
    id: row.id,
    title: row.title,
    organizationId: row.organizationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const documentsService = {
  /**
   * Creates a document. Owner + organization scope derive exclusively from
   * the verified ActorContext. Writes a document.create audit event in the
   * same transaction.
   */
  async createDocument(
    actor: ActorContext,
    input: { title?: unknown; initialContent?: unknown } = {},
  ): Promise<{ id: string }> {
    const title = normalizeTitle(input.title);
    const initialContent = validateInitialContent(input.initialContent);
    const organizationId = actor.organization?.id ?? null;

    const db = getDb();
    const created = await db.transaction(async (tx) => {
      const document = await documentsRepository.insert(
        {
          title,
          ownerUserId: actor.userId,
          organizationId,
          initialContent,
        },
        tx,
      );
      await auditRepository.insert(
        {
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.documentCreate,
          resourceType: "document",
          resourceId: document.id,
          organizationId,
          metadata: { title: document.title },
        },
        tx,
      );
      return document;
    });

    return { id: created.id };
  },

  /** Open/read: metadata + content + effective role, after authorization. */
  async getDocument(actor: ActorContext, documentId: unknown): Promise<DocumentDetailDto> {
    const id = parseDocumentId(documentId);
    const { document, effectiveRole } = await requireAccess(actor, id, "read");
    return {
      ...toSummaryDto(document),
      initialContent: document.initialContent,
      content: (document.content as StoredContentEnvelope | null) ?? null,
      contentVersion: document.contentVersion,
      metadataVersion: document.metadataVersion,
      effectiveRole,
    };
  },

  /**
   * Lists documents in the actor's verified workspace scope (personal or
   * active organization). Scope filtering happens in SQL — unauthorized
   * documents are never fetched. Deterministic order: updated_at DESC, id.
   */
  async listDocuments(
    actor: ActorContext,
    input: { search?: unknown; page?: unknown; pageSize?: unknown } = {},
  ): Promise<DocumentListResult> {
    const page = (() => {
      const parsed = z.coerce.number().int().min(1).default(1).safeParse(
        input.page ?? undefined,
      );
      if (!parsed.success) throw new ValidationError("Invalid page");
      return parsed.data;
    })();

    const pageSize = (() => {
      const parsed = z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(
        DEFAULT_PAGE_SIZE,
      ).safeParse(input.pageSize ?? undefined);
      if (!parsed.success) throw new ValidationError("Invalid pageSize");
      return parsed.data;
    })();

    let titlePattern: string | null = null;
    if (input.search !== undefined && input.search !== null && input.search !== "") {
      if (typeof input.search !== "string") {
        throw new ValidationError("Invalid search");
      }
      const search = input.search.trim().slice(0, MAX_SEARCH_LENGTH);
      titlePattern = search.length > 0 ? escapeLikePattern(search) : null;
    }

    const offset = (page - 1) * pageSize;
    const limit = pageSize + 1; // fetch one extra to compute hasMore

    const rows = actor.organization
      ? await documentsRepository.listByOrganization(
          actor.organization.id,
          { limit, offset, titlePattern },
        )
      : await documentsRepository.listByOwner(
          actor.userId,
          { limit, offset, titlePattern },
        );

    const hasMore = rows.length > pageSize;
    return {
      documents: rows.slice(0, pageSize).map(toSummaryDto),
      hasMore,
    };
  },

  /**
   * Renames a document (EDITOR+). Uses the metadata version conditional
   * update so a stale title edit cannot silently win; writes a rename audit
   * event.
   */
  async renameDocument(
    actor: ActorContext,
    documentId: unknown,
    input: { title: unknown; expectedMetadataVersion: unknown },
  ): Promise<{ metadataVersion: number }> {
    const id = parseDocumentId(documentId);
    await requireAccess(actor, id, "rename");

    const title = normalizeTitle(input.title);
    const expectedMetadataVersion = z
      .number()
      .int()
      .min(1)
      .safeParse(input.expectedMetadataVersion);
    if (!expectedMetadataVersion.success) {
      throw new ValidationError("Invalid expectedMetadataVersion");
    }

    const updated = await documentsRepository.renameConditional(
      id,
      expectedMetadataVersion.data,
      title,
    );
    if (!updated) {
      const existing = await documentsRepository.findById(id);
      if (!existing) {
        throw new NotFoundError("Document not found");
      }
      throw new ConflictError("Document was modified concurrently");
    }

    await auditRepository.insert({
      actorUserId: actor.userId,
      action: AUDIT_ACTIONS.documentRename,
      resourceType: "document",
      resourceId: id,
      organizationId: actor.organization?.id ?? null,
      metadata: { title },
    });

    return { metadataVersion: updated.metadataVersion };
  },

  /**
   * Deletes a document (OWNER-only — an intentional tightening over the
   * Phase 0 org-member delete). The audit event is written in the same
   * transaction and survives the deletion (no FK on resource_id).
   */
  async deleteDocument(actor: ActorContext, documentId: unknown): Promise<void> {
    const id = parseDocumentId(documentId);
    const { document } = await requireAccess(actor, id, "delete");

    const db = getDb();
    await db.transaction(async (tx) => {
      await auditRepository.insert(
        {
          actorUserId: actor.userId,
          action: AUDIT_ACTIONS.documentDelete,
          resourceType: "document",
          resourceId: id,
          organizationId: document.organizationId,
          metadata: { title: document.title },
        },
        tx,
      );
      await documentsRepository.deleteById(id, tx);
    });
  },

  /**
   * TRANSITIONAL pre-CRDT content save (EDITOR+). Applies only when the
   * caller's expected content version still matches the stored version;
   * stale writers get a typed conflict instead of silently overwriting.
   * Content saves are deliberately NOT audited (per-keystroke volume).
   */
  async saveDocumentContent(
    actor: ActorContext,
    documentId: unknown,
    input: { content: unknown; expectedContentVersion: unknown },
  ): Promise<{ contentVersion: number }> {
    const id = parseDocumentId(documentId);
    await requireAccess(actor, id, "editContent");

    const expectedContentVersion = z
      .number()
      .int()
      .min(1)
      .safeParse(input.expectedContentVersion);
    if (!expectedContentVersion.success) {
      throw new ValidationError("Invalid expectedContentVersion");
    }

    if (
      input.content === null ||
      typeof input.content !== "object" ||
      Array.isArray(input.content) ||
      !("doc" in input.content)
    ) {
      throw new ValidationError("Content must be an object envelope");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(input.content);
    } catch {
      throw new ValidationError("Content is not JSON-serializable");
    }
    if (serialized.length > MAX_CONTENT_JSON_BYTES) {
      throw new ValidationError("Content is too large");
    }

    const updated = await documentsRepository.updateContentConditional(
      id,
      expectedContentVersion.data,
      input.content,
    );
    if (!updated) {
      const existing = await documentsRepository.findById(id);
      if (!existing) {
        throw new NotFoundError("Document not found");
      }
      throw new ConflictError("Document was modified concurrently");
    }

    return { contentVersion: updated.contentVersion };
  },

  /**
   * Test/ops helper: authoritative existence check (unmasked). Not used by
   * client-facing paths.
   */
  async exists(documentId: string): Promise<boolean> {
    const document = await documentsRepository.findById(documentId);
    return document !== null;
  },
};
