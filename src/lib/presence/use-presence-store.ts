"use client";

/**
 * Live presence store (Feature 2 — CRDT-anchored cursors).
 *
 * Holds the ephemeral cursor/selection of every OTHER connection in the
 * current document room. Peers are keyed by the gateway-assigned
 * connection id (unforgeable, unique per session/tab). Positions are stored
 * as CRDT item-id anchors — NOT PM offsets — so a peer caret stays glued to
 * the right character while everyone edits; the overlay resolves them against
 * the live stream each frame.
 *
 * Presence is best-effort and non-durable: a peer that goes silent is expired
 * by a client-side TTL (`sweep`), and a clean disconnect removes it via a
 * gateway `presence_leave`. Written by the sync wiring; read by the overlay.
 */

import { create } from "zustand";

import type { CrdtAnchorPoint } from "@/lib/comments/anchors";
import type { PresenceUpdate } from "@/lib/sync/protocol";

/** How long a peer survives without a fresh update before it is expired. */
export const PRESENCE_TTL_MS = 30_000;

export interface PeerPresence {
  connectionId: string;
  userId: string;
  replicaId: string;
  anchor: CrdtAnchorPoint | null;
  head: CrdtAnchorPoint | null;
  updatedAtMs: number;
}

interface PresenceState {
  peers: Record<string, PeerPresence>;
  applyUpdate: (update: PresenceUpdate, nowMs?: number) => void;
  removePeer: (connectionId: string) => void;
  sweep: (nowMs?: number, ttlMs?: number) => void;
  clear: () => void;
}

function pointOf(item: string | undefined, side: "before" | "after"): CrdtAnchorPoint | null {
  return item ? { itemId: item, side } : null;
}

export const usePresenceStore = create<PresenceState>((set) => ({
  peers: {},
  applyUpdate: (update, nowMs = Date.now()) =>
    set((state) => ({
      peers: {
        ...state.peers,
        [update.connectionId]: {
          connectionId: update.connectionId,
          userId: update.userId,
          replicaId: update.replicaId,
          anchor: pointOf(update.anchorItem, update.anchorSide),
          head: pointOf(update.headItem, update.headSide),
          updatedAtMs: nowMs,
        },
      },
    })),
  removePeer: (connectionId) =>
    set((state) => {
      if (!(connectionId in state.peers)) return state;
      const peers = { ...state.peers };
      delete peers[connectionId];
      return { peers };
    }),
  sweep: (nowMs = Date.now(), ttlMs = PRESENCE_TTL_MS) =>
    set((state) => {
      const entries = Object.entries(state.peers).filter(
        ([, peer]) => nowMs - peer.updatedAtMs < ttlMs,
      );
      if (entries.length === Object.keys(state.peers).length) return state;
      return { peers: Object.fromEntries(entries) };
    }),
  clear: () => set({ peers: {} }),
}));

/** Deterministic, readable caret color from a stable per-peer key. */
export function peerColor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  // Fixed saturation/lightness keep every caret legible on a white page.
  return `hsl(${hash % 360} 70% 45%)`;
}
