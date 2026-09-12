"use client";

import { toast } from "sonner";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { renameDocumentAction } from "@/app/actions/documents";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  DialogTrigger,
  DialogTitle,
  DialogHeader,
  DialogFooter,
  DialogDescription,
  DialogContent,
  Dialog,
} from "./ui/dialog";

/**
 * Rename dialog (home listing + editor menubar both mount it).
 *
 * `expectedMetadataVersion` implements the optimistic-concurrency check from
 * DEC-022: the server rejects the rename if the document's metadata was
 * changed by anyone else since the caller last observed it, and we surface
 * that as an explicit "refresh and retry" message rather than overwriting
 * the other writer's title.
 */
interface RenameDialogProps {
  documentId: string;
  initialTitle: string;
  /** Version the caller last saw, for server-side conflict detection. */
  expectedMetadataVersion: number;
  /** Trigger element — rendered as the dialog's opener. */
  children: React.ReactNode;
};

export const RenameDialog = ({
  documentId,
  initialTitle,
  expectedMetadataVersion,
  children,
}: RenameDialogProps) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [draftTitle, setDraftTitle] = useState(initialTitle);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSaving(true);

    const result = await renameDocumentAction({
      documentId,
      // Empty submissions fall back to the neutral default title.
      title: draftTitle.trim() || "Untitled",
      expectedMetadataVersion,
    });
    if (result.ok) {
      toast.success("Document updated");
      router.refresh();
    } else if (result.error.type === "conflict") {
      toast.error("Document was modified elsewhere. Refresh and try again.");
    } else {
      toast.error("Something went wrong");
    }
    // Close on every outcome: success committed, conflict needs a refresh
    // before another attempt, other errors keep the entered text in the
    // parent's state anyway.
    setIsSaving(false);
    setOpen(false);
  };

  const cancel = (event: React.MouseEvent) => {
    // Some hosts sit inside click-through containers (menu items, rows);
    // stop the dialog's buttons from also triggering those hosts.
    event.stopPropagation();
    setOpen(false);
  };

  return (
    <RenamedDocumentDialogShell
      open={open}
      onOpenChange={setOpen}
      onCommit={save}
      onDismiss={cancel}
      trigger={children}
      inputId={`rename-input-${documentId}`}
      draftTitle={draftTitle}
      onDraftTitleChange={setDraftTitle}
      isSaving={isSaving}
    />
  );
};

/**
 * The visible dialog: title, name field, and footer buttons. Kept as its
 * own component so the rename pipeline above stays readable.
 */
const RenamedDocumentDialogShell = ({
  open,
  onOpenChange,
  onCommit,
  onDismiss,
  trigger,
  inputId,
  draftTitle,
  onDraftTitleChange,
  isSaving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommit: (event: React.FormEvent<HTMLFormElement>) => void;
  onDismiss: (event: React.MouseEvent) => void;
  trigger: React.ReactNode;
  inputId: string;
  draftTitle: string;
  onDraftTitleChange: (title: string) => void;
  isSaving: boolean;
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogTrigger asChild>{trigger}</DialogTrigger>
    <DialogContent onClick={(event) => event.stopPropagation()}>
      <form onSubmit={onCommit}>
        <DialogHeader>
          <DialogTitle>Rename document</DialogTitle>
          <DialogDescription>
            Enter a new name for this document
          </DialogDescription>
        </DialogHeader>
        <div className="my-4">
          <label htmlFor={inputId} className="sr-only">
            Document name
          </label>
          <Input
            id={inputId}
            value={draftTitle}
            onChange={(event) => onDraftTitleChange(event.target.value)}
            placeholder="Document name"
            onClick={(event) => event.stopPropagation()}
            autoFocus
          />
        </div>
        <DialogFooter>
          <CancelButton disabled={isSaving} onCancel={onDismiss} />
          <SaveButton disabled={isSaving} />
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
);

/**
 * Dialog buttons must swallow their clicks: some hosts (dropdown menu
 * items, clickable table rows) would otherwise react to the same click
 * that operates this dialog. The wrapping <DialogContent> already stops
 * propagation, so the buttons only forward their own intents.
 */
const CancelButton = ({
  disabled,
  onCancel,
}: {
  disabled: boolean;
  onCancel: (event: React.MouseEvent) => void;
}) => (
  <Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>
    Cancel
  </Button>
);

/** Submit side keeps its native type so Enter in the field saves too. */
const SaveButton = ({ disabled }: { disabled: boolean }) => (
  <Button type="submit" disabled={disabled}>
    Save
  </Button>
);
