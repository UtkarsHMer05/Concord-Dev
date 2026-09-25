"use client";

/**
 * Concord editor surface.
 *
 * Owns the single TipTap instance and wires it into the local-first pipeline:
 *
 *   TipTap editor ⇄ CrdtEditorBridge ⇄ CRDT worker (IndexedDB-durable)
 *                                        ⇄ SyncSession ⇄ gateway (optional)
 *
 * When the CRDT path is healthy, edits become durable operations owned by
 * the worker, and the Phase-1 whole-document mirror must NOT also save
 * (double-write). When the bridge degrades — unsupported content or worker
 * failure — the mirror takes over durability and the mode indicator tells
 * the user the truth (DEC-016 seam, DEC-025 reconciled subset).
 */

import StarterKit from '@tiptap/starter-kit'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import Underline from '@tiptap/extension-underline'
import FontFamily from '@tiptap/extension-font-family'
import Highlight from "@tiptap/extension-highlight"
import { Color } from '@tiptap/extension-color'
import Link from '@tiptap/extension-link'
import TextAlign from '@tiptap/extension-text-align'
import Image from '@tiptap/extension-image'
import { useEditor, EditorContent, type Editor as TipTapEditor } from '@tiptap/react'
import { TextStyle } from '@tiptap/extension-text-style'
import { useEffect, useMemo, useRef } from 'react'

import { useEditorStore } from '@/store/use-editor-store';
import { useBridgeStatusStore } from '@/store/use-bridge-status-store';
import { useDocumentSession } from '@/lib/collaboration/provider';
import { CrdtEditorBridge } from '@/lib/crdt/editor-bridge';
import { useSyncSession } from '@/lib/sync/use-sync-session';
import { usePresenceCursors } from '@/lib/presence/use-presence-cursors';
import { PresenceOverlay } from '@/components/presence-overlay';
import type { CatchupBriefing } from '@/lib/sync/catchup-briefing';
import type { CrdtClient } from '@/lib/crdt/worker/client';
import { FontSizeExtension } from '@/extensions/font-size';
import { LineHeightExtension } from '@/extensions/line-height';

import { Ruler } from './ruler';

interface EditorProps {
  /** CRDT worker client; null on the server or when workers are unavailable. */
  crdtClient: CrdtClient | null;
  /** Document the replica belongs to. */
  documentId: string;
  /** Clerk principal that owns this browser's local replica. */
  userId: string | null;
  onCatchupBriefing: (briefing: CatchupBriefing) => void;
  onSyncNowReady: (syncNow: () => void) => void;
}

/**
 * TipTap's table extension family registers five separate nodes/marks, so
 * they are grouped into one spreadable list to keep the editor config flat.
 */
const TABLE_EXTENSIONS = [Table, TableRow, TableHeader, TableCell];

/** Page surface styling for the editable element (the "sheet" look). */
const EDITOR_SHEET_CLASS =
  "focus:outline-2 focus:outline-solid focus:outline-offset-2 focus:outline-blue-600 print:border-0 bg-white border border-[#C7C7C7] flex flex-col min-h-[1054px] w-[816px] pt-10 pr-14 pb-10 cursor-text";

/**
 * Every editor lifecycle hook TipTap offers funnels into the same store
 * refresh: the toolbar and menubar read the instance imperatively, so any
 * state-bearing event republishes the latest editor into the store.
 */
const publishEditorToStore =
  (setEditor: (editor: TipTapEditor | null) => void) =>
  ({ editor }: { editor: TipTapEditor }) => {
    setEditor(editor);
  };

