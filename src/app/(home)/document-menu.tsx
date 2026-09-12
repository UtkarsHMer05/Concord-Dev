"use client";

import { ExternalLinkIcon, FilePenIcon, TrashIcon, MoreVertical } from "lucide-react";

// Dialog hosts + dropdown chrome (shadcn primitives).
import { RenameDialog } from "@/components/rename-dialog";
import { RemoveDialog } from "@/components/remove-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuTrigger,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenu,
} from "@/components/ui/dropdown-menu";

/**
 * Per-row action menu on the home listing.
 *
 * The dialogs (rename/remove) are nested inside dropdown items; each item
 * suppresses the dropdown's own select/close behavior so the dialog can
 * stay mounted and take over — otherwise Radix would tear the dialog down
 * the moment the menu item activates.
 */
interface DocumentMenuProps {
  documentId: string;
  title: string;
  /** Server version the caller last observed (rename conflict check). */
  metadataVersion: number;
  onNewTab: (id: string) => void;
  /** Row-level removal callback so the list can drop the entry instantly. */
  onRemoved: (documentId: string) => void;
};

export const DocumentMenu = ({
  documentId,
  title,
  metadataVersion,
  onNewTab,
  onRemoved,
}: DocumentMenuProps) => {
  /** Shared handlers that keep the dropdown open while the dialog opens. */
  const keepMenuOpen = {
    onSelect: (event: Event) => event.preventDefault(),
    onClick: (event: React.MouseEvent) => event.stopPropagation(),
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={`Actions for ${title}`}
          title={`Actions for ${title}`}
        >
          <MoreVertical className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {/* Rename + remove rows are dialog hosts: they must not close this
            dropdown, or Radix would unmount the dialog mid-open. */}
        <RenameDialog
          documentId={documentId}
          initialTitle={title}
          expectedMetadataVersion={metadataVersion}
        >
          <DropdownMenuItem {...keepMenuOpen}>
            <FilePenIcon className="size-4 mr-2" />
            Rename
          </DropdownMenuItem>
        </RenameDialog>
        <RemoveDialog documentId={documentId} onRemoved={onRemoved}>
          <DropdownMenuItem {...keepMenuOpen}>
            <TrashIcon className="size-4 mr-2" />
            Remove
          </DropdownMenuItem>
        </RemoveDialog>
        <NewTabItem documentId={documentId} onNewTab={onNewTab} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * Plain (non-dialog) row that opens the document in a second browser tab,
 * leaving the current listing untouched.
 */
const NewTabItem = ({
  documentId,
  onNewTab,
}: Pick<DocumentMenuProps, "documentId" | "onNewTab">) => (
  <DropdownMenuItem
    onClick={() => {
      onNewTab(documentId);
    }}
  >
    <ExternalLinkIcon className="size-4 mr-2" />
    Open in a new tab
  </DropdownMenuItem>
);
