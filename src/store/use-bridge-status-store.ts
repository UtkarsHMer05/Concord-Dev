"use client";

/**
 * CRDT bridge status store (Phase 7, M008).
 *
 * Holds the editor↔CRDT bridge state so UI can render the honest
 * collaborative-mode indicator:
 * - "idle"      → bridge not started yet (loading);
 * - "crdt"      → session is on the collaborative CRDT path (local-first,
 *                 offline-capable, convergent with other replicas);
 * - "fallback"  → the document contains content outside the collaborative
 *                 subset (tables, images, lists, …) and the session has
 *                 degraded to the whole-document save path — surfaced
 *                 loudly, never silently (M041 honesty rule).
 *
 * Presentation is a Zustand store mirroring useEditorStore's pattern.
 */

import { create } from "zustand";
import type { BridgeState } from "@/lib/crdt/editor-bridge";

interface BridgeStatusState {
  state: BridgeState;
  setState: (state: BridgeState) => void;
}

export const useBridgeStatusStore = create<BridgeStatusState>((set) => ({
  state: { mode: "idle" },
  setState: (state) => set({ state }),
}));
