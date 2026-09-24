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

export interface SyncOutboxStatus {
    pending: number;
    sent: number;
    durablyAcked: number;
    /** True only after the local cursor covers acknowledged operations. */
    serverConfirmed: boolean;
}

interface SyncStatusState {
    status: ConnectionStatus | null;
    error: string | null;
    compatibilityWarning: string | null;
    localOnly: boolean;
    outbox: SyncOutboxStatus | null;
    setStatus: (status: ConnectionStatus) => void;
    setError: (message: string | null) => void;
    setCompatibilityWarning: (message: string | null) => void;
    setLocalOnly: (localOnly: boolean) => void;
    setOutbox: (outbox: SyncOutboxStatus) => void;
    clear: () => void;
}

export const useSyncStatusStore = create<SyncStatusState>((set) => ({
    status: null,
    error: null,
    compatibilityWarning: null,
    localOnly: false,
    outbox: null,
    // A transport reconnect does not prove a failed database or IDB write
    // succeeded. Clear errors only when the session explicitly reports it.
    setStatus: (status) => set({ status }),
    setError: (error) => set({ error }),
    setCompatibilityWarning: (compatibilityWarning) => set({ compatibilityWarning }),
    setLocalOnly: (localOnly) => set((state) => ({
        localOnly,
        outbox: localOnly ? null : state.outbox,
    })),
    setOutbox: (outbox) => set((state) => ({
        outbox,
        localOnly: false,
        error: outbox.serverConfirmed && outbox.pending === 0 && outbox.sent === 0 && outbox.durablyAcked === 0
            ? null
            : state.error,
    })),
    clear: () => set({
        status: null,
        error: null,
        compatibilityWarning: null,
        localOnly: false,
        outbox: null,
    }),
}));
