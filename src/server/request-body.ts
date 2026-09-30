/** Bounds chunked bodies as well as declared lengths before JSON parsing. */
export async function readJsonRequest(request: Request, limit: number): Promise<unknown | Response> {
  const error = (status: number, code: string) => Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return error(415, "content_type_required");
  if (Number(request.headers.get("content-length")) > limit) return error(413, "request_too_large");
  const reader = request.body?.getReader();
  if (!reader) return error(400, "invalid_request");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) { await reader.cancel(); return error(413, "request_too_large"); }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return error(400, "invalid_json"); }
}
