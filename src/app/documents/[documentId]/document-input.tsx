"use client";

import { toast } from "sonner";
import { useRef, useState } from "react";
import { BsCloudCheck, BsCloudSlash } from "react-icons/bs";
import { useRouter } from "next/navigation";

import { useDebounce } from "@/hooks/use-debounce";
import { useDocumentSession } from "@/lib/collaboration/provider";
import { renameDocumentAction } from "@/app/actions/documents";

import { LoaderIcon } from "lucide-react";

interface DocumentInputProps {
  title: string;
  id: string;
  metadataVersion: number;
  canRename: boolean;
};

export const DocumentInput = ({ title, id, metadataVersion, canRename }: DocumentInputProps) => {
  const { content } = useDocumentSession();
  const router = useRouter();

  const [value, setValue] = useState(title);
  const [isPending, setIsPending] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Local view of the server metadata version for conflict detection.
  const versionRef = useRef(metadataVersion);

  const inputRef = useRef<HTMLInputElement>(null);

  const debouncedUpdate = useDebounce(async (newValue: string) => {
    if (newValue === title) return;

    setIsPending(true);
    const result = await renameDocumentAction({
      documentId: id,
      title: newValue,
      expectedMetadataVersion: versionRef.current,
    });
    if (result.ok) {
      versionRef.current = result.data.metadataVersion;
      router.refresh();
    } else if (result.error.type === "conflict") {
      toast.error("Modified in another tab — reload before renaming.");
    } else {
      toast.error("Something went wrong");
    }
    setIsPending(false);
  });

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setValue(newValue);
    if (canRename) {
      debouncedUpdate(newValue);
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canRename) {
      setIsEditing(false);
      return;
    }

    setIsPending(true);
    const result = await renameDocumentAction({
      documentId: id,
      title: value,
      expectedMetadataVersion: versionRef.current,
    });
    if (result.ok) {
      toast.success("Document updated");
      versionRef.current = result.data.metadataVersion;
      setIsEditing(false);
      router.refresh();
    } else if (result.error.type === "conflict") {
      toast.error("Modified in another tab — reload before renaming.");
    } else {
      toast.error("Something went wrong");
    }
    setIsPending(false);
  };

  const showLoader = isPending || content.status === "saving";
  const showError = content.status === "error" || content.status === "conflict";

  return (
    <div className="flex items-center gap-2">
      {isEditing ? (
        <form onSubmit={handleSubmit} className="relative w-fit max-w-[50ch]">
          <span className="invisible whitespace-pre px-1.5 text-lg">
            {value || " "}
          </span>
          <input
            ref={inputRef}
            value={value}
            onChange={onChange}
            onBlur={() => setIsEditing(false)}
            className="absolute inset-0 text-lg text-black px-1.5 bg-transparent truncate"
          />
        </form>
      ) : (
        <span
          onClick={() => {
            if (!canRename) return;
            setIsEditing(true);
            setTimeout(() => {
              inputRef.current?.focus();
            }, 0);
          }}
          className={`text-lg px-1.5 truncate ${canRename ? "cursor-pointer" : "cursor-default"}`}>
          {title}
        </span>
      )}
      {showError && <BsCloudSlash className="size-4" />}
      {!showError && !showLoader && <BsCloudCheck className="size-4" />}
      {showLoader && <LoaderIcon className="size-4 animate-spin text-muted-foreground" />}
    </div>
  )
}
