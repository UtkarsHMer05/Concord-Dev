"use client";

import { useRef, useState } from "react";
import { SearchIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSearchParam } from "@/hooks/use-search-param";

/**
 * Home-page document filter.
 *
 * Two sources of truth, deliberately:
 * - `value` is the raw textbox state, updated per keystroke so typing feels
 *   instant;
 * - `useSearchParam` publishes the committed query into the `search` URL
 *   param (nuqs). The listing server-renders from that param, so a committed
 *   search is shareable and survives back/forward navigation.
 *
 * Committing happens on submit (Enter/Search button), not per keystroke —
 * each commit triggers a server round-trip, and per-keystroke would refetch
 * the whole first page of results on every character.
 */
export const SearchInput = () => {
  const [committedSearch, setCommittedSearch] = useSearchParam();
  const [draft, setDraft] = useState(committedSearch);

  const fieldRef = useRef<HTMLInputElement>(null);

  /** Commit the draft to the URL param and release focus back to the page. */
  const commit = (raw: string) => {
    setCommittedSearch(raw);
    fieldRef.current?.blur();
  };

  const clear = () => {
    setDraft("");
    commit("");
  };

  return (
    <div className="flex-1 flex items-center justify-center min-w-0">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          commit(draft);
        }}
        role="search"
        className="relative max-w-[720px] w-full"
      >
        <label htmlFor="document-search" className="sr-only">
          Search documents by title
        </label>
        <Input
          id="document-search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          ref={fieldRef}
          placeholder="Search"
          type="search"
          className="md:text-base placeholder:text-neutral-800 px-12 sm:px-14 w-full border-none focus-visible:shadow-[0_1px_1px_0_rgba(65,69,73,.3),0_1px_3px_1px_rgba(65,69,73,.15)] bg-[#F0F4F8] rounded-full h-[48px] focus-visible:ring-0 focus:bg-white"
        />
        {/* Magnifier doubles as the visible submit affordance. */}
        <SearchButton />
        {/* Clear control only renders once there is something to clear. */}
        {draft ? <ClearButton onClick={clear} /> : null}
      </form>
    </div>
  );
};

/** Circular ghost button pinned to the field's left edge. */
const SearchButton = () => (
  <Button
    type="submit"
    variant="ghost"
    size="icon"
    aria-label="Search"
    className="absolute left-3 top-1/2 -translate-y-1/2 [&_svg]:size-5 rounded-full"
  >
    <SearchIcon aria-hidden="true" />
  </Button>
);

/** Circular ghost button pinned to the field's right edge. */
const ClearButton = ({ onClick }: { onClick: () => void }) => (
  <Button
    onClick={onClick}
    type="button"
    variant="ghost"
    size="icon"
    aria-label="Clear search"
    className="absolute right-3 top-1/2 -translate-y-1/2 [&_svg]:size-5 rounded-full"
  >
    <XIcon aria-hidden="true" />
  </Button>
);
