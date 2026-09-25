"use client";

/**
 * Local presence broadcaster (Feature 2). Watches the editor's own selection
 * and publishes it as an ephemeral, CRDT-anchored presence update at ~8 Hz
 * (trailing-throttled), plus runs the presence store's TTL sweep so silent
 * peers fade out. Sends are best-effort: `sendPresence` drops them unless the
 * gateway session is READY, so this never blocks typing or durable delivery.
 */

import { useEffect, useRef } from "react";
import type { Editor as TipTapEditor } from "@tiptap/react";

import { anchorPoint } from "@/lib/comments/anchors";
import type { PmNode } from "@/lib/crdt/pm-model";
import type { CrdtClient } from "@/lib/crdt/worker/client";
import type { PresenceState } from "@/lib/sync/protocol";
import { usePresenceStore } from "@/lib/presence/use-presence-store";

/** Trailing throttle window for outgoing presence (~8 Hz). */
const PRESENCE_THROTTLE_MS = 120;
/** How often to expire peers that went silent. */
const PRESENCE_SWEEP_MS = 5_000;
/** Idle re-broadcast so late joiners see this caret and TTLs stay fresh. */
const PRESENCE_HEARTBEAT_MS = 4_000;

export function usePresenceCursors({
  editor,
  crdtClient,
  sendPresence,
  enabled,
}: {
  editor: TipTapEditor | null;
  crdtClient: CrdtClient | null;
  sendPresence: (state: PresenceState) => void;
  /** Only broadcast on the CRDT path (a live gateway session); never in
   * fallback mode, and never before `client.init()` has run. */
  enabled: boolean;
}): void {
  const sweep = usePresenceStore((state) => state.sweep);
  const replicaIdRef = useRef<string | null>(null);

  useEffect(() => {
    const id = setInterval(() => sweep(), PRESENCE_SWEEP_MS);
    return () => clearInterval(id);
  }, [sweep]);

  useEffect(() => {
    if (!enabled || !editor || !crdtClient) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;

    crdtClient
      .replicaInfo()
      .then((info) => {
        if (!cancelled) replicaIdRef.current = info.replicaId;
      })
      .catch(() => {
        /* replica id unavailable: presence stays silent (nothing to key on) */
      });

    const publish = async () => {
      pending = false;
      const replicaId = replicaIdRef.current;
      if (cancelled || !replicaId) return;
      const { from, to } = editor.state.selection;
      let stream;
      try {
        stream = await crdtClient.exportStream();
      } catch {
        return;
      }
      if (cancelled) return;
      const doc = editor.getJSON() as PmNode;
      const anchor = anchorPoint(doc, stream, Math.min(from, to));
      const head = anchorPoint(doc, stream, Math.max(from, to));
      sendPresence({
        replicaId,
        anchorItem: anchor?.itemId,
        anchorSide: anchor?.side ?? "before",
        headItem: head?.itemId,
        headSide: head?.side ?? "before",
      });
    };

    const schedule = () => {
      if (pending || cancelled) return;
      pending = true;
      timer = setTimeout(() => {
        void publish();
      }, PRESENCE_THROTTLE_MS);
    };

    editor.on("selectionUpdate", schedule);
    editor.on("focus", schedule);
    schedule();
    // Heartbeat: re-broadcast the current caret periodically so a peer that
    // JOINS while this editor is idle still learns the cursor, and so peers
    // refresh each other's TTL instead of expiring during quiet stretches.
    const heartbeat = setInterval(schedule, PRESENCE_HEARTBEAT_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(heartbeat);
      editor.off("selectionUpdate", schedule);
      editor.off("focus", schedule);
    };
  }, [enabled, editor, crdtClient, sendPresence]);
}
