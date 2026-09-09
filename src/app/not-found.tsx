import Link from "next/link";
import { FileQuestionIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** App-wide 404 (M007): friendly, non-blank, actionable. */
const NotFound = () => {
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
            Page not found
          </h2>
          <p className="text-muted-foreground max-w-md">
            The page you are looking for does not exist or has moved.
          </p>
        </div>
      </div>
      <Button asChild variant="ghost" className="font-medium">
        <Link href="/">Go to your documents</Link>
      </Button>
    </div>
  );
};

export default NotFound;
