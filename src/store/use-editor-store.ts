import { create } from "zustand";
import { type Editor } from "@tiptap/react";

/**
 * Main-thread TipTap editor handle for the toolbar/ruler components.
 *
 * The editor instance itself is created once by the editor component
 * and published here so imperative command callers (toolbar buttons,
 * margin ruler) do not need to thread the instance through props.
 * CRDT sync state deliberately does NOT live in this store — the
 * worker owns collaboration state and notifies through its own bridge.
 */
interface EditorState {
  editor: Editor | null;
  setEditor: (editor: Editor | null) => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  editor: null,
  setEditor: (editor) => set({ editor }),
}));
