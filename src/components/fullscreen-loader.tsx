import { LoaderIcon } from "lucide-react";

interface FullscreenLoaderProps {
  label?: string;
};

export const FullscreenLoader = ({ label }: FullscreenLoaderProps) => {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-2"
      role="status"
      aria-live="polite"
    >
      <LoaderIcon className="size-6 text-muted-foreground animate-spin motion-reduce:animate-none" aria-hidden="true" />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
      {label && <span className="sr-only">Loading…</span>}
    </div>
  );
};
