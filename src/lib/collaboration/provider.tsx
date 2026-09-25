"use client";

/**
 * TRANSITIONAL document session provider (Phase 1).
 *
 * Replaces the realtime room provider while Concord's own collaboration stack
 * is being built. It owns:
 * - durable content persistence for the editor (transitional PostgreSQL-backed
 *   whole-document saves via /api/documents/[id]/content, debounced, with
 *   optimistic concurrency: a stale writer conflicts instead of overwriting);
 * - per-document layout settings (transitional localStorage-backed margins);
 * - explicit capability states: authenticated CRDT-anchored threads are
 *   available, while presence and inbox remain unavailable.
 *
 * This is explicitly temporary: Phase 2 moves shared document state into the
 * CRDT document model and Phase 3 introduces the realtime transport. Do not
 * let this implementation become the final design.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import type { DocumentSession, SaveStatus } from "./types";
import { serializeDocumentContent } from "./content";
import { useBridgeStatusStore } from "@/store/use-bridge-status-store";

const SAVE_DEBOUNCE_MS = 500;
const MARGINS_KEY_PREFIX = "concord.doc.";
const MARGINS_KEY_SUFFIX = ".margins";
const LEFT_MARGIN_DEFAULT = 56;
const RIGHT_MARGIN_DEFAULT = 56;

interface DocumentSessionProviderProps {
  documentId: string;
  /** Content version observed at page load; advanced by each successful save. */
  initialContentVersion: number;
  /** Whether the effective role may write content (OWNER/EDITOR). */
  canEditContent: boolean;
  /** Loaded document content (TipTap JSON or HTML string) for the editor. */
  editorContent: unknown;
  children: ReactNode;
}

interface SessionContextValue extends DocumentSession {
  editorContent: unknown;
}

const DocumentSessionContext = createContext<SessionContextValue | null>(null);

