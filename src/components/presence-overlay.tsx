"use client";

/**
 * Live presence overlay (Feature 2). Renders remote collaborators' carets and
 * selections over the editor sheet, positioned from CRDT item-id anchors
 * resolved against the live stream — so a peer caret stays welded to the right
 * character while everyone edits, instead of drifting on a raw offset.
 *
 * Read-only decoration: `pointer-events: none`, never touches the document or
 * the CRDT. Peers arrive/leave via the presence store; a peer that goes silent
 * is expired by the store's TTL sweep. Positions recompute on document edits,
 * scrolling, and resize.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor as TipTapEditor } from "@tiptap/react";

import { resolvePointAnchors } from "@/lib/comments/anchors";
import type { StreamEntryJson } from "@/lib/crdt/adapter";
import type { PmNode } from "@/lib/crdt/pm-model";
import type { CrdtClient } from "@/lib/crdt/worker/client";
import { peerColor, usePresenceStore } from "@/lib/presence/use-presence-store";

interface CaretBox {
  connectionId: string;
  color: string;
  label: string;
  caretLeft: number;
  caretTop: number;
  caretHeight: number;
  /** Same-line selection band (omitted for collapsed or multi-line selections). */
  band: { left: number; top: number; width: number; height: number } | null;
}

/** A short, non-identifying label from the peer's user id (never a real name). */
function shortLabel(userId: string): string {
  const cleaned = userId.replace(/[^a-zA-Z0-9]/g, "");
  return cleaned.length <= 6 ? cleaned || "peer" : cleaned.slice(0, 6);
}
// OVERLAY_BODY_PLACEHOLDER
export function PresenceOverlay({
  editor,
  crdtClient,
}: {
  editor: TipTapEditor | null;
  crdtClient: CrdtClient | null;
}) {
  const peers = usePresenceStore((state) => state.peers);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [stream, setStream] = useState<StreamEntryJson[]>([]);
  const [tick, setTick] = useState(0);

  const peerCount = Object.keys(peers).length;

  // Refresh the CRDT stream snapshot when the document changes — but ONLY
  // once a peer exists. This is also a correctness guard: the overlay is a
  // CHILD of the editor, so its effects run before the parent's
  // `bridge.start()`/`client.init()`; touching the worker here at mount would
  // race initialization and knock the bridge into fallback mode. Peers only
  // arrive after the gateway session is up, so gating on peerCount keeps the
  // worker untouched until initialization is safely complete.
  useEffect(() => {
    if (!crdtClient || peerCount === 0) return;
    let cancelled = false;
    const refresh = () => {
      crdtClient
        .exportStream()
        .then((next) => {
          if (!cancelled) setStream(next);
        })
        .catch(() => {
          /* stream unavailable: carets simply hold until the next refresh */
        });
    };
    refresh();
    // A single fetch on peer arrival can fail or race a busy worker (the
    // caret then never renders — observed live). While peers exist, refresh
    // periodically like the publisher's heartbeat does; presence is
    // continuously-refreshing ephemeral state, not a one-shot read.
    const interval = setInterval(refresh, 2_000);
    if (!editor) return () => {
      cancelled = true;
      clearInterval(interval);
    };
    const onTx = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) refresh();
    };
    editor.on("transaction", onTx);
    return () => {
      cancelled = true;
      clearInterval(interval);
      editor.off("transaction", onTx);
    };
  }, [editor, crdtClient, peerCount]);

  // Reposition on scroll/resize (coordsAtPos is viewport-relative).
  useEffect(() => {
    if (!editor || peerCount === 0) return;
    const bump = () => setTick((value) => value + 1);
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    return () => {
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", bump, true);
    };
  }, [editor, peerCount]);

  const carets = useMemo<CaretBox[]>(() => {
    void tick;
    const root = rootRef.current;
    if (!editor || !root || peerCount === 0) return [];
    const doc = editor.getJSON() as PmNode;
    const requests: Array<{ key: string; point: NonNullable<(typeof peers)[string]["head"]> }> = [];
    for (const peer of Object.values(peers)) {
      if (peer.head) requests.push({ key: `${peer.connectionId}|head`, point: peer.head });
      if (peer.anchor) requests.push({ key: `${peer.connectionId}|anchor`, point: peer.anchor });
    }
    if (requests.length === 0) return [];
    const resolved = resolvePointAnchors(doc, stream, requests);
    const rootRect = root.getBoundingClientRect();
    const docSize = editor.state.doc.content.size;
    const boxes: CaretBox[] = [];
    for (const peer of Object.values(peers)) {
      const head = resolved[`${peer.connectionId}|head`];
      if (!head || head.status !== "attached" || head.pos > docSize) continue;
      let coords;
      try {
        coords = editor.view.coordsAtPos(head.pos);
      } catch {
        continue;
      }
      const caretLeft = coords.left - rootRect.left;
      const caretTop = coords.top - rootRect.top;
      const caretHeight = Math.max(12, coords.bottom - coords.top);
      let band: CaretBox["band"] = null;
      const anchor = resolved[`${peer.connectionId}|anchor`];
      if (anchor && anchor.status === "attached" && anchor.pos !== head.pos && anchor.pos <= docSize) {
        try {
          const a = editor.view.coordsAtPos(anchor.pos);
          if (Math.abs(a.top - coords.top) < 2) {
            const left = Math.min(a.left, coords.left) - rootRect.left;
            const width = Math.abs(a.left - coords.left);
            if (width > 0) band = { left, top: caretTop, width, height: caretHeight };
          }
        } catch {
          /* selection endpoint off-screen: show the caret alone */
        }
      }
      boxes.push({
        connectionId: peer.connectionId,
        color: peerColor(peer.replicaId || peer.connectionId),
        label: shortLabel(peer.userId),
        caretLeft,
        caretTop,
        caretHeight,
        band,
      });
    }
    return boxes;
  }, [peers, stream, editor, peerCount, tick]);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
    >
      {carets.map((caret) => (
        <div key={caret.connectionId}>
          {caret.band && (
            <div
              className="absolute rounded-sm"
              style={{
                left: caret.band.left,
                top: caret.band.top,
                width: caret.band.width,
                height: caret.band.height,
                backgroundColor: caret.color,
                opacity: 0.18,
              }}
            />
          )}
          <div
            data-testid="presence-caret"
            data-peer={caret.connectionId}
            className="absolute w-0.5"
            style={{
              left: caret.caretLeft,
              top: caret.caretTop,
              height: caret.caretHeight,
              backgroundColor: caret.color,
            }}
          />
          <span
            className="absolute -translate-y-full whitespace-nowrap rounded px-1 text-[10px] font-medium leading-4 text-white"
            style={{
              left: caret.caretLeft,
              top: caret.caretTop,
              backgroundColor: caret.color,
            }}
          >
            {caret.label}
          </span>
        </div>
      ))}
    </div>
  );
}

