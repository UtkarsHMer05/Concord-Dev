"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangleIcon, ChevronDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary.
 *
 * Two audiences, two layers:
 * - Users get a plain-language "something went wrong" plus a safe recovery
 *   path (retry the route segment, or bail to home). Documents live in
 *   PostgreSQL and the CRDT replica in IndexedDB, so a render failure never
 *   endangers their data — the copy says so.
 * - Developers can expand the technical block to read the actual error
 *   message; the Next.js `digest` id is shown by default since that is what
 *   production logs correlate on. Raw messages never render by default.
 */

const ErrorPage = ({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) => {
  const [detailsVisible, setDetailsVisible] = useState(false);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center space-y-6 px-4">
      {/* Primary message block: icon, headline, reassurance, digest id. */}
      <div className="text-center space-y-4">
        <div className="flex justify-center">
          <div className="bg-rose-100 p-3 rounded-full">
            <AlertTriangleIcon className="size-10 text-rose-600" aria-hidden="true" />
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-gray-900">
            Concord hit an error on this page
          </h2>
          <p className="text-muted-foreground max-w-md">
            Nothing was lost: the workspace is intact and this failure was
            contained to the current view. Retry the page or return home.
          </p>
          {error.digest ? (
            <p className="text-xs text-muted-foreground">
              Reference: <code className="font-mono">{error.digest}</code>
            </p>
          ) : null}
        </div>
      </div>

      {/* Recovery actions: re-run the failed segment or leave the route. */}
      <RecoveryActions onRetry={reset} />

      {/* Developer-only disclosure for the underlying error. */}
      <div className="text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setDetailsVisible((open) => !open)}
          aria-expanded={detailsVisible}
          className="inline-flex items-center gap-1 underline underline-offset-2"
        >
          Technical details
          <ChevronDownIcon
            className={`size-3.5 transition-transform motion-reduce:transform-none ${
              detailsVisible ? "rotate-180" : ""
            }`}
            aria-hidden="true"
          />
        </button>
        {detailsVisible ? (
          <pre className="mt-2 max-w-xl overflow-x-auto rounded-md bg-muted p-3 text-left font-mono whitespace-pre-wrap">
            {error.message}
          </pre>
        ) : null}
      </div>
    </div>
  );
};

export default ErrorPage;

/** Retry re-renders the failed segment; "Go back" is a hard navigation. */
const RecoveryActions = ({ onRetry }: { onRetry: () => void }) => (
  <div className="flex items-center gap-x-3">
    <Button onClick={onRetry} className="font-medium px-6">
      Try again
    </Button>
    <Button asChild variant="ghost" className="font-medium">
      <Link href="/">Go back</Link>
    </Button>
  </div>
);
