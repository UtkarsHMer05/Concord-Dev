import { LoaderIcon } from "lucide-react";

/**
 * Full-viewport loading state for the document and auth routes.
 * `role="status"` + `aria-live="polite"` make the wait observable to
 * assistive tech (the spinner itself is aria-hidden — motion conveys
 * nothing); the label is mirrored to a screen-reader-only sentence so
 * it is announced rather than shown twice.
 */
interface DocumentLoadingIndicatorProps {
  label?: string;
}

export const DocumentLoadingIndicator = ({
  label,
}: DocumentLoadingIndicatorProps) => {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-2"
      role="status"
      aria-live="polite"
    >
      <LoaderIcon
        className="size-6 text-muted-foreground animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
      {label && <span className="sr-only">{label}</span>}
    </div>
  );
};
