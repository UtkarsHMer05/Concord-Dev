"use client";

import { toast } from "sonner";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { useDebounce } from "@/hooks/use-debounce";
import { renameDocumentAction } from "@/app/actions/documents";
import { SaveStatusIndicator } from "@/components/save-status-indicator";

/**
 * Inline document-title editor in the editor navbar.
 *
 * Two edit paths share one write helper:
 * - keystrokes in the input fire a *debounced* rename (typing "Project X"
 *   becomes one server mutation, not eight);
 * - submitting the form commits immediately.
 *
 * Renames carry `expectedMetadataVersion` (DEC-022 optimistic concurrency):
 * a version returned by the server updates our local ref so the next rename
 * compares against the version we actually created; a conflict means another
 * tab/device renamed first and we tell the user to reload instead of
 * silently overwriting.
 *
 * Viewers (`canRename === false`) see a plain, non-interactive title.
 */
interface DocumentInputProps {
  title: string;
  id: string;
  metadataVersion: number;
  canRename: boolean;
};

export const DocumentInput = ({
  title,
  id,
  metadataVersion,
  canRename,
}: DocumentInputProps) => {
  const router = useRouter();

  const [value, setValue] = useState(title);
  const [, setSaveInFlight] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Last metadata version this client observed/wrote — bumped on every
  // successful rename so consecutive saves chain correctly.
  const lastSeenVersionRef = useRef(metadataVersion);

  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Shared rename pipeline. Returns early when the title is unchanged so
   * debounced keystroke fires that land after a submit are no-ops.
   */
  const persistTitle = async (nextTitle: string) => {
    if (nextTitle === title) return;

    setSaveInFlight(true);
    const result = await renameDocumentAction({
      documentId: id,
      title: nextTitle,
      expectedMetadataVersion: lastSeenVersionRef.current,
    });
    if (result.ok) {
      lastSeenVersionRef.current = result.data.metadataVersion;
      router.refresh();
    } else if (result.error.type === "conflict") {
      toast.error("Modified in another tab — reload before renaming.");
    } else {
      toast.error("Something went wrong");
    }
    setSaveInFlight(false);
  };

  const debouncedPersist = useDebounce(persistTitle);

  const handleTyping = (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setValue(next);
    if (canRename) {
      debouncedPersist(next);
    }
  };

  /** Form submit: commit now (skip the debounce window) and leave edit mode. */
  const commitTitle = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canRename) {
      setIsEditing(false);
      return;
    }

    setSaveInFlight(true);
    const result = await renameDocumentAction({
      documentId: id,
      title: value,
      expectedMetadataVersion: lastSeenVersionRef.current,
    });
    if (result.ok) {
      toast.success("Document updated");
      lastSeenVersionRef.current = result.data.metadataVersion;
      setIsEditing(false);
      router.refresh();
    } else if (result.error.type === "conflict") {
      toast.error("Modified in another tab — reload before renaming.");
    } else {
      toast.error("Something went wrong");
    }
    setSaveInFlight(false);
  };

  /** Focus the input as soon as it mounts for a click→type flow. */
  const enterEditMode = () => {
    if (!canRename) return;
    setIsEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  return (
    <div className="flex items-center gap-2 min-w-0">
      {isEditing ? (
        <TitleEditForm
          draft={value}
          onDraftChange={handleTyping}
          onCommit={commitTitle}
          onAbandon={() => setIsEditing(false)}
          fieldRef={inputRef}
        />
      ) : (
        // Read-mode title: keyboard-operable when renaming is allowed.
        <span
          onClick={enterEditMode}
          role={canRename ? "button" : undefined}
          tabIndex={canRename ? 0 : undefined}
          onKeyDown={(event) => {
            if (!canRename) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              enterEditMode();
            }
          }}
          title={canRename ? "Rename this document" : undefined}
          className={`text-lg px-1.5 truncate ${
            canRename
              ? "cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              : "cursor-default"
          }`}
        >
          {title}
        </span>
      )}
      <SaveStatusIndicator />
    </div>
  );
};

/**
 * The inline editing form: an invisible mirror span sizes the form to its
 * text content (so switching modes does not shift the navbar), with the
 * real input absolutely positioned over it.
 */
const TitleEditForm = ({
  draft,
  onDraftChange,
  onCommit,
  onAbandon,
  fieldRef,
}: {
  draft: string;
  onDraftChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onCommit: (event: React.FormEvent<HTMLFormElement>) => void;
  onAbandon: () => void;
  fieldRef: React.RefObject<HTMLInputElement | null>;
}) => (
  <form onSubmit={onCommit} className="relative w-fit max-w-[50ch]">
    <label htmlFor="document-title-input" className="sr-only">
      Document title
    </label>
    <span className="invisible whitespace-pre px-1.5 text-lg" aria-hidden="true">
      {draft || " "}
    </span>
    <input
      id="document-title-input"
      ref={fieldRef}
      value={draft}
      onChange={onDraftChange}
      onBlur={onAbandon}
      className="absolute inset-0 text-lg text-black px-1.5 bg-transparent truncate"
    />
  </form>
);
