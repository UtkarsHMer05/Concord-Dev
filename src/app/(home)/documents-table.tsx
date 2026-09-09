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
  /** Current search query (empty string when browsing). */
  search?: string;
}

export const DocumentsTable = ({
  documents,
  hasMore,
  isLoadingMore,
  error,
  onLoadMore,
  onMutated,
  search,
}: DocumentsTableProps) => {
  const emptyMessage = search
    ? `No documents matching “${search}”`
    : "No documents yet — create one from a template above";

  return (
    <div className="max-w-screen-xl mx-auto px-4 md:px-16 py-6 flex flex-col gap-5">
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
                {emptyMessage}
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
        {hasMore || isLoadingMore ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadMore}
            disabled={isLoadingMore}
          >
            {isLoadingMore ? (
              <>
                <LoaderIcon className="animate-spin size-4" aria-hidden="true" />
                <span>Loading…</span>
              </>
            ) : (
              "Load more"
            )}
          </Button>
        ) : documents.length > 0 ? (
          <p className="text-sm text-muted-foreground">End of results</p>
        ) : null}
      </div>
      {error && (
        <div className="flex flex-col items-center gap-2 text-center text-sm text-rose-700">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
};
