"use client";

/**
 * Editor chrome navbar: brand link, inline title editor, a compact
 * File/Edit/Insert/Format menubar wired to TipTap commands, and the Clerk
 * org/user controls on the right.
 *
 * Concord-specific notes:
 * - Exports (JSON/HTML/TXT) serialize the *main-thread editor view*, which
 *   under the CRDT session is a mirror of the worker's canonical document —
 *   exporting never mutates anything, so it is safe for every role.
 * - Rename/remove are gated on the server by the effective role; the menu
 *   merely hides actions the caller cannot perform, it does not enforce.
 */

import Link from "next/link";
import Image from "next/image"
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { UserButton, OrganizationSwitcher } from "@clerk/nextjs";
import {
  TextIcon,
  TrashIcon,
  UnderlineIcon,
  Undo2Icon,
  type LucideIcon,
  BoldIcon,
  ItalicIcon,
  StrikethroughIcon,
  // File-menu icons (the only menu with export entries).
  FileIcon,
  FileJsonIcon,
  FilePenIcon,
  FilePlusIcon,
  // Text-file + browser-target icons.
  FileTextIcon,
  GlobeIcon,
  PrinterIcon,
  Redo2Icon,
  RemoveFormattingIcon,
} from "lucide-react";

import { RenameDialog } from "@/components/rename-dialog";
import { RemoveDialog } from "@/components/remove-dialog";
import { CollaborativeModeIndicator } from "@/components/collaborative-mode-indicator";
import { DocumentTools } from "@/components/document-tools";
import type { CrdtClient } from "@/lib/crdt/worker/client";
import {
  MenubarShortcut,
  MenubarSeparator,
  MenubarSubTrigger,
  MenubarSubContent,
  MenubarSub,
  MenubarTrigger,
  MenubarMenu,
  MenubarItem,
  MenubarContent,
  Menubar,
} from "@/components/ui/menubar";
import { useEditorStore } from "@/store/use-editor-store";
import { createDocumentAction } from "@/app/actions/documents";
import type { DocumentDetailDto } from "@/server/services/documents";

import { DocumentInput } from "./document-input";

interface NavbarProps {
  data: DocumentDetailDto;
  crdtClient: CrdtClient | null;
  syncNow: () => void;
};

/** Save/print export formats the File menu offers, with their serializers. */
type ExportFormat = "json" | "html" | "text";

const EXPORT_MIME: Record<ExportFormat, string> = {
  json: "application/json",
  html: "text/html",
  text: "text/plain",
};

/** Trigger a browser download for an in-memory blob. */
const downloadBlob = (blob: Blob, filename: string) => {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(href);
};

/** Menu trigger styling: compact, borderless text buttons inside the bar. */
const menuTriggerClass =
  "text-sm font-normal py-0.5 px-[7px] rounded-sm hover:bg-muted h-auto";

/** Every menubar menu needs the same trigger/content shell. */
const MenuShell = ({
  label,
  contentClassName,
  children,
}: {
  label: string;
  contentClassName?: string;
  children: React.ReactNode;
}) => (
  <MenubarMenu>
    <MenubarTrigger className={menuTriggerClass}>{label}</MenubarTrigger>
    <MenubarContent className={contentClassName}>{children}</MenubarContent>
  </MenubarMenu>
);

/**
 * One command row inside a menu: icon + label + optional shortcut hint.
 * Radix fires onClick for mouse users; the menubar handles keyboard focus.
 */
const MenuCommand = ({
  icon: Icon,
  label,
  shortcut,
  run,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  run: () => void;
}) => (
  <MenubarItem onClick={run}>
    <Icon className="size-4 mr-2" />
    {label}
    {shortcut ? <MenubarShortcut>{shortcut}</MenubarShortcut> : null}
  </MenubarItem>
);

/** Dropdown items that host a dialog keep the menu open instead of closing. */
const keepMenuOpenHandlers = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onSelect: (e: Event) => e.preventDefault(),
};

