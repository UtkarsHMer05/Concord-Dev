"use client";

/**
 * Collaborative-mode indicator (Phase 7, M008).
 *
 * Truthfully shows which durability path the session is on:
 * - CRDT mode: local-first replica (works offline; converges when the
 *   realtime sync layer ships its product wiring);
 * - Fallback mode: content outside the collaborative subset (tables,
 *   images, lists, colors…) switched this session to the whole-document
 *   save path. This is a LOUD, honest signal — required by M041 and the
 *   v1 boundary doc (docs/PRD.md §25a.C.1).
 *
 * It never claims "connected/collaborating" — the shipped v1 surface runs
 * the local replica + transitional mirror (PRD §25a.B.1), so the honest
 * labels are about the LOCAL save path, not a server connection.
 */

import { useBridgeStatusStore } from "@/store/use-bridge-status-store";

export const CollaborativeModeIndicator = () => {
  const { state } = useBridgeStatusStore();

  if (state.mode === "idle") {
    return null;
  }

  if (state.mode === "crdt") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        role="status"
        title="Changes are saved to a durable local replica first. This document stays within the collaborative content model (text, headings, basic formatting)."
      >
        <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
        <span className="hidden sm:inline">Collaborative format</span>
        <span className="sr-only">
          This document is within the collaborative content model. Changes are
          saved to a durable local replica first.
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
