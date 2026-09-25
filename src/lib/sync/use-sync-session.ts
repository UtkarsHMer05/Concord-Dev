"use client";

/**
 * Sync session React wiring (D16 — Phase 7 product wiring).
 *
 * Owns the REAL collaboration session for one open document:
 *
 *   SyncSession(WorkerEnginePort → REAL CRDT worker) ⇄ Rust sync gateway
 *   over WebSocket, authenticated with the Clerk session JWT
 *   (useAuth().getToken — the gateway fetches Clerk's JWKS from
 *   {issuer}/.well-known/jwks.json, VerifierSource::Http).
 *
 * Truthful local-first degradation: when NEXT_PUBLIC_SYNC_GATEWAY_URL is
 * unset (or workers are unavailable), the session stays local-only — the
 * CRDT replica keeps working offline (that is the architecture, not a
 * failure) and no connection status is implied.
 *
 * Cursor persistence: localStorage `concord.sync.{documentId}.cursor`
 * ("0" when unknown) — same per-browser+document namespacing family as the
 * bridge's `concord.replica.{documentId}` key.
 */

import { useCallback, useEffect, useRef } from "react";
import { useAuth } from "@clerk/nextjs";

import { useSyncStatusStore } from "@/store/use-sync-status-store";
import { useBridgeStatusStore } from "@/store/use-bridge-status-store";
import { usePresenceStore } from "@/lib/presence/use-presence-store";
import type { CrdtClient } from "@/lib/crdt/worker/client";
import type { CrdtEditorBridge } from "@/lib/crdt/editor-bridge";
import { hasReplicaData } from "@/lib/crdt/worker/idb";
import { SyncSession } from "@/lib/sync/sync-session";
import type { PresenceState } from "@/lib/sync/protocol";
import { WorkerEnginePort } from "@/lib/sync/worker-engine-port";
import type { CatchupBriefing } from "@/lib/sync/catchup-briefing";

/** Browser-side gateway WS endpoint (unset ⇒ local-only mode). */
export function syncGatewayUrl(): string | null {
    const url = process.env.NEXT_PUBLIC_SYNC_GATEWAY_URL;
    if (typeof url !== "string" || url.trim() === "") {
        return null;
    }
    return url.trim();
}

const CURSOR_KEY_PREFIX = "concord.sync.";
const CURSOR_KEY_SUFFIX = ".cursor";

function cursorKey(documentId: string, userId?: string | null): string {
    const scope = userId ? `${encodeURIComponent(userId)}.` : "";
    return `${CURSOR_KEY_PREFIX}${scope}${documentId}${CURSOR_KEY_SUFFIX}`;
}

function readCursor(documentId: string, userId?: string | null): string {
    try {
        const stored = window.localStorage.getItem(cursorKey(documentId, userId));
        if (stored !== null && /^(?:0|[1-9][0-9]*)$/.test(stored)) {
            return stored;
        }
    } catch {
        // localStorage unavailable: the session runs from cursor "0".
    }
    return "0";
}

function writeCursor(documentId: string, cursor: string, userId?: string | null): void {
    try {
        window.localStorage.setItem(cursorKey(documentId, userId), cursor);
    } catch {
        // Best-effort persistence; the in-memory cursor still advances.
    }
}

export interface UseSyncSessionParams {
    documentId: string;
    /** The REAL worker client; null on the server / no Worker support. */
    crdtClient: CrdtClient | null;
    /** The editor bridge (remote re-render hook). */
    bridge: CrdtEditorBridge | null;
    /** Count-only durable catch-up summary for a reconnect briefing UI. */
    onCatchupBriefing?: (briefing: CatchupBriefing) => void;
}

/**
 * Starts the realtime session once the bridge is on the CRDT path and the
 * worker client is live. Disposes cleanly on unmount; never starts for
 * fallback sessions (unsupported content is NOT collaboratively editable —
 * the Phase 1 mirror owns it instead).
 */
