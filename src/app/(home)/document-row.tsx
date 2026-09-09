"use client";

import { format } from "date-fns";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SiGoogledocs } from "react-icons/si";
import { Building2Icon, CircleUserIcon } from "lucide-react";

import { TableCell, TableRow } from "@/components/ui/table";

import type { DocumentSummaryDto } from "@/server/services/documents";

import { DocumentMenu } from "./document-menu";

interface DocumentRowProps {
  document: DocumentSummaryDto;
  onRemoved: (documentId: string) => void;
};

export const DocumentRow = ({ document, onRemoved }: DocumentRowProps) => {
  const router = useRouter();

  return (
    <TableRow
      onClick={() => router.push(`/documents/${document.id}`)}
      className="cursor-pointer"
    >
      <TableCell className="w-[50px]">
        <SiGoogledocs className="size-6 fill-blue-500" aria-hidden="true" />
      </TableCell>
      <TableCell className="font-medium md:w-[45%]">
        <Link
          href={`/documents/${document.id}`}
          className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm px-1 -mx-1"
          onClick={(e) => e.stopPropagation()}
        >
          {document.title}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground hidden md:flex items-center gap-2">
        {document.organizationId
          ? <Building2Icon className="size-4" aria-hidden="true" />
          : <CircleUserIcon className="size-4" aria-hidden="true" />
        }
        {document.organizationId ? "Organization" : "Personal"}
      </TableCell>
      <TableCell className="text-muted-foreground hidden md:table-cell">
        <time dateTime={document.createdAt}>
          {format(new Date(document.createdAt), "MMM dd, yyyy")}
        </time>
      </TableCell>
      <TableCell className="flex justify-end">
        <DocumentMenu
          documentId={document.id}
          title={document.title}
          metadataVersion={document.metadataVersion}
          onNewTab={() => window.open(`/documents/${document.id}`, "_blank")}
          onRemoved={onRemoved}
        />
      </TableCell>
    </TableRow>
  )
}
