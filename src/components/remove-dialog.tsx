"use client";

import { toast } from "sonner";
import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

import { deleteDocumentAction } from "@/app/actions/documents";

interface RemoveDialogProps {
  documentId: string;
  /** Called after a successful deletion so list views can drop the row. */
  onRemoved?: (documentId: string) => void;
  children: React.ReactNode;
};

export const RemoveDialog = ({ documentId, onRemoved, children }: RemoveDialogProps) => {
  const router = useRouter();
  const [isRemoving, setIsRemoving] = useState(false);

  const onRemove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsRemoving(true);
    const result = await deleteDocumentAction({ documentId });
    if (result.ok) {
      toast.success("Document removed");
      onRemoved?.(documentId);
      router.push("/");
    } else {
      toast.error("Something went wrong");
    }
    setIsRemoving(false);
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {children}
      </AlertDialogTrigger>
      <AlertDialogContent onClick={(e) => e.stopPropagation()}>
        <AlertDialogHeader>
          <AlertDialogTitle>Are you sure?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete your
            document.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={(e) => e.stopPropagation()}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={isRemoving}
            onClick={onRemove}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
