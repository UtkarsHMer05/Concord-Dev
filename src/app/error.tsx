"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertTriangleIcon, ChevronDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary (M007): never shows the raw error message —
 * users get a plain-language explanation; the technical detail stays
 * available behind an explicit disclosure for developers.
 */
const ErrorPage = ({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) => {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center space-y-6 px-4">
      <div className="text-center space-y-4">
        <div className="flex justify-center">
          <div className="bg-rose-100 p-3 rounded-full">
            <AlertTriangleIcon className="size-10 text-rose-600" aria-hidden="true" />
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-gray-900">
            Something went wrong
          </h2>
          <p className="text-muted-foreground max-w-md">
            The page could not be loaded. Your documents are safe — try again,
            or go back to the home page.
          </p>
          {error.digest ? (
            <p className="text-xs text-muted-foreground">
              Reference: <code className="font-mono">{error.digest}</code>
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-x-3">
        <Button
          onClick={reset}
          className="font-medium px-6"
        >
          Try again
        </Button>
        <Button
          asChild
          variant="ghost"
          className="font-medium"
        >
          <Link href="/">
            Go back
          </Link>
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => setShowDetails((open) => !open)}
          aria-expanded={showDetails}
          className="inline-flex items-center gap-1 underline underline-offset-2"
        >
          Technical details
          <ChevronDownIcon
            className={`size-3.5 transition-transform motion-reduce:transform-none ${showDetails ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
        {showDetails ? (
          <pre className="mt-2 max-w-xl overflow-x-auto rounded-md bg-muted p-3 text-left font-mono whitespace-pre-wrap">
            {error.message}
          </pre>
        ) : null}
      </div>
    </div>
  );
}

export default ErrorPage;
