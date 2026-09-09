"use client";

import StarterKit from '@tiptap/starter-kit'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import TextAlign from '@tiptap/extension-text-align'
import Link from '@tiptap/extension-link'
import { Color } from '@tiptap/extension-color'
import Highlight from "@tiptap/extension-highlight"
import FontFamily from '@tiptap/extension-font-family'
import { TextStyle } from '@tiptap/extension-text-style'
import Underline from '@tiptap/extension-underline'
import { useEditor, EditorContent } from '@tiptap/react'
import { useEffect, useMemo, useRef } from 'react'

import { useEditorStore } from '@/store/use-editor-store';
import { useBridgeStatusStore } from '@/store/use-bridge-status-store';
import { useDocumentSession } from '@/lib/collaboration/provider';
import { CrdtEditorBridge } from '@/lib/crdt/editor-bridge';
import { useSyncSession } from '@/lib/sync/use-sync-session';
import type { CrdtClient } from '@/lib/crdt/worker/client';
import type { PmNode } from '@/lib/crdt/pm-model';
import { FontSizeExtension } from '@/extensions/font-size';
import { LineHeightExtension } from '@/extensions/line-height';

import { Ruler } from './ruler';

interface EditorProps {
  /** CRDT worker client; null on the server or when workers are unavailable. */
  crdtClient: CrdtClient | null;
  /** Document the replica belongs to. */
  documentId: string;
  /** Server-side seed (Phase 1 envelope content) for the first local open. */
  seedPmDoc: PmNode | null;
}

export const Editor = ({ crdtClient, documentId, seedPmDoc }: EditorProps) => {
  const { editorContent, content, settings, canEditContent } = useDocumentSession();
  const { setEditor } = useEditorStore();
  const setBridgeStatus = useBridgeStatusStore((s) => s.setState);
  const bridgeMode = useBridgeStatusStore((s) => s.state.mode);
  // The bridge is created after the editor exists; onUpdate routes through
  // this ref so the creation-time closure stays valid.
  const bridgeRef = useRef<CrdtEditorBridge | null>(null);

  const editor = useEditor({
    autofocus: true,
    immediatelyRender: false,
    // VIEWER/COMMENTER roles get a read-only editor (server enforces anyway).
    editable: canEditContent,
    // null content keeps the editor empty until the session content loads;
    // TipTap JSON or template HTML are both accepted.
    content: editorContent ?? undefined,
    onCreate({ editor }) {
      setEditor(editor);
    },
    onDestroy() {
      setEditor(null);
    },
    onUpdate({ editor }) {
      setEditor(editor)
      // Two write paths, mutually exclusive per session (D16):
      // - CRDT mode: ops flow through the worker → SyncSession → gateway;
      //   the whole-document mirror must NOT double-save.
      // - fallback mode (unsupported content / worker failure): the
      //   Phase 1 PostgreSQL mirror owns durability.
      if (bridgeMode !== 'crdt') {
        content.saveContent(editor.getJSON())
      }
      // Phase 2 local-first path: diff against the CRDT canonical state and
      // emit durable operations through the worker. Failures degrade the
      // session to the Phase-1 mirror (logged, never unhandled).
      bridgeRef.current?.onLocalTransaction(editor).catch((error: unknown) => {
        console.error("[concord-crdt] local transaction failed:", error)
      })
    },
    onSelectionUpdate({ editor }) {
      setEditor(editor)
    },
    onTransaction({ editor }) {
      setEditor(editor)
    },
    onFocus({ editor }) {
      setEditor(editor)
    },
    onBlur({ editor }) {
      setEditor(editor)
    },
    onContentError({ editor }) {
      setEditor(editor)
    },
    editorProps: {
      attributes: {
        style: `padding-left: ${settings.leftMargin}px; padding-right: ${settings.rightMargin}px;`,
        class: "focus:outline-none print:border-0 bg-white border border-[#C7C7C7] flex flex-col min-h-[1054px] w-[816px] pt-10 pr-14 pb-10 cursor-text"
      },
    },
    extensions: [
      StarterKit.configure({
        link: false,
        underline: false,
      }),
      LineHeightExtension,
      FontSizeExtension,
      TextAlign.configure({
        types: ["heading", "paragraph"]
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https"
      }),
      Color,
      Highlight.configure({
        multicolor: true,
      }),
      FontFamily,
      TextStyle,
      Underline,
      Image.configure({
        resize: { enabled: true },
      }),
      Table,
      TableRow,
      TableHeader,
      TableCell,
      TaskItem.configure({
        nested: true,
      }),
      TaskList,
    ],
  })

  // Bridge lifecycle (client-side only): the bridge is CREATED derived from
  // the editor instance (stable per editor), and started in the effect. The
  // useMemo value also feeds the sync-session hook without touching refs
  // during render.
  const bridge = useMemo(() => {
    if (!crdtClient || !editor) {
      return null;
    }
    return new CrdtEditorBridge({
      editor,
      client: crdtClient,
      documentId,
      seedPmDoc,
      // M008 honesty rule: the fallback (unsupported content → whole-document
      // save path) is surfaced to the UI, never silent.
      onStatusChange: setBridgeStatus,
    });
    // seedPmDoc is read once at bridge start; the bridge is per editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crdtClient, editor, documentId, setBridgeStatus]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    bridgeRef.current = bridge;
    void bridge.start();
    return () => {
      bridgeRef.current = null;
      setBridgeStatus({ mode: "idle" });
    };
    // The bridge identity IS the dependency: start once per instance.
  }, [bridge, setBridgeStatus]);

  // Realtime wiring (D16): once the bridge is on the CRDT path, start the
  // SyncSession (REAL worker engine port) against the configured gateway.
  // No gateway URL / signed out / fallback ⇒ stays local-only (truthful).
  useSyncSession({
    documentId,
    crdtClient,
    bridge,
  });

  return (
    <div className="size-full overflow-x-auto bg-[#F9FBFD] px-4 print:p-0 print:bg-white print:overflow-visible">
      <Ruler />
      <div className="min-w-max flex justify-center w-[816px] py-4 print:py-0 mx-auto print:w-full print:min-w-0">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
};
