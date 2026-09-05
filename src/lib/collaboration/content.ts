/**
 * TRANSITIONAL (Phase 0) content envelope helpers.
 *
 * Durable editor content is stored as a versioned JSON string
 * (`{ v: 1, doc: <TipTap JSON> }`). Documents created before a first save may
 * only carry the template's initial HTML content.
 */

export interface StoredContentEnvelope {
  v: number;
  doc: unknown;
}

export function serializeDocumentContent(doc: unknown): string {
  return JSON.stringify({ v: 1, doc });
}

export function parseDocumentContent(
  raw: string | undefined | null,
  fallback: unknown = null,
): unknown {
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredContentEnvelope>;
    if (parsed && parsed.v === 1 && "doc" in parsed) {
      return parsed.doc;
    }
    return fallback;
  } catch {
    return fallback;
  }
}
