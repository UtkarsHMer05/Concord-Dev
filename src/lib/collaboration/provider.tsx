"use client";

/**
 * TRANSITIONAL document session provider (Phase 0).
 *
 * Replaces the realtime room provider while Concord's own collaboration stack
 * is being built. It owns:
 * - durable content persistence for the editor (transitional Convex-backed
 *   whole-document saves, debounced);
 * - per-document layout settings (transitional localStorage-backed margins);
 * - honest "unavailable" capability states for realtime, presence, threads,
 *   and inbox.
 *
 * This is explicitly temporary: Phase 2 moves shared document state into the
 * CRDT document model and Phase 3 introduces the realtime transport. Do not
 * let this implementation become the final design.
 */

import { useMutation } from "convex/react";
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

import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import type { DocumentSession, SaveStatus } from "./types";

const SAVE_DEBOUNCE_MS = 500;
const MARGINS_KEY_PREFIX = "concord.doc.";
const MARGINS_KEY_SUFFIX = ".margins";
const LEFT_MARGIN_DEFAULT = 56;
const RIGHT_MARGIN_DEFAULT = 56;

interface DocumentSessionProviderProps {
  documentId: Id<"documents">;
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
  editorContent,
  children,
}: DocumentSessionProviderProps) {
  const updateContent = useMutation(api.documents.updateContent);

  const [status, setStatus] = useState<SaveStatus>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const pendingContentRef = useRef<unknown>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const payload = pendingContentRef.current;
    if (payload === null || payload === undefined) {
      return;
    }
    try {
      await updateContent({
        id: documentId,
        content: JSON.stringify({ v: 1, doc: payload }),
      });
      pendingContentRef.current = null;
      setSaveError(null);
      setStatus((s) => (s === "error" ? "idle" : s));
    } catch (error) {
      setStatus("error");
      setSaveError(error instanceof Error ? error.message : "Save failed");
      toast.error("Failed to save document");
    }
  }, [documentId, updateContent]);

  const saveContent = useCallback(
    (json: unknown) => {
      pendingContentRef.current = json;
      setStatus("saving");
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush().then(() => {
          setStatus((s) => (s === "saving" ? "idle" : s));
        });
      }, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Flush pending saves when navigating away/unmounting (best effort).
  useEffect(() => {
    return () => {
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
      content: { status, saveError, saveContent, flush },
      settings: {
        leftMargin: margins.left,
        rightMargin: margins.right,
        setLeftMargin,
        setRightMargin,
      },
      realtime: { state: "unavailable" },
      presence: { state: "unavailable" },
      threads: { state: "unavailable" },
      inbox: { state: "unavailable" },
    }),
    [
      documentId,
      editorContent,
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
