"use client";

/**
 * Gateway sync status store (Phase 7, D16).
 *
 * Holds the LIVE SyncSession ConnectionStatus so the document UI renders
 * the honest connection state (connection-status.ts presentation mapping).
 * Written by the sync session wiring (use-sync-session.ts); read by the
 * connection indicator. `null` = local-only mode (no gateway configured) —
 * deliberately distinct from "disconnected" so the UI never implies a
 * connection attempt that isn't happening.
 */

import { create } from "zustand";
import type { ConnectionStatus } from "@/lib/sync/transport";

interface SyncStatusState {
    status: ConnectionStatus | null;
    setStatus: (status: ConnectionStatus) => void;
    clear: () => void;
}

export const useSyncStatusStore = create<SyncStatusState>((set) => ({
    status: null,
    setStatus: (status) => set({ status }),
    clear: () => set({ status: null }),
}));
