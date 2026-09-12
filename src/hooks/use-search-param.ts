import { parseAsString, useQueryState } from "nuqs";

/**
 * Document-table search box state, shared between the input and the
 * listing so typing filters rows without a server round-trip per key.
 * The value lives in the `search` URL param (nuqs): a back/forward or
 * shared link restores the exact filter view. An empty value clears
 * the param rather than writing `?search=` (clearOnDefault).
 */
export function useSearchParam() {
  return useQueryState(
    "search",
    parseAsString.withDefault("").withOptions({ clearOnDefault: true }),
  );
}
