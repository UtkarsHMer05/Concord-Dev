import { UnauthenticatedError } from "@/server/errors";
import { buildActorContext } from "@/server/auth/actor-context";
import { documentsService } from "@/server/services/documents";
import { SignInGate } from "@/components/clerk-client-provider";
import type { DocumentListResult } from "@/server/services/documents";

import { DocumentsView } from "./documents-view";
import { Navbar } from "./navbar";
import { TemplatesGallery } from "./templates-gallery";

interface HomePageProps {
  searchParams: Promise<{ search?: string }>;
}

// Page size for the initial server-rendered chunk and each "Load more" step.
const PAGE_SIZE = 5;

const Home = async ({ searchParams }: HomePageProps) => {
  const { search = "" } = await searchParams;

  let initial: DocumentListResult | null = null;
  let unauthenticated = false;
  try {
    const actor = await buildActorContext();
    initial = await documentsService.listDocuments(actor, {
      search,
      page: 1,
      pageSize: PAGE_SIZE,
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      unauthenticated = true;
    } else {
      throw error;
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="fixed top-0 left-0 right-0 z-10 h-16 bg-white p-4">
        <Navbar />
      </div>
      <div className="mt-16">
        {unauthenticated ? (
          <SignInGate />
        ) : (
          <>
            <TemplatesGallery />
            <DocumentsView
              key={search}
              initialDocuments={initial!.documents}
              initialHasMore={initial!.hasMore}
              search={search}
              pageSize={PAGE_SIZE}
            />
          </>
        )}
      </div>
    </div>
  );
};

export default Home;
