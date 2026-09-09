/**
 * Editor save/sync status presentation model (Phase 7, M007/M008).
 *
 * Pure mapping from the session layer's signals to honest, user-facing
 * status. This module OWNS the truthfulness rules from
 * docs/FAILURE_MODEL.md §1 for the UI:
 *
 * - "saved locally" is always honest for local-first content (the CRDT
 *   replica + IndexedDB oplog are written before/independently of any
 *   network ack);
 * - nothing may be presented as "saved to server/cloud" before the
 *   durable-ack point (ACK_DURABLE). In the v1 product surface the durable
 *   ack path is the transitional content-mirror POST — a 2xx response is
 *   the mirror-saved point;
 * - offline/reconnecting states describe connectivity, not data loss:
 *   edits keep accumulating safely.
 *
 * The mapping is pure so it is unit-testable without React (tests/unit).
 */

import type { SaveStatus } from "@/lib/collaboration/types";

/** Presentation states for the editor document session. */
export type EditorSaveState =
  | "saved-locally"
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
 * Precedence: conflict > offline > error > saving > saved-mirror > saved-locally.
 * Offline/error never downgrade the local-first guarantee in the copy.
 */
export function toSaveStatusView(
  status: SaveStatus,
  online: boolean,
): SaveStatusView {
  let state: EditorSaveState;
  if (status === "conflict") {
    state = "conflict";
  } else if (!online) {
    state = "offline";
  } else if (status === "error") {
    state = "error";
  } else if (status === "saving") {
    state = "saving";
  } else if (status === "idle") {
    // idle + online = the mirror is up to date (no pending save).
    state = "saved-mirror";
  } else {
    state = "saved-mirror";
  }
  return { state, ...VIEWS[state] };
}
