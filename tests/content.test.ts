import { describe, expect, it } from "vitest";

import {
  parseDocumentContent,
  serializeDocumentContent,
} from "../src/lib/collaboration/content";

describe("transitional document content envelope", () => {
  it("round-trips TipTap JSON through the versioned envelope", () => {
    const doc = { type: "doc", content: [{ type: "paragraph" }] };
    const stored = serializeDocumentContent(doc);
    expect(parseDocumentContent(stored)).toEqual(doc);
  });

  it("returns the fallback for undefined or empty stored content", () => {
    const fallback = { type: "doc" };
    expect(parseDocumentContent(undefined, fallback)).toBe(fallback);
    expect(parseDocumentContent(null, fallback)).toBe(fallback);
    expect(parseDocumentContent("", fallback)).toBe(fallback);
  });

  it("passes unsaved template HTML to TipTap when no JSON envelope exists", () => {
    const template = "<h1>Proposal</h1><p>Summary</p>";
    expect(parseDocumentContent(null, template)).toBe(template);
  });

  it("returns the fallback for malformed JSON instead of throwing", () => {
    const fallback = null;
    expect(parseDocumentContent("{not json", fallback)).toBe(fallback);
  });

  it("returns the fallback for envelopes with an unknown version", () => {
    expect(parseDocumentContent(JSON.stringify({ v: 99, doc: {} }))).toBe(null);
  });
});
