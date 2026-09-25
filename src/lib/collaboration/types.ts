/**
 * Concord collaboration contracts at the current product boundary.
 *
 * These types define the seam between the React product layer and the future
 * Concord-owned collaboration stack. UI components must depend on this
 * interface, never on a specific vendor or on future implementation
 * technologies.
 *
 * Collaboration capabilities report what the page actually wires. History and
 * comments use authenticated services; realtime and presence remain separate
 * capability states and must never be faked.
 */

export type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

export interface DocumentContentSession {
  /** Transitional persistence state for the editor content. */
  status: SaveStatus;
  saveError: string | null;
  /**
   * True when the server rejected a stale write (another tab saved newer
   * content). Autosave is paused; the document must be reloaded.
   */
  hasConflict: boolean;
  /** Schedule a (debounced) durable save of the document content. */
  saveContent: (json: unknown) => void;
  /** Flush any pending save immediately (used on navigation/unmount). */
  flush: () => Promise<void>;
}

export interface DocumentSettingsSession {
  leftMargin: number;
  rightMargin: number;
  setLeftMargin: (px: number) => void;
  setRightMargin: (px: number) => void;
}

export interface DocumentSession {
  documentId: string;
  /** Whether the verified effective role may write content (OWNER/EDITOR). */
  canEditContent: boolean;
  content: DocumentContentSession;
  settings: DocumentSettingsSession;
  /** Realtime collaboration with other clients. Unavailable until Phase 2–3. */
  realtime: { state: "unavailable" };
  /** Remote collaborator presence. Unavailable until Phase 2–3. */
  presence: { state: "unavailable" };
  /** CRDT-anchored comments with account-scoped offline retry. */
  threads: { state: "available" } | { state: "unavailable" };
  /** Comment/thread notifications. Unavailable until Phase 2–3. */
  inbox: { state: "unavailable" };
}