/** Clerk post-switch destinations: always back to the home listing. */
const HOME_REDIRECTS = {
  afterCreateOrganizationUrl: "/",
  afterLeaveOrganizationUrl: "/",
  afterSelectOrganizationUrl: "/",
  afterSelectPersonalUrl: "/",
};

export const Navbar = ({ data, crdtClient, syncNow }: NavbarProps) => {
  const router = useRouter();
  const { editor } = useEditorStore();

  // The menu only reflects the server-computed role; enforcement lives in
  // the actions themselves.
  const canRename = data.effectiveRole === "OWNER" || data.effectiveRole === "EDITOR";
  const isOwner = data.effectiveRole === "OWNER";

  /** Create a blank document and navigate straight into it. */
  const startNewDocument = async () => {
    const result = await createDocumentAction({
      title: "Untitled document",
      initialContent: "",
    });
    if (result.ok) {
      toast.success("Document created");
      router.push(`/documents/${result.data.id}`);
    } else {
      toast.error("Something went wrong");
    }
  };

  /** Insert an empty table of the given dimensions (no header row). */
  const insertTable = (dims: { rows: number; cols: number }) => {
    editor?.chain().focus()
      .insertTable({ ...dims, withHeaderRow: false })
      .run();
  };

  /** Serialize the current editor state in the requested format and download. */
  const exportAs = (format: ExportFormat) => {
    if (!editor) return;

    let serialized: string;
    if (format === "json") {
      serialized = JSON.stringify(editor.getJSON());
    } else if (format === "html") {
      serialized = editor.getHTML();
    } else {
      serialized = editor.getText();
    }

    downloadBlob(
      new Blob([serialized], { type: EXPORT_MIME[format] }),
      `${data.title}.${format === "text" ? "txt" : format}`
    );
  };

  /** Table presets for the Insert menu, largest last. */
  const tablePresets = [1, 2, 3, 4].map((size) => ({
    size,
    label: `${size} x ${size}`,
  }));

  /** Format-menu inline marks with their command + shortcut hint. */
  const textMarks = [
    { label: "Bold", icon: BoldIcon, shortcut: "⌘B", run: () => editor?.chain().focus().toggleBold().run() },
    { label: "Italic", icon: ItalicIcon, shortcut: "⌘I", run: () => editor?.chain().focus().toggleItalic().run() },
    { label: "Underline", icon: UnderlineIcon, shortcut: "⌘U", run: () => editor?.chain().focus().toggleUnderline().run() },
    { label: "Strikethrough", icon: StrikethroughIcon, shortcut: "⌘⇧X", run: () => editor?.chain().focus().toggleStrike().run() },
  ];

  /** History commands for the Edit menu, in toolbar order. */
  const historyCommands = [
    { label: "Undo", icon: Undo2Icon, shortcut: "⌘Z", run: () => editor?.chain().focus().undo().run() },
    { label: "Redo", icon: Redo2Icon, shortcut: "⌘Y", run: () => editor?.chain().focus().redo().run() },
  ];

  return (
    <nav className="flex items-center justify-between gap-x-2 min-w-0">
      <div className="flex gap-2 items-center min-w-0">
        <Link href="/" aria-label="Back to Concord home" className="shrink-0">
          <Image src="/logo.svg" alt="Concord logo" width={36} height={36} />
        </Link>
        <div className="flex flex-col min-w-0">
          <DocumentInput
            title={data.title}
            id={data.id}
            metadataVersion={data.metadataVersion}
            canRename={canRename}
          />
          <div className="flex items-center gap-x-2 min-w-0 overflow-x-auto">
            <Menubar className="border-none bg-transparent shadow-none h-auto p-0 shrink-0">
              <MenuShell label="File" contentClassName="print:hidden">
                {/* Save submenu: serialize the editor view to a file. */}
                <MenubarSub>
                  <MenubarSubTrigger>
                    <FileIcon className="size-4 mr-2" />
                    Save
                  </MenubarSubTrigger>
                  <MenubarSubContent>
                    <MenubarItem onClick={() => exportAs("json")}>
                      <FileJsonIcon className="size-4 mr-2" />
                      JSON
                    </MenubarItem>
                    <MenubarItem onClick={() => exportAs("html")}>
                      <GlobeIcon className="size-4 mr-2" />
                      HTML
                    </MenubarItem>
                    <MenubarItem onClick={() => exportAs("text")}>
                      <FileTextIcon className="size-4 mr-2" />
                      Text
                    </MenubarItem>
                    <MenubarItem onClick={() => window.print()}>
                      <PrinterIcon className="size-4 mr-2" />
                      Print / Save PDF <MenubarShortcut>⌘P</MenubarShortcut>
                    </MenubarItem>
                  </MenubarSubContent>
                </MenubarSub>
                <MenubarItem onClick={() => void startNewDocument()}>
                  <FilePlusIcon className="size-4 mr-2" />
                  New Document
                </MenubarItem>
                <MenubarSeparator />
                {canRename && (
                  <RenameDialog
                    documentId={data.id}
                    initialTitle={data.title}
                    expectedMetadataVersion={data.metadataVersion}
                  >
                    {/* keepMenuOpenHandlers keeps the menubar alive while
                        the dialog takes over focus. */}
                    <MenubarItem {...keepMenuOpenHandlers}>
                      <FilePenIcon className="size-4 mr-2" />
                      Rename
                    </MenubarItem>
                  </RenameDialog>
                )}
                {isOwner && (
                  <RemoveDialog documentId={data.id}>
                    <MenubarItem {...keepMenuOpenHandlers}>
                      <TrashIcon className="size-4 mr-2" />
                      Remove
                    </MenubarItem>
                  </RemoveDialog>
                )}
                <MenubarSeparator />
                <MenubarItem onClick={() => window.print()}>
                  <PrinterIcon className="size-4 mr-2" />
                  Print <MenubarShortcut>⌘P</MenubarShortcut>
                </MenubarItem>
              </MenuShell>
              <MenuShell label="Edit">
                {historyCommands.map((command) => (
                  <MenuCommand key={command.label} {...command} />
                ))}
              </MenuShell>
              <MenuShell label="Insert">
                <MenubarSub>
                  <MenubarSubTrigger>Table</MenubarSubTrigger>
                  <MenubarSubContent>
                    {tablePresets.map(({ size, label }) => (
                      <MenubarItem
                        key={label}
                        onClick={() => insertTable({ rows: size, cols: size })}
                      >
                        {label}
                      </MenubarItem>
                    ))}
                  </MenubarSubContent>
                </MenubarSub>
              </MenuShell>
              <MenuShell label="Format">
                <MenubarSub>
                  <MenubarSubTrigger>
                    <TextIcon className="size-4 mr-2" />
                    Text
                  </MenubarSubTrigger>
                  <MenubarSubContent>
                    {textMarks.map((mark) => (
                      <MenuCommand key={mark.label} {...mark} />
                    ))}
                  </MenubarSubContent>
                </MenubarSub>
                <MenubarItem onClick={() => editor?.chain().focus().unsetAllMarks().run()}>
                  <RemoveFormattingIcon className="size-4 mr-2" />
                  Clear formatting
                </MenubarItem>
              </MenuShell>
            </Menubar>
            <CollaborativeModeIndicator />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <DocumentTools document={data} crdtClient={crdtClient} syncNow={syncNow} />
        <AccountControls />
      </div>
    </nav>
  );
};

/**
 * Right-aligned account controls. `shrink-0` keeps this section at its
 * natural size so the menubar/title area absorbs any width pressure.
 */
const AccountControls = () => (
  <div className="flex gap-3 items-center pl-2 sm:pl-6 shrink-0">
    {/* All Clerk redirect targets return to the home listing so an org
        switch can never strand the user on an inaccessible document. */}
    <OrganizationSwitcher {...HOME_REDIRECTS} />
    <UserButton />
  </div>
);
