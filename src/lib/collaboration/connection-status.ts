/**
 * Gateway connection status presentation mapping (Phase 7, M008).
 *
 * Maps the SyncTransport/SyncSession ConnectionStatus vocabulary
 * (src/lib/sync/transport.ts) to honest user-facing language. PURE module —
 * no runtime coupling to the sync layer, so the UI can adopt it the moment
 * the editor→gateway wiring ships (PRD §25a.B.1) without any sync changes.
 *
 * Durability contract (docs/FAILURE_MODEL.md §1):
 * - "connected/ready" describes the sync channel ONLY; it never implies
 *   peers have applied ops;
 * - reconnecting/offline states must say edits are kept and will sync;
 * - only durable-acknowledged work may ever read as "synced".
 */

import type { ConnectionStatus } from "@/lib/sync/transport";

export type ConnectionViewLevel = "ok" | "pending" | "warn" | "off";

export interface ConnectionStatusView {
  /** Short label. */
  label: string;
  /** Full sentence for tooltips / screen readers. */
  description: string;
  level: ConnectionViewLevel;
  /** Whether the state should attract attention (banner) vs stay quiet. */
  prominent: boolean;
}

const VIEWS: Record<ConnectionStatus, ConnectionStatusView> = {
  disconnected: {
    label: "Not connected",
    description:
      "Not connected to the sync service. Edits are saved locally and will sync when connected.",
    level: "off",
    prominent: false,
  },
  connecting: {
    label: "Connecting…",
    description: "Connecting to the sync service.",
    level: "pending",
    prominent: false,
  },
  authenticated: {
    label: "Connecting…",
    description: "Signed in to the sync service; joining the document.",
    level: "pending",
    prominent: false,
  },
  joining: {
    label: "Connecting…",
    description: "Joining the document.",
    level: "pending",
    prominent: false,
  },
  syncing: {
    label: "Syncing…",
    description: "Catching up on changes from other sessions.",
    level: "pending",
    prominent: false,
  },
  ready: {
    label: "Connected",
    description: "Connected — edits sync to other sessions as you type.",
    level: "ok",
    prominent: false,
  },
  reconnecting: {
    label: "Reconnecting…",
    description:
      "Connection lost. Your edits are saved locally and will sync automatically.",
    level: "warn",
    prominent: true,
  },
  draining: {
    label: "Server restarting",
    description:
      "The sync service is restarting. Your edits are saved locally and will sync when it is back.",
    level: "warn",
    prominent: true,
  },
  closed: {
    label: "Not connected",
    description:
      "The sync connection is closed. Edits are saved locally and will sync when reconnected.",
    level: "off",
    prominent: false,
  },
};

export function toConnectionStatusView(status: ConnectionStatus): ConnectionStatusView {
  return VIEWS[status];
}
