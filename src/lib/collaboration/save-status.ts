/**
 * Editor save/sync status presentation model (Phase 7, M007/M008).
 *
 * Pure mapping from the session layer's signals to honest, user-facing
 * status. This module OWNS the truthfulness rules from
 * docs/FAILURE_MODEL.md §1 for the UI:
 *
 * - "saved locally" applies only to the CRDT path, whose replica and
 *   IndexedDB oplog own local durability;
 * - nothing may be presented as "saved to server/cloud" before the
 *   durable-ack point (ACK_DURABLE). In the v1 product surface the durable
 *   ack path is the transitional content-mirror POST — a 2xx response is
 *   the mirror-saved point;
 * - fallback saves that lack a server response say the edits remain only in
 *   this tab; connectivity alone never implies local durability.
 *
 * The mapping is pure so it is unit-testable without React (tests/unit).
 */

import type { SaveStatus } from "@/lib/collaboration/types";
import type { SyncOutboxStatus } from "@/store/use-sync-status-store";

/** Presentation states for the editor document session. */
export type EditorSaveState =
  | "saved-locally"
  | "local-only"
  | "pending-sync"
  | "server-acknowledged"
  | "saving"
  | "saved-mirror"
  | "offline"
  | "error"
  | "conflict";

export interface SaveStatusView {
  state: EditorSaveState;
  /** Short label for the status indicator. */
  label: string;
  /** Full sentence for tooltips / screen readers. */
  description: string;
  /** Tailwind classes for the indicator chip. */
  className: string;
  /** True when the state warrants user attention (not the quiet defaults). */
  prominent: boolean;
}

const VIEWS: Record<EditorSaveState, Omit<SaveStatusView, "state">> = {
  "saved-locally": {
    label: "Saved on this device",
    description:
      "Edits are saved locally on this device and will sync when a connection is available.",
    className: "text-muted-foreground",
    prominent: false,
  },
  "local-only": {
    label: "Local only",
    description:
      "Edits are saved to this device's durable replica. No sync session is active, so they are not being copied to the server.",
    className: "text-amber-700",
    prominent: true,
  },
  "pending-sync": {
    label: "Pending sync",
    description:
      "Edits are saved to this device's durable replica and are waiting for a durable server acknowledgement.",
    className: "text-amber-700",
    prominent: true,
  },
  "server-acknowledged": {
    label: "Acknowledged by server",
    description:
      "The server has durably acknowledged the local edits, or a completed catch-up confirmed the local cursor covers them.",
    className: "text-muted-foreground",
    prominent: false,
  },
  saving: {
    label: "Saving…",
    description: "Saving your changes to the server.",
    className: "text-muted-foreground",
    prominent: false,
  },
  "saved-mirror": {
    label: "Saved",
    description: "All changes are saved on the server.",
    className: "text-muted-foreground",
    prominent: false,
  },
  offline: {
    label: "Offline — edits saved locally",
    description:
      "You are offline. Edits are saved on this device and will sync when you reconnect.",
    // amber-700: 4.99:1 on white (WCAG AA for small text); amber-600 fails (3.19:1).
    className: "text-amber-700",
    prominent: true,
  },
  error: {
    label: "Retrying to save…",
    description:
      "Changes could not reach the server yet. Your edits are safe on this device and saving will retry automatically.",
    className: "text-amber-700",
    prominent: true,
  },
  conflict: {
    label: "Edited in another tab",
    description:
      "This document was changed in another tab or window. Reload to get the latest version.",
    // destructive token is 3.46:1 on white; rose-700 passes AA (6.29:1).
    className: "text-rose-700",
    prominent: true,
  },
};

/**
 * Maps the session's save status + connectivity into a presentation state.
 *
 * Local fallback saves do not claim durability before a server response.
 * Only CRDT sessions can use the local-durable wording.
 */
export function toSaveStatusView(
  status: SaveStatus,
  online: boolean,
  locallyDurable: boolean,
  sync?: {
    localOnly?: boolean;
    outbox?: SyncOutboxStatus | null;
    error?: string | null;
  },
): SaveStatusView {
  if (locallyDurable && status !== "conflict") {
    if (sync?.error) {
      return {
        state: "error",
        label: "Saved locally — sync error",
        description: `The edits are saved to this device's durable replica, but server sync failed: ${sync.error}`,
        className: "text-rose-700",
        prominent: true,
      };
    }
    const pending = (sync?.outbox?.pending ?? 0) + (sync?.outbox?.sent ?? 0);
    if (pending > 0) {
      const edits = `${pending} ${pending === 1 ? "edit is" : "edits are"}`;
      const pronoun = pending === 1 ? "it" : "them";
      const state: EditorSaveState = online ? "pending-sync" : "offline";
      if (state === "offline") {
        return {
          state,
          label: `Offline — ${pending} pending`,
          description: `${edits} saved to this device's durable replica and will sync when the connection returns. The server has not acknowledged ${pronoun} yet.`,
          className: "text-amber-700",
          prominent: true,
        };
      }
      return {
        state,
        ...VIEWS[state],
        label: `Pending sync (${pending})`,
        description: `${edits} saved to this device's durable replica and waiting for a durable server acknowledgement.`,
      };
    }
    if ((sync?.outbox?.durablyAcked ?? 0) > 0 || sync?.outbox?.serverConfirmed) {
      const state: EditorSaveState = "server-acknowledged";
      return { state, ...VIEWS[state] };
    }
    if (sync?.localOnly) {
      const state: EditorSaveState = "local-only";
      return { state, ...VIEWS[state] };
    }
    const state: EditorSaveState = online ? "saved-locally" : "offline";
    return { state, ...VIEWS[state] };
  }

  let state: EditorSaveState;
  if (status === "conflict") {
    state = "conflict";
    if (locallyDurable) return { state, ...VIEWS[state] };
    return {
      state,
      ...VIEWS[state],
      label: "Conflict — unsaved changes",
      description:
        "A newer server version exists. Your changes in this tab have not been saved; copy them before reloading or they will be lost.",
    };
  } else if (status === "error" || (!online && status === "saving")) {
    return {
      state: "error",
      label: online ? "Not saved — retrying" : "Offline — changes not saved",
      description:
        "Your latest changes have not reached the server and are only in this tab. Keep it open and reconnect or retry before closing.",
      className: "text-rose-700",
      prominent: true,
    };
  } else if (status === "saving") {
    state = "saving";
  } else {
    state = "saved-mirror";
  }
  return { state, ...VIEWS[state] };
}