export const Editor = ({ crdtClient, documentId, userId, onCatchupBriefing, onSyncNowReady }: EditorProps) => {
  const { editorContent, content, settings, canEditContent } = useDocumentSession();
  const { setEditor, setFlushEditorBridge } = useEditorStore();
  const setBridgeStatus = useBridgeStatusStore((s) => s.setState);
  const bridgeMode = useBridgeStatusStore((s) => s.state.mode);
  // The bridge exists only after the editor instance does; onUpdate routes
  // through this ref so the handler keeps working across bridge restarts.
  const bridgeRef = useRef<CrdtEditorBridge | null>(null);

  const editor = useEditor({
    autofocus: true,
    immediatelyRender: false,
    // VIEWER/COMMENTER roles get a read-only surface (the server rejects
    // their writes regardless — this is UX, not enforcement).
    editable: canEditContent,
    // null content keeps the sheet blank until session content arrives;
    // both TipTap JSON envelopes and template HTML are accepted here.
    content: editorContent ?? undefined,
    onCreate: publishEditorToStore(setEditor),
    onDestroy: () => setEditor(null),
    onUpdate({ editor }) {
      setEditor(editor)
      // Durability routing — exactly one owner per session:
      // - CRDT mode: the worker owns persistence; a whole-document mirror
      //   save here would double-write.
      // - fallback mode: the Phase-1 PostgreSQL mirror is the owner.
      if (bridgeMode !== 'crdt') {
        content.saveContent(editor.getJSON())
      }
      // Local-first path: diff against the CRDT canonical state and emit
      // durable ops through the worker. Failures degrade the session to
      // the Phase-1 mirror (logged, never unhandled).
      bridgeRef.current?.onLocalTransaction(editor).catch((error: unknown) => {
        console.error("[concord-crdt] local transaction failed:", error)
      })
    },
    onSelectionUpdate: publishEditorToStore(setEditor),
    onTransaction: publishEditorToStore(setEditor),
    onFocus: publishEditorToStore(setEditor),
    onBlur: publishEditorToStore(setEditor),
    onContentError: publishEditorToStore(setEditor),
    editorProps: {
      attributes: {
        // Keep the document surface in the keyboard tab order. Contenteditable
        // elements are not consistently tabbable across browser engines when
        // their editor wrapper is mounted dynamically, so this is explicit.
        tabindex: "0",
        // Ruler-controlled margins land as sheet padding (page settings are
        // client-local, not document content).
        style: `padding-left: ${settings.leftMargin}px; padding-right: ${settings.rightMargin}px;`,
        class: EDITOR_SHEET_CLASS,
      },
    },
    extensions: [
      // Node/mark core. StarterKit's link/underline are disabled because
      // dedicated configs below carry richer behavior.
      StarterKit.configure({ link: false, underline: false }),
      // Per-span text attributes (all CRDT-registry marks, DEC-025).
      TextStyle,
      FontFamily,
      FontSizeExtension,
      Color,
      Highlight.configure({ multicolor: true }),
      Underline,
      // Block-level attributes.
      LineHeightExtension,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      // Interactive content.
      Link.configure({
        // In-app navigation must win over external link clicks.
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https'
      }),
      Image.configure({ resize: { enabled: true } }),
      ...TABLE_EXTENSIONS,
      TaskItem.configure({ nested: true }),
      TaskList,
    ],
  })

  // Bridge lifecycle: construct derived from the editor instance (stable per
  // editor), then start inside the effect. The useMemo result also feeds the
  // sync-session hook without touching refs during render.
  const bridge = useMemo(() => {
    if (!crdtClient || !editor || !userId) {
      return null;
    }
    return new CrdtEditorBridge({
      editor,
      client: crdtClient,
      documentId,
      userId,
      // TipTap parses both stored JSON and template HTML before the bridge
      // starts; the bridge seeds from that parsed document.
      onStatusChange: (state) => {
        setBridgeStatus(state);
        if (state.mode === 'fallback') {
          content.saveContent(editor.getJSON());
        }
      },
    });
    // The bridge is per editor; content is read at start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crdtClient, editor, documentId, setBridgeStatus, userId]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    bridgeRef.current = bridge;
    setFlushEditorBridge(() => bridge.flushLocalChanges());
    void bridge.start();
    return () => {
      bridgeRef.current = null;
      setFlushEditorBridge(null);
      setBridgeStatus({ mode: "idle" });
    };
    // Bridge identity IS the dependency: start once per instance.
  }, [bridge, setBridgeStatus, setFlushEditorBridge]);

  // Realtime layer: only when the bridge is on the CRDT path does the
  // SyncSession start against the gateway. Signed out / no gateway URL /
  // fallback mode ⇒ the session stays local-only and truthful about it.
  const { syncNow, sendPresence } = useSyncSession({
    documentId,
    crdtClient,
    bridge,
    onCatchupBriefing,
  });

  // Live-cursor presence: broadcast this editor's own caret (CRDT-anchored,
  // ~8 Hz) and expire silent peers. Gated on the CRDT path so it never
  // touches the worker before init or in fallback mode.
  usePresenceCursors({ editor, crdtClient, sendPresence, enabled: bridgeMode === "crdt" });

  useEffect(() => {
    onSyncNowReady(syncNow);
    return () => onSyncNowReady(() => {});
  }, [onSyncNowReady, syncNow]);

  return (
    <div
      className="size-full overflow-x-auto bg-[#F9FBFD] px-4 print:p-0 print:bg-white print:overflow-visible"
      data-concord-bridge-mode={bridgeMode}
      data-concord-editor-ready={bridgeMode === "crdt" ? "true" : "false"}
    >
      <Ruler />
      {/* Fixed 816px sheet, horizontally centered; the outer container
          scrolls on viewports narrower than the page. */}
      <div className="min-w-max flex justify-center w-[816px] py-4 print:py-0 mx-auto print:w-full print:min-w-0">
        <div className="relative">
          <EditorContent editor={editor} />
          <PresenceOverlay editor={editor} crdtClient={crdtClient} />
        </div>
      </div>
    </div>
  );
};
