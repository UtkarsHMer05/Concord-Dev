import { create } from "zustand";
import { type Editor } from "@tiptap/react";

/**
 * Main-thread TipTap editor handle for the toolbar/ruler components.
 *
 * The editor instance itself is created once by the editor component
 * and published here so imperative command callers (toolbar buttons,
 * margin ruler) do not need to thread the instance through props.
 * The CRDT worker still owns collaboration state. The store exposes only an
 * imperative bridge flush so export actions can wait for durable local edits.
 */
interface EditorState {
  editor: Editor | null;
  flushEditorBridge: (() => Promise<void>) | null;
  setEditor: (editor: Editor | null) => void;
  setFlushEditorBridge: (flush: (() => Promise<void>) | null) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  editor: null,
  flushEditorBridge: null,
  setEditor: (editor) => set({ editor }),
  setFlushEditorBridge: (flushEditorBridge) => set({ flushEditorBridge }),
}));
