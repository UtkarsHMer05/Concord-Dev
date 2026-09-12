"use client";

import { toast } from "sonner";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { deleteDocumentAction } from "@/app/actions/documents";
import {
  AlertDialogTrigger,
  AlertDialogTitle,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogDescription,
  AlertDialogContent,
  AlertDialogCancel,
  AlertDialogAction,
  AlertDialog,
} from "@/components/ui/alert-dialog";

/**
 * Delete confirmation dialog.
 *
 * Deletion is server-side and permanent (hard delete in the documents
 * service), so the user always gets an explicit confirm step. The dialog
 * works both from the home rows and the editor menubar: on the home page
 * `onRemoved` lets the listing drop the row without waiting for the
 * revalidation round-trip; in the editor there is nothing left to render
 * after deletion, so we route back to "/".
 */
interface RemoveDialogProps {
  documentId: string;
  /** Called after a successful deletion so list views can drop the row. */
  onRemoved?: (documentId: string) => void;
  /** Trigger element — rendered as the dialog's opener. */
  children: React.ReactNode;
};

export const RemoveDialog = ({ documentId, onRemoved, children }: RemoveDialogProps) => {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);

  const confirmDelete = async (event: React.MouseEvent) => {
    // Menubar/row hosts would otherwise close or navigate from this click.
    event.stopPropagation();
    setIsDeleting(true);

    const result = await deleteDocumentAction({ documentId });
    if (result.ok) {
      toast.success("Document removed");
      onRemoved?.(documentId);
      router.push("/");
    } else {
      toast.error("Something went wrong");
      setIsDeleting(false);
    }
  };

  return (
    <DeleteConfirmation trigger={children} busy={isDeleting} onConfirm={confirmDelete} />
  );
};

/**
 * Visual layer of the delete flow, separated from the mutation logic so the
 * irrevocability copy sits next to the elements that carry it. Clicks are
 * stopped at the content wrapper because this dialog is often mounted inside
 * click-through hosts (menu items, table rows).
 */
const DeleteConfirmation = ({
  trigger,
  busy,
  onConfirm,
}: {
  trigger: React.ReactNode;
  busy: boolean;
  onConfirm: (event: React.MouseEvent) => void;
}) => (
  <AlertDialog>
    <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
    <AlertDialogContent onClick={(event) => event.stopPropagation()}>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete this document?</AlertDialogTitle>
        <AlertDialogDescription>
          The document and its entire revision history are removed
          permanently. There is no undo for this step.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel onClick={(event) => event.stopPropagation()}>
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction disabled={busy} onClick={onConfirm}>
          Delete
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);
