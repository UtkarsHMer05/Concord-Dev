"use client";

import { format } from "date-fns";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SiGoogledocs } from "react-icons/si";
import { Building2Icon, CircleUserIcon } from "lucide-react";

import { TableCell, TableRow } from "@/components/ui/table";

import type { DocumentSummaryDto } from "@/server/services/documents";

import { DocumentMenu } from "./document-menu";

/**
 * One row in the home document listing.
 *
 * Navigation is offered twice on purpose: the whole row is clickable for
 * the fast path, while the title link is a *real* link so middle-click /
 * copy-link / screen readers get a semantic target. The link stops the row
 * click from double-firing the router push.
 */
interface DocumentRowProps {
  document: DocumentSummaryDto;
  onRemoved: (documentId: string) => void;
};

/** Date format used across the listing column. */
const CREATED_AT_FORMAT = "MMM dd, yyyy";

/** Scope badge shown for org-owned vs. personal documents. */
const scopeBadge = (organizationId: string | null | undefined) =>
  organizationId
    ? { Icon: Building2Icon, text: "Organization" }
    : { Icon: CircleUserIcon, text: "Personal" };

export const DocumentRow = ({ document, onRemoved }: DocumentRowProps) => {
  const router = useRouter();
  const openDocument = () => router.push(`/documents/${document.id}`);
  const { Icon: ScopeIcon, text: scopeText } = scopeBadge(document.organizationId);
  const href = `/documents/${document.id}`;

  return (
    <TableRow onClick={openDocument} className="cursor-pointer">
      <TableCell className="w-[50px]">
        <SiGoogledocs className="size-6 fill-blue-500" aria-hidden="true" />
      </TableCell>
      <TableCell className="font-medium md:w-[45%]">
        <Link
          href={href}
          className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm px-1 -mx-1"
          onClick={(event) => event.stopPropagation()}
        >
          {document.title}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground hidden md:flex items-center gap-2">
        <ScopeIcon className="size-4" aria-hidden="true" />
        {scopeText}
      </TableCell>
      <TableCell className="text-muted-foreground hidden md:table-cell">
        {/* machine-readable timestamp for the semantic <time> element */}
        <time dateTime={document.createdAt}>
          {format(new Date(document.createdAt), CREATED_AT_FORMAT)}
        </time>
      </TableCell>
      <TableCell className="flex justify-end">
        <DocumentMenu
          documentId={document.id}
          title={document.title}
          metadataVersion={document.metadataVersion}
          onNewTab={(id) => window.open(`/documents/${id}`, "_blank")}
          onRemoved={onRemoved}
        />
      </TableCell>
    </TableRow>
  );
};
