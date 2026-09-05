"use server";

import { revalidatePath } from "next/cache";

import { buildActorContext } from "@/server/auth/actor-context";
import { documentsService } from "@/server/services/documents";
import { fail, ok, type ActionResult } from "@/server/result";

/**
 * Document server actions — the low-frequency mutation boundary.
 *
 * Every action builds a verified ActorContext (unauthenticated requests
 * fail), delegates policy to the documents service, and returns a typed,
 * client-safe result. Input payloads can never influence ownership,
 * organization scope, or authorization.
 */

export interface CreateDocumentInput {
  title?: string;
  initialContent?: string | null;
}

export async function createDocumentAction(
  input: CreateDocumentInput = {},
): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await buildActorContext();
    const result = await documentsService.createDocument(actor, input);
    revalidatePath("/");
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export interface RenameDocumentInput {
  documentId: string;
  title: string;
  expectedMetadataVersion: number;
}

export async function renameDocumentAction(
  input: RenameDocumentInput,
): Promise<ActionResult<{ metadataVersion: number }>> {
  try {
    const actor = await buildActorContext();
    const result = await documentsService.renameDocument(
      actor,
      input.documentId,
      {
        title: input.title,
        expectedMetadataVersion: input.expectedMetadataVersion,
      },
    );
    revalidatePath("/");
    return ok(result);
  } catch (error) {
    return fail(error);
  }
}

export interface DeleteDocumentInput {
  documentId: string;
}

export async function deleteDocumentAction(
  input: DeleteDocumentInput,
): Promise<ActionResult<{ deleted: true }>> {
  try {
    const actor = await buildActorContext();
    await documentsService.deleteDocument(actor, input.documentId);
    revalidatePath("/");
    return ok({ deleted: true });
  } catch (error) {
    return fail(error);
  }
}
