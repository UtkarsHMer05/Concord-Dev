import { LoaderIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import type { DocumentSummaryDto } from "@/server/services/documents";

import { DocumentRow } from "./document-row";

interface DocumentsTableProps {
  documents: DocumentSummaryDto[];
  hasMore: boolean;
  isLoadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  /** Called after a local mutation (delete) so the row drops immediately. */
  onMutated: (documentId: string) => void;
}

export const DocumentsTable = ({
  documents,
  hasMore,
  isLoadingMore,
  error,
  onLoadMore,
  onMutated,
}: DocumentsTableProps) => {
  return (
    <div className="max-w-screen-xl mx-auto px-16 py-6 flex flex-col gap-5">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent border-none">
            <TableHead>Name</TableHead>
            <TableHead>&nbsp;</TableHead>
            <TableHead className="hidden md:table-cell">Shared</TableHead>
            <TableHead className="hidden md:table-cell">Created at</TableHead>
          </TableRow>
        </TableHeader>
        {documents.length === 0 ? (
          <TableBody>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                No documents found
              </TableCell>
            </TableRow>
          </TableBody>
        ) : (
          <TableBody>
            {documents.map((document) => (
              <DocumentRow key={document.id} document={document} onRemoved={onMutated} />
            ))}
          </TableBody>
        )}
      </Table>
      <div className="flex items-center justify-center">
        <Button
          variant="ghost"
          size="sm"
          onClick={onLoadMore}
          disabled={!hasMore || isLoadingMore}
        >
          {isLoadingMore ? (
            <LoaderIcon className="animate-spin size-4" />
          ) : hasMore ? (
            "Load more"
          ) : (
            "End of results"
          )}
        </Button>
      </div>
      {error && (
        <div className="text-center text-sm text-red-500">{error}</div>
      )}
    </div>
  );
};
