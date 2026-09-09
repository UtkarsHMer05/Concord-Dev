"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { DocumentSummaryDto } from "@/server/services/documents";

import { DocumentsTable } from "./documents-table";

interface DocumentsViewProps {
  initialDocuments: DocumentSummaryDto[];
  initialHasMore: boolean;
  search: string;
  pageSize: number;
}

/**
 * Client-side document list. The server renders the first chunk from
 * PostgreSQL; "Load more" fetches further authorized chunks from
 * GET /api/documents (same scope enforcement server-side).
 */
export const DocumentsView = ({
  initialDocuments,
  initialHasMore,
  search,
  pageSize,
}: DocumentsViewProps) => {
  const router = useRouter();
  const [documents, setDocuments] = useState(initialDocuments);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Identity marker of the server data the local state was synced from.
  const [syncedInitial, setSyncedInitial] = useState(initialDocuments);

  // Render-phase sync (react.dev "You Might Not Need an Effect"): when the
  // server sends fresh data after a mutation or search change, adopt it.
  if (syncedInitial !== initialDocuments) {
    setSyncedInitial(initialDocuments);
    setDocuments(initialDocuments);
    setHasMore(initialHasMore);
  }

  const loadMore = async () => {
    setIsLoadingMore(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        search,
        offset: String(documents.length),
        limit: String(pageSize),
      });
      const response = await fetch(`/api/documents?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const data = (await response.json()) as {
        documents: DocumentSummaryDto[];
        hasMore: boolean;
      };
      setDocuments((current) => [...current, ...data.documents]);
      setHasMore(data.hasMore);
    } catch {
      setError("Could not load more documents");
    } finally {
      setIsLoadingMore(false);
    }
  };

  const removeLocal = (documentId: string) => {
    setDocuments((current) => current.filter((d) => d.id !== documentId));
    router.refresh();
  };

  return (
    <DocumentsTable
      documents={documents}
      hasMore={hasMore}
      isLoadingMore={isLoadingMore}
      error={error}
      search={search}
      onLoadMore={() => void loadMore()}
      onMutated={removeLocal}
    />
  );
};