export function useSyncSession({ documentId, crdtClient, bridge, onCatchupBriefing }: UseSyncSessionParams): {
    syncNow: () => void;
    sendPresence: (state: PresenceState) => void;
} {
    const { getToken, isLoaded, isSignedIn, userId } = useAuth();
    const catchupBriefingCallback = useRef(onCatchupBriefing);
    useEffect(() => {
        catchupBriefingCallback.current = onCatchupBriefing;
    }, [onCatchupBriefing]);
    const setSyncStatus = useSyncStatusStore((s) => s.setStatus);
    const setSyncError = useSyncStatusStore((s) => s.setError);
    const setCompatibilityWarning = useSyncStatusStore((s) => s.setCompatibilityWarning);
    const setLocalOnly = useSyncStatusStore((s) => s.setLocalOnly);
    const setOutbox = useSyncStatusStore((s) => s.setOutbox);
    const clearSyncStatus = useSyncStatusStore((s) => s.clear);
    const bridgeMode = useBridgeStatusStore((s) => s.state.mode);
    const applyPresence = usePresenceStore((s) => s.applyUpdate);
    const removePresence = usePresenceStore((s) => s.removePeer);
    const clearPresence = usePresenceStore((s) => s.clear);
    const sessionRef = useRef<SyncSession | null>(null);
    const syncNow = useCallback(() => {
        sessionRef.current?.syncNow();
    }, []);
    const sendPresence = useCallback((state: PresenceState) => {
        sessionRef.current?.sendPresence(state);
    }, []);

    useEffect(() => {
        const gatewayUrl = syncGatewayUrl();
        if (!isLoaded) {
            clearSyncStatus();
            return;
        }
        clearSyncStatus();
        if (!isSignedIn || !userId) {
            setLocalOnly(bridgeMode === "crdt");
            return;
        }
        let cancelled = false;
        let session: SyncSession | null = null;
        let store: import("./pending-store").PendingOpStore | null = null;

        void (async () => {
            const { PendingOpStore } = await import("./pending-store");
            const [legacyWorkerData, legacyOutboxData] = await Promise.all([
                hasReplicaData(documentId),
                PendingOpStore.hasLegacyUnacked(documentId),
            ]);
            if (cancelled) return;
            setCompatibilityWarning(legacyWorkerData || legacyOutboxData
                ? "Legacy local cache found: it may contain offline edits, but its owner and sync status cannot be verified. It was preserved and not loaded into this account. Keep this browser's site data until manual recovery or export is complete."
                : null);
            // Local-only or fallback paths still warn about retained legacy
            // data, but never start a transport or read it into this account.
            if (!gatewayUrl || !crdtClient || bridgeMode !== "crdt" || !bridge || typeof getToken !== "function") {
                setLocalOnly(bridgeMode === "crdt");
                return;
            }
            setLocalOnly(false);
            const opened = await PendingOpStore.open(documentId, userId);
            if (cancelled) {
                opened.close();
                return;
            }
            store = opened;
            // The bridge re-renders the editor from the worker's converged
            // state after remote ops integrate (emitUpdate=false — M038).
            const engine = new WorkerEnginePort({
                client: crdtClient,
                store: opened,
                onRemoteApplied: () => {
                    void bridge.renderRemote();
                },
            });
            session = new SyncSession({
                documentId,
                gatewayUrl,
                // Clerk may return null (session expiring): reject so the
                // transport surfaces a token-retrieval failure and retries
                // the handshake instead of sending a null token.
                getToken: async () => {
                    const token = await getToken();
                    if (token === null) {
                        throw new Error("Clerk session token unavailable");
                    }
                    return token;
                },
                engine,
                getCursor: () => readCursor(documentId, userId),
                setCursor: (cursor) => writeCursor(documentId, cursor, userId),
                store: opened,
                onStatus: (status) => setSyncStatus(status),
                onError: (code, message) => setSyncError(`${code}: ${message}`),
                onLocalError: (message) => setSyncError(`Local sync storage failed: ${message}`),
                onOutboxState: (state) => setOutbox(state),
                onCatchupBriefing: (briefing) => catchupBriefingCallback.current?.(briefing),
                onPresenceUpdate: (peer) => applyPresence(peer),
                onPresenceLeave: (connectionId) => removePresence(connectionId),
            });
            sessionRef.current = session;
            // Unmount raced the async store open: stop immediately — a
            // session must never outlive its page.
            if (cancelled) {
                await session.stop();
                if (sessionRef.current === session) sessionRef.current = null;
                store?.close();
                return;
            }
            await session.start();
        })().catch((error: unknown) => {
            console.error("[sync] session failed to start:", error);
            setSyncError(`Local sync could not start: ${error instanceof Error ? error.message : String(error)}`);
        });

        return () => {
            cancelled = true;
            void session?.stop();
            if (sessionRef.current === session) sessionRef.current = null;
            store?.close();
            clearSyncStatus();
            clearPresence();
        };
        // getToken identity is stable from Clerk; the rest are per-mount.
        // bridgeMode re-runs the effect on bridge mode transitions.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [documentId, crdtClient, bridge, bridgeMode, isLoaded, isSignedIn, userId, setSyncStatus, setSyncError, setCompatibilityWarning, setLocalOnly, setOutbox, clearSyncStatus, applyPresence, removePresence, clearPresence]);
    return { syncNow, sendPresence };
}
