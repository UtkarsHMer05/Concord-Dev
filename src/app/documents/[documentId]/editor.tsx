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

import { useEditorStore } from '@/store/use-editor-store';
import { useDocumentSession } from '@/lib/collaboration/provider';
import { FontSizeExtension } from '@/extensions/font-size';
import { LineHeightExtension } from '@/extensions/line-height';

import { Ruler } from './ruler';

export const Editor = () => {
  const { editorContent, content, settings } = useDocumentSession();

  const { setEditor } = useEditorStore();

  const editor = useEditor({
    autofocus: true,
    immediatelyRender: false,
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
      content.saveContent(editor.getJSON())
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

  return (
    <div className="size-full overflow-x-auto bg-[#F9FBFD] px-4 print:p-0 print:bg-white print:overflow-visible">
      <Ruler />
      <div className="min-w-max flex justify-center w-[816px] py-4 print:py-0 mx-auto print:w-full print:min-w-0">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
};
