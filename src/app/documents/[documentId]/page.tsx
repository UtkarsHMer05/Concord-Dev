import { notFound, redirect } from "next/navigation";

import { buildActorContext } from "@/server/auth/actor-context";
import { UnauthenticatedError } from "@/server/errors";
import { documentsService } from "@/server/services/documents";
import type { DocumentDetailDto } from "@/server/services/documents";

import { Document } from "./document";

interface DocumentIdPageProps {
  params: Promise<{ documentId: string }>;
};

const DocumentIdPage = async ({ params }: DocumentIdPageProps) => {
  const { documentId } = await params;

  let document: DocumentDetailDto;
  try {
    const actor = await buildActorContext();
    document = await documentsService.getDocument(actor, documentId);
  } catch (error) {
    // Validation failures (malformed ids) and denials are indistinguishable
    // from missing documents — render the 404 page without leaking why.
    if (error instanceof UnauthenticatedError) {
      redirect("/");
    }
    notFound();
  }

  return <Document document={document} />;
};

export default DocumentIdPage;