export function DocumentSessionProvider({
  documentId,
  initialContentVersion,
  canEditContent,
  editorContent,
  children,
}: DocumentSessionProviderProps) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const hasConflictRef = useRef(false);

  // Two write paths, mutually exclusive per session (D16): when the editor
  // bridge is on the CRDT path, durability flows through the worker +
  // realtime session (ops → gateway → peers); the whole-document mirror
  // must NOT double-save (it would also 409-conflict with itself on stale
  // contentVersion). Only the fallback path (unsupported content / worker
  // failure) saves here. saveContent reads the bridge mode at call time so
  // a mode transition cannot leave a stale closure.

  const contentVersionRef = useRef(initialContentVersion);
  const pendingContentRef = useRef<unknown>(null);
  const inFlightRef = useRef(false);
  const disposedRef = useRef(false);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // A conflict pauses autosave: further blind retries would either loop or
    // overwrite. Recovery requires a reload (Phase 2 replaces this path).
    if (hasConflictRef.current) {
      return;
    }
    const payload = pendingContentRef.current;
    if (payload === null || payload === undefined) {
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const response = await fetch(`/api/documents/${documentId}/content`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: JSON.parse(serializeDocumentContent(payload)),
          expectedContentVersion: contentVersionRef.current,
        }),
      });
      if (response.ok) {
        const data = (await response.json()) as { contentVersion: number };
        contentVersionRef.current = data.contentVersion;
        if (pendingContentRef.current === payload) {
          pendingContentRef.current = null;
        }
        setSaveError(null);
        setStatus(pendingContentRef.current === null ? "saved" : "saving");
        return;
      }
      if (response.status === 409) {
        hasConflictRef.current = true;
        pendingContentRef.current = null;
        setStatus("conflict");
        setSaveError("This document was modified in another tab.");
        toast.error("Modified in another tab — reload to get the latest version.", {
          duration: Infinity,
          action: {
            label: "Reload",
            onClick: () => window.location.reload(),
          },
        });
        return;
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        hasConflictRef.current = true;
        pendingContentRef.current = null;
        setStatus("error");
        setSaveError("You no longer have permission to edit this document.");
        toast.error("You no longer have permission to edit this document.");
        return;
      }
      // Transient/server error: keep pending content for the timed retry.
      setStatus("error");
      setSaveError("Save failed. Retrying…");
    } catch {
      // Network failure: keep pending content for the next flush attempt.
      setStatus("error");
      setSaveError("Save failed. Retrying…");
    } finally {
      inFlightRef.current = false;
      if (
        !disposedRef.current &&
        pendingContentRef.current !== null &&
        !hasConflictRef.current &&
        timerRef.current === null
      ) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void flushRef.current();
        }, 2_000);
      }
    }
  }, [documentId]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const saveContent = useCallback(
    (json: unknown) => {
      if (!canEditContent || hasConflictRef.current) {
        return;
      }
      // CRDT mode owns durability (worker + sync session); the mirror is
      // the fallback path only — never both (D16 exclusivity).
      if (useBridgeStatusStore.getState().state.mode === "crdt") {
        return;
      }
      pendingContentRef.current = json;
      setStatus((s) => (s === "conflict" ? s : "saving"));
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
    },
    [canEditContent, flush],
  );

  // Prevent a late in-flight response from scheduling retries after unmount.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      if (pendingContentRef.current !== null) {
        void flush();
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [flush]);

  // Transitional margin settings (per-browser localStorage; Phase 2 moves
  // shared settings into the CRDT document model).
  const marginsKey = `${MARGINS_KEY_PREFIX}${documentId}${MARGINS_KEY_SUFFIX}`;
  const [margins, setMargins] = useState(() => ({
    left: LEFT_MARGIN_DEFAULT,
    right: RIGHT_MARGIN_DEFAULT,
  }));

  useEffect(() => {
    let raf: number;
    try {
      const raw = window.localStorage.getItem(marginsKey);
      if (raw) {
        const parsed = JSON.parse(raw) as { left?: number; right?: number };
        raf = requestAnimationFrame(() => {
          setMargins({
            left: typeof parsed.left === "number" ? parsed.left : LEFT_MARGIN_DEFAULT,
            right: typeof parsed.right === "number" ? parsed.right : RIGHT_MARGIN_DEFAULT,
          });
        });
      }
    } catch {
      // Malformed storage falls back to defaults silently.
    }
    return () => {
      if (raf) {
        cancelAnimationFrame(raf);
      }
    };
  }, [marginsKey]);

  const persistMargins = useCallback(
    (next: { left: number; right: number }) => {
      try {
        window.localStorage.setItem(marginsKey, JSON.stringify(next));
      } catch {
        // Storage may be unavailable (private mode); margins stay in memory.
      }
    },
    [marginsKey],
  );

  const setLeftMargin = useCallback(
    (px: number) => {
      setMargins((m) => {
        const next = { ...m, left: px };
        persistMargins(next);
        return next;
      });
    },
    [persistMargins],
  );

  const setRightMargin = useCallback(
    (px: number) => {
      setMargins((m) => {
        const next = { ...m, right: px };
        persistMargins(next);
        return next;
      });
    },
    [persistMargins],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      documentId,
      editorContent,
      canEditContent,
      content: {
        status,
        saveError,
        hasConflict: status === "conflict",
        saveContent,
        flush,
      },
      settings: {
        leftMargin: margins.left,
        rightMargin: margins.right,
        setLeftMargin,
        setRightMargin,
      },
      realtime: { state: "unavailable" },
      presence: { state: "unavailable" },
      threads: { state: "available" },
      inbox: { state: "unavailable" },
    }),
    [
      documentId,
      editorContent,
      canEditContent,
      status,
      saveError,
      saveContent,
      flush,
      margins.left,
      margins.right,
      setLeftMargin,
      setRightMargin,
    ],
  );

  return (
    <DocumentSessionContext.Provider value={value}>
      {children}
    </DocumentSessionContext.Provider>
  );
}

export function useDocumentSession(): SessionContextValue {
  const ctx = useContext(DocumentSessionContext);
  if (!ctx) {
    throw new Error(
      "useDocumentSession must be used within a DocumentSessionProvider",
    );
  }
  return ctx;
}
