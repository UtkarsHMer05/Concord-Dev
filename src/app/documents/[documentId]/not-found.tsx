import Link from "next/link";
import { FileQuestionIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Document 404 (M007): shown when a document does not exist or is not
 * accessible with the current account. Deliberately indistinguishable —
 * the server masks denials as not-found to avoid existence leaks
 * (src/server/services/documents.ts).
 */
const DocumentNotFound = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center space-y-6 px-4">
      <div className="text-center space-y-4">
        <div className="flex justify-center">
          <div className="bg-muted p-3 rounded-full">
            <FileQuestionIcon className="size-10 text-muted-foreground" aria-hidden="true" />
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-gray-900">
            Document not found
          </h2>
          <p className="text-muted-foreground max-w-md">
            This document does not exist, or you do not have access to it with
            the current account. If you were invited to it, ask the owner to
            share it with you.
          </p>
        </div>
      </div>
      <Button asChild variant="ghost" className="font-medium">
        <Link href="/">Go to your documents</Link>
      </Button>
    </div>
  );
};

export default DocumentNotFound;
