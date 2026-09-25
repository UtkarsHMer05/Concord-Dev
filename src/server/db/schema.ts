import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Concord Phase 1 relational schema.
 *
 * Semantics are documented in docs/DATABASE.md; authorization semantics in
 * docs/AUTHORIZATION.md. Key points:
 *
 * - `documents.content` is TRANSITIONAL pre-CRDT persistence (versioned
 *   TipTap envelope as JSONB) — replaced by the update log in Phase 2.
 * - `document_user_permissions.role` deliberately excludes OWNER; ownership
 *   is intrinsic to `documents.owner_user_id`.
 * - `audit_events.resource_id` has no foreign key so audit history survives
 *   resource deletion.
 */

export const documentRoleEnum = pgEnum("document_role", [
  "EDITOR",
  "COMMENTER",
  "VIEWER",
]);

export const organizationMemberRoleEnum = pgEnum("organization_member_role", [
  "admin",
  "member",
]);

export const commentThreadStatusEnum = pgEnum("comment_thread_status", [
  "open",
  "resolved",
]);

/**
 * Suggestion lifecycle (Feature 4, anchor sidecar): proposed → accepted
 * (applied as durable CRDT edits) / rejected / discharged (anchor orphaned
 * by later edits — the honest terminal state, same rules as comments).
 */
export const suggestionStatusEnum = pgEnum("suggestion_status", [
  "proposed",
  "accepted",
  "rejected",
  "discharged",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: text("clerk_user_id").notNull(),
  displayName: text("display_name"),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  uniqueIndex("users_clerk_user_id_uq").on(t.clerkUserId),
]);

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkOrganizationId: text("clerk_organization_id").notNull(),
  name: text("name"),
  slug: text("slug"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  uniqueIndex("organizations_clerk_organization_id_uq").on(
    t.clerkOrganizationId,
  ),
]);

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: organizationMemberRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("organization_memberships_org_user_uq").on(
      t.organizationId,
      t.userId,
    ),
    index("organization_memberships_user_idx").on(t.userId),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    organizationId: uuid("organization_id").references(() => organizations.id),
    initialContent: text("initial_content"),
    content: jsonb("content"),
    contentVersion: integer("content_version").notNull().default(1),
    metadataVersion: integer("metadata_version").notNull().default(1),
    legacyConvexId: text("legacy_convex_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("documents_owner_updated_idx").on(t.ownerUserId, t.updatedAt.desc()),
    index("documents_org_updated_idx").on(
      t.organizationId,
      t.updatedAt.desc(),
    ),
    uniqueIndex("documents_legacy_convex_id_uq").on(t.legacyConvexId),
    check(
      "documents_title_length_check",
      sql`char_length(${t.title}) BETWEEN 1 AND 200`,
    ),
    check(
      "documents_content_version_check",
      sql`${t.contentVersion} >= 1`,
    ),
    check(
      "documents_metadata_version_check",
      sql`${t.metadataVersion} >= 1`,
    ),
  ],
);

export const documentUserPermissions = pgTable(
  "document_user_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: documentRoleEnum("role").notNull(),
    grantedByUserId: uuid("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("document_user_permissions_doc_user_uq").on(
      t.documentId,
      t.userId,
    ),
    index("document_user_permissions_user_idx").on(t.userId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    // Deletion-safe resource reference: deliberately NO foreign key so audit
    // history survives deletion of the referenced resource.
    resourceId: text("resource_id").notNull(),
    organizationId: uuid("organization_id").references(
      () => organizations.id,
      { onDelete: "set null" },
    ),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("audit_events_created_idx").on(t.createdAt.desc()),
    index("audit_events_resource_idx").on(t.resourceId),
    index("audit_events_actor_idx").on(t.actorUserId),
  ],
);

/** Comment anchors use stable CRDT item IDs, never editor offsets. */
export const commentThreads = pgTable(
  "document_comment_threads",
  {
    id: uuid("id").primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    startItemId: text("start_item_id").notNull(),
    startSide: text("start_side").notNull(),
    endItemId: text("end_item_id").notNull(),
    endSide: text("end_side").notNull(),
    quotedText: text("quoted_text").notNull(),
    status: commentThreadStatusEnum("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("document_comment_threads_document_created_idx").on(
      t.documentId,
      t.createdAt,
    ),
    check("document_comment_threads_start_side_check", sql`${t.startSide} IN ('before', 'after')`),
    check("document_comment_threads_end_side_check", sql`${t.endSide} IN ('before', 'after')`),
    check("document_comment_threads_quote_length_check", sql`char_length(${t.quotedText}) <= 1000`),
  ],
);

/** Separate rows make offline reply retries idempotent and append-only. */
export const commentMessages = pgTable(
  "document_comment_messages",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => commentThreads.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("document_comment_messages_thread_created_idx").on(t.threadId, t.createdAt),
    check("document_comment_messages_body_length_check", sql`char_length(${t.body}) BETWEEN 1 AND 4000`),
  ],
);

export const documentSuggestions = pgTable(
  "document_suggestions",
  {
    id: uuid("id").primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => users.id),
    // CRDT item-id range anchor — identical model to comment threads, so
    // resolveAnchors attaches/orphans suggestions with the same honesty.
    startItemId: text("start_item_id").notNull(),
    startSide: text("start_side").notNull(),
    endItemId: text("end_item_id").notNull(),
    endSide: text("end_side").notNull(),
    quotedText: text("quoted_text").notNull(),
    proposedText: text("proposed_text").notNull(),
    status: suggestionStatusEnum("status").notNull().default("proposed"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("document_suggestions_document_created_idx").on(t.documentId, t.createdAt),
    check("document_suggestions_start_side_check", sql`${t.startSide} IN ('before', 'after')`),
    check("document_suggestions_end_side_check", sql`${t.endSide} IN ('before', 'after')`),
    check("document_suggestions_quote_length_check", sql`char_length(${t.quotedText}) <= 1000`),
    check("document_suggestions_proposed_length_check", sql`char_length(${t.proposedText}) <= 4000`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type OrganizationRow = typeof organizations.$inferSelect;
export type OrganizationMembershipRow =
  typeof organizationMemberships.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type DocumentUserPermissionRow =
  typeof documentUserPermissions.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type CommentThreadRow = typeof commentThreads.$inferSelect;
export type CommentMessageRow = typeof commentMessages.$inferSelect;
export type DocumentSuggestionRow = typeof documentSuggestions.$inferSelect;
export type DocumentRole = (typeof documentRoleEnum.enumValues)[number];
export type OrganizationMemberRole =
  (typeof organizationMemberRoleEnum.enumValues)[number];
