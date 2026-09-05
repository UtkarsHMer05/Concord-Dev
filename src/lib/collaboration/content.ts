/**
 * TRANSITIONAL (Phase 1) content envelope helpers.
 *
 * Durable editor content is stored in PostgreSQL as a versioned JSONB
 * envelope (`{ v: 1, doc: <TipTap JSON> }`). Documents created before a first
 * save may only carry the template's initial HTML content. Historical
 * string-encoded envelopes (Phase 0, Convex) are still parsed for parity.
 */

export interface StoredContentEnvelope {
  v: number;
  doc: unknown;
}

export function serializeDocumentContent(doc: unknown): string {
  return JSON.stringify({ v: 1, doc });
}

function isEnvelope(value: unknown): value is StoredContentEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "v" in value &&
    "doc" in value &&
    (value as { v: unknown }).v === 1
  );
}

export function parseDocumentContent(
  raw: unknown,
  fallback: unknown = null,
): unknown {
  if (raw === null || raw === undefined) {
    return fallback;
  }
  // JSONB rows arrive as objects.
  if (typeof raw === "object") {
    return isEnvelope(raw) ? raw.doc : fallback;
  }
  // Legacy string-encoded envelope (Phase 0 rows), kept for parity.
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isEnvelope(parsed)) {
        return parsed.doc;
      }
    } catch {
      // Not JSON — fall through.
    }
  }
  return fallback;
}
