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
 *   images, blockquotes, code blocks…) switched this session to the whole-document
 *   save path. A LOUD, honest signal — M041 and docs/PRD.md §25a.C.1.
 */

import { useBridgeStatusStore } from "@/store/use-bridge-status-store";
import { useSyncStatusStore } from "@/store/use-sync-status-store";
import { toConnectionStatusView } from "@/lib/collaboration/connection-status";

export const CollaborativeModeIndicator = () => {
  const { state } = useBridgeStatusStore();
  const syncStatus = useSyncStatusStore((s) => s.status);
  const syncError = useSyncStatusStore((s) => s.error);
  const compatibilityWarning = useSyncStatusStore((s) => s.compatibilityWarning);
  const attention = compatibilityWarning ?? syncError;

  if (state.mode === "idle") {
    return null;
  }

  const upgrade = state.mode === "blocked" ? state.reason : syncError?.includes("rich-text-v2") ? syncError : null;
  if (upgrade) {
    return <span role="alert" className="inline-flex flex-wrap items-center gap-2 text-xs text-rose-700" title={upgrade}>
      <span>Update required. Offline edits are preserved.</span>
      <button className="underline underline-offset-2 focus-visible:outline-2" onClick={() => window.location.reload()}>Reload Concord</button>
      <span className="sr-only">{upgrade}</span>
    </span>;
  }

  if (state.mode === "crdt") {
    // syncStatus null ⇒ no gateway configured / session not started:
    // local-only replica, no connection claim (truthful local-first).
    const view = syncStatus === null ? null : toConnectionStatusView(syncStatus);
    const connected = syncStatus === "ready";
    const dot = attention ? "bg-rose-600" : view
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
          ? `${attention ?? view.description} (Changes are saved to a durable local replica first.)`
            : "Changes are saved to a durable local replica first. Text, headings, nested lists, tasks, links, code, and formatting collaborate. Realtime sync is not configured, so edits stay on this device until it is."
        }
      >
        <span className={`size-1.5 rounded-full ${dot}`} aria-hidden="true" />
        <span className="hidden sm:inline">
          {compatibilityWarning ? "Local data needs attention" : syncError ? "Sync error" : view ? `Collaborative · ${view.label}` : "Collaborative format"}
        </span>
        <span className="sr-only">
          {attention ? `${compatibilityWarning ? "Local data warning" : "Sync error"}: ${attention}.` : view
            ? `This document is within the collaborative content model and the realtime session is ${connected ? "connected" : view.label.toLowerCase()}. ${view.description}`
            : "This document is within the collaborative content model. Changes are saved to a durable local replica first. Realtime sync is not configured."}
        </span>
      </span>
    );
  }

  // mode === "fallback"
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${attention ? "text-rose-700" : "text-amber-700"}`}
      role="status"
      title={`${attention ? `${attention} ` : ""}This document contains unsupported content (for example tables, images, or code blocks). It is saved as a whole document instead of collaborative changes, and multi-user realtime editing is not available for it. ${state.mode === "fallback" ? state.reason : ""}`}
    >
      <span className={`size-1.5 rounded-full ${attention ? "bg-rose-600" : "bg-amber-600"}`} aria-hidden="true" />
      <span className="hidden sm:inline">
        {compatibilityWarning ? "Local data needs attention" : syncError ? "Sync error" : "Full document mode"}
      </span>
      <span className="sr-only">
        {attention ? `${compatibilityWarning ? "Local data warning" : "Sync error"}: ${attention}. ` : ""}
        This document contains content outside the collaborative model, such as
        tables, images, or code blocks. It is saved as a whole document
        instead of collaborative changes; save status is shown separately.
      </span>
    </span>
  );
};
