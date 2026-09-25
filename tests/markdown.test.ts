import { describe, expect, it } from "vitest";

import type { PmNode } from "@/lib/crdt/pm-model";
import { exportMarkdown, importMarkdown, parseInline } from "@/lib/markdown";

const para = (text: string, marks?: Array<{ type: string }>): PmNode => ({
  type: "paragraph",
  // blocksToPmDoc always emits attrs/marks (empty objects included); the
  // round-trip deep-equal compares against that exact shape.
  attrs: {},
  content: [{ type: "text", text, marks: marks ?? [] }],
});

const docOf = (...content: PmNode[]): PmNode => ({ type: "doc", content });

describe("markdown export (Feature 9)", () => {
  it("exports headings, paragraphs, and marks with escaping and clean flanking", () => {
    const doc = docOf(
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Section" }] },
      para("plain words"),
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bold", marks: [{ type: "bold" }] },
          { type: "text", text: " and " },
          { type: "text", text: "italic", marks: [{ type: "italic" }] },
        ],
      },
      // A marked run ENDING in whitespace: the space moves outside the
      // delimiter (CommonMark flanking) so any reader parses it the same.
      {
        type: "paragraph",
        content: [
          { type: "text", text: "bold and ", marks: [{ type: "bold" }] },
          { type: "text", text: "italic", marks: [{ type: "italic" }] },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "under", marks: [{ type: "underline" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "struck", marks: [{ type: "strikethrough" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "literal *not* `markup`" }] },
    );
    const result = exportMarkdown(doc);
    expect(result.lossless).toBe(true);
    expect(result.markdown).toBe(
      [
        "# Title",
        "### Section",
        "plain words",
        "**bold** and *italic*",
        "**bold and** *italic*",
        "<u>under</u>",
        "~~struck~~",
        "literal \\*not\\* \\`markup\\`",
      ].join("\n"),
    );
  });

  it("counts dropped paragraph attributes honestly", () => {
    const doc = docOf({
      type: "paragraph",
      attrs: { textAlign: "center" },
      content: [{ type: "text", text: "centered" }],
    });
    const result = exportMarkdown(doc);
    expect(result.droppedAttributes).toBe(1);
    expect(result.markdown).toBe("centered");
  });

  it("flags documents with non-collaborative nodes as lossy", () => {
    const doc = docOf(para("kept"), { type: "image", attrs: { src: "x.png" } } as unknown as PmNode);
    const result = exportMarkdown(doc);
    expect(result.lossless).toBe(false);
    expect(result.markdown).toContain("kept");
  });
});

describe("markdown import (Feature 9)", () => {
  it("parses headings and the inline subset back into PM blocks", () => {
    const doc = importMarkdown(["# Title", "", "plain **bold** and *italic*", "~~struck~~ <u>under</u>"].join("\n"));
    expect(doc.content).toHaveLength(4);
    expect(doc.content?.[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
    const runs = doc.content?.[2]?.content ?? [];
    expect(runs).toEqual([
      { type: "text", text: "plain ", marks: [] },
      { type: "text", text: "bold", marks: [{ type: "bold" }] },
      { type: "text", text: " and ", marks: [] },
      { type: "text", text: "italic", marks: [{ type: "italic" }] },
    ]);
    const struck = doc.content?.[3]?.content ?? [];
    expect(struck).toContainEqual({ type: "text", text: "struck", marks: [{ type: "strikethrough" }] });
    expect(struck).toContainEqual({ type: "text", text: "under", marks: [{ type: "underline" }] });
  });

  it("round-trips an exported document exactly (stable export fixed point)", () => {
    const original = docOf(
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Report", marks: [] }],
      },
      para("a **bold** *italic* ~~strike~~ <u>underline</u> mix"),
      para("escapes: \\` \\* \\~ \\< \\# \\\\ stay literal"),
      {
        type: "paragraph",
        attrs: {},
        content: [
          { type: "text", text: "before", marks: [{ type: "bold" }] },
          { type: "text", text: " after", marks: [] },
        ],
      },
    );
    const exported = exportMarkdown(original);
    const reimported = importMarkdown(exported.markdown);
    // Export is a fixed point over the import: the second export is byte-
    // identical (the meaningful losslessness guarantee for boundary spaces).
    expect(exportMarkdown(reimported).markdown).toBe(exported.markdown);
    // And without edge-whitespace runs, the block stream is EXACTLY equal.
    expect(reimported).toEqual(original);
  });

  it("keeps unknown constructs as literal text (never drops content)", () => {
    const nodes = parseInline("a [link](http://x) and _underscore_ stay literal");
    expect(nodes.map((n) => n.text).join("")).toBe("a [link](http://x) and _underscore_ stay literal");
  });

  it("normalizes CRLF and treats every line as a block", () => {
    const doc = importMarkdown("one\r\ntwo\r\n\r\nthree");
    expect(doc.content).toHaveLength(4);
    expect(doc.content?.[1]?.content?.[0]?.text).toBe("two");
    expect(doc.content?.[2]?.content).toHaveLength(0);
  });
});
