"use client";

/**
 * Save/sync status indicator (Phase 7, M007/M008).
 *
 * Renders the honest per-document save state. Truthfulness rules:
 * - local-first means "saved locally" is honest BEFORE any server ack;
 * - "Saved" (server) only after the durable/mirror save point;
 * - offline/error copy always says edits are safe on the device.
 *
 * The chip is subtle by design: a small icon + label next to the document
 * title, with the full explanation in the accessible description
 * (title + sr-only text), never a wall of badges.
 */

import { useEffect, useState } from "react";
import {
  CloudOffIcon,
  CloudCheckIcon,
  CloudUploadIcon,
  CloudAlertIcon,
} from "lucide-react";

import { useDocumentSession } from "@/lib/collaboration/provider";
import { toSaveStatusView, type EditorSaveState } from "@/lib/collaboration/save-status";

const ICONS: Record<EditorSaveState, typeof CloudCheckIcon> = {
  "saved-locally": CloudCheckIcon,
  saving: CloudUploadIcon,
  "saved-mirror": CloudCheckIcon,
  offline: CloudOffIcon,
  error: CloudAlertIcon,
  conflict: CloudAlertIcon,
};

/** Online/offline signal from the browser (defaults to online in SSR). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    // Read once per event; initial read happens in the subscription window
    // to avoid a synchronous setState in the effect body.
    const sync = () => setOnline(navigator.onLine);
    const raf = requestAnimationFrame(sync);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}

export const SaveStatusIndicator = () => {
  const { content } = useDocumentSession();
  const online = useOnline();
  const view = toSaveStatusView(content.status, online);
  const Icon = ICONS[view.state];

  return (
    <span
      className={`inline-flex items-center gap-1 text-sm ${view.className}`}
      role="status"
      aria-live="polite"
    >
      <Icon
        className={`size-4 ${view.state === "saving" ? "animate-pulse motion-reduce:animate-none" : ""}`}
        aria-hidden="true"
      />
      <span className="hidden sm:inline">{view.label}</span>
      <span className="sr-only">{view.description}</span>
      {view.state === "conflict" ? (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="ml-1 underline underline-offset-2 hover:opacity-80"
        >
          Reload
        </button>
      ) : null}
    </span>
  );
};
