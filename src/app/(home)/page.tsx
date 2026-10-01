import Link from "next/link";
import { UnauthenticatedError } from "@/server/errors";
import { buildActorContext } from "@/server/auth/actor-context";
import { documentsService } from "@/server/services/documents";
import { SignInGate } from "@/components/clerk-client-provider";
import type { DocumentListResult } from "@/server/services/documents";

import { DocumentsView } from "./documents-view";
import { Navbar } from "./navbar";
import { TemplatesGallery } from "./templates-gallery";

interface HomePageProps {
  searchParams: Promise<{ search?: string; scope?: string }>;
}

// Page size for the initial server-rendered chunk and each "Load more" step.
const PAGE_SIZE = 5;

const Home = async ({ searchParams }: HomePageProps) => {
  const { search = "", scope: requestedScope } = await searchParams;
  const scope = requestedScope === "shared" ? "shared" : "workspace";

  let initial: DocumentListResult | null = null;
  let unauthenticated = false;
  try {
    const actor = await buildActorContext();
    initial = await documentsService.listDocuments(actor, {
      search,
      scope,
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
            <div className="mx-auto max-w-screen-xl px-4 pt-6 md:px-16">
              <nav aria-label="Document collections" className="flex gap-6 border-b">
                {[{ scope: "workspace", label: "My workspace" }, { scope: "shared", label: "Shared with me" }].map((item) => <Link key={item.scope} href={`/?${new URLSearchParams({ scope: item.scope, ...(search ? { search } : {}) })}`} aria-current={scope === item.scope ? "page" : undefined} className="border-b-2 border-transparent pb-3 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:border-primary aria-[current=page]:font-medium aria-[current=page]:text-foreground">{item.label}</Link>)}
              </nav>
              <div className="flex flex-wrap items-start justify-between gap-2 pt-5">
                <div><h1 className="text-xl font-semibold">{scope === "shared" ? "Shared with me" : "Workspace documents"}</h1><p className="mt-1 text-sm text-muted-foreground">{scope === "shared" ? "Documents people have invited you to. Your role appears beside each title." : "Your documents in the current personal or organization workspace."}</p></div>
              </div>
            </div>
            <DocumentsView
              key={`${scope}:${search}`}
              scope={scope}
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
