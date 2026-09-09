"use client";

/**
 * Collaborative-mode indicator (Phase 7, M008 + D16 realtime wiring).
 *
 * Truthfully shows which durability path the session is on, and — when the
 * CRDT path is live — whether the realtime sync session is actually
 * connected to the gateway:
 * - CRDT + connected: realtime multi-user collaboration is live;
 * - CRDT + offline/reconnecting: local-first replica; edits are kept and
 *   will sync (never claims "connected" without a live session);
 * - CRDT + no gateway configured: local-only replica (no session attempt);
 * - Fallback mode: content outside the collaborative subset (tables,
 *   images, lists, colors…) switched this session to the whole-document
 *   save path. A LOUD, honest signal — M041 and docs/PRD.md §25a.C.1.
 */

import { useBridgeStatusStore } from "@/store/use-bridge-status-store";
import { useSyncStatusStore } from "@/store/use-sync-status-store";
import { toConnectionStatusView } from "@/lib/collaboration/connection-status";

export const CollaborativeModeIndicator = () => {
  const { state } = useBridgeStatusStore();
  const syncStatus = useSyncStatusStore((s) => s.status);

  if (state.mode === "idle") {
    return null;
  }

  if (state.mode === "crdt") {
    // syncStatus null ⇒ no gateway configured / session not started:
    // local-only replica, no connection claim (truthful local-first).
    const view = syncStatus === null ? null : toConnectionStatusView(syncStatus);
    const connected = syncStatus === "ready";
    const dot = view
      ? view.level === "ok"
        ? "bg-emerald-500"
        : view.level === "pending"
          ? "bg-sky-500 animate-pulse"
          : view.level === "warn"
            ? "bg-amber-500"
            : "bg-muted-foreground"
      : "bg-emerald-500";
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        role="status"
        title={
          view
            ? `${view.description} (Changes are saved to a durable local replica first and synced through the realtime session.)`
            : "Changes are saved to a durable local replica first. This document stays within the collaborative content model (text, headings, basic formatting). Realtime sync is not configured, so edits stay on this device until it is."
        }
      >
        <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
        <span className="hidden sm:inline">
          {view ? `Collaborative · ${view.label}` : "Collaborative format"}
        </span>
        <span className="sr-only">
          {view
            ? `This document is within the collaborative content model and the realtime session is ${connected ? "connected" : view.label.toLowerCase()}. ${view.description}`
            : "This document is within the collaborative content model. Changes are saved to a durable local replica first. Realtime sync is not configured."}
        </span>
      </span>
    );
  }

  // mode === "fallback"
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-amber-700"
      role="status"
      title="This document contains content (for example tables, images, lists, or colors) that is not part of the collaborative model yet. It is saved as a whole document instead of collaborative changes, and multi-user realtime editing is not available for it."
    >
      <span className="size-1.5 rounded-full bg-amber-600" aria-hidden="true" />
      <span className="hidden sm:inline">Saved as full document</span>
      <span className="sr-only">
        This document contains content outside the collaborative model, such as
        tables, images, lists, or colors. It is saved as a whole document
        instead of collaborative changes.
      </span>
    </span>
  );
};
