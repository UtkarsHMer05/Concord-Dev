"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { renameDocumentAction } from "@/app/actions/documents";

interface RenameDialogProps {
  documentId: string;
  initialTitle: string;
  /** Version the caller last saw, for server-side conflict detection. */
  expectedMetadataVersion: number;
  children: React.ReactNode;
};

export const RenameDialog = ({
  documentId,
  initialTitle,
  expectedMetadataVersion,
  children,
}: RenameDialogProps) => {
  const router = useRouter();
  const [isUpdating, setIsUpdating] = useState(false);

  const [title, setTitle] = useState(initialTitle);
  const [open, setOpen] = useState(false);

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsUpdating(true);

    const result = await renameDocumentAction({
      documentId,
      title: title.trim() || "Untitled",
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
    setIsUpdating(false);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children}
      </DialogTrigger>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Rename document</DialogTitle>
            <DialogDescription>
              Enter a new name for this document
            </DialogDescription>
          </DialogHeader>
          <div className="my-4">
            <label htmlFor={`rename-input-${documentId}`} className="sr-only">
              Document name
            </label>
            <Input
              id={`rename-input-${documentId}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Document name"
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={isUpdating}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isUpdating}
              onClick={(e) => e.stopPropagation()}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
