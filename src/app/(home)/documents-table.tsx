import { LoaderIcon } from "lucide-react";

// shadcn primitives for the list surface.
import {
  TableRow,
  TableHeader,
  TableHead,
  TableCell,
  TableBody,
  Table,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

import type { DocumentSummaryDto } from "@/server/services/documents";

import { DocumentRow } from "./document-row";

/**
 * Presentational home listing: renders whatever page of documents its
 * parent (DocumentsView) currently holds, plus pagination/error surfaces.
 *
 * Pure display by design — fetching lives in DocumentsView so this table
 * can render the server-rendered first chunk without any client effects.
 */
interface DocumentsTableProps {
  documents: DocumentSummaryDto[];
  /** True when the API said another chunk exists past `documents`. */
  hasMore: boolean;
  /** True while a "Load more" request is in flight. */
  isLoadingMore: boolean;
  /** Human-readable fetch failure shown with a retry button. */
  error: string | null;
  onLoadMore: () => void;
  /** Called after a local mutation (delete) so the row drops immediately. */
  onMutated: (documentId: string) => void;
  /** Current search query (empty string when browsing). */
  search?: string;
}

/** Column span covered by the table (icon, name, scope, created, actions). */
const COLUMN_COUNT = 4;

export const DocumentsTable = ({
  documents,
  hasMore,
  isLoadingMore,
  error,
  onLoadMore,
  onMutated,
  search,
}: DocumentsTableProps) => {
  const emptyStateText = search
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
        <TableBody>
          {documents.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell
                colSpan={COLUMN_COUNT}
                className="h-24 text-center text-muted-foreground"
              >
                {emptyStateText}
              </TableCell>
            </TableRow>
          ) : (
            documents.map((document) => (
              <DocumentRow
                key={document.id}
                document={document}
                onRemoved={onMutated}
              />
            ))
          )}
        </TableBody>
      </Table>

      {/* Pagination footer: spinner while loading, retry-able error, or the
          end-of-list marker. */}
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
