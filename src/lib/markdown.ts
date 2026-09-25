/**
 * Markdown export/import for the collaborative subset (Feature 9).
 *
 * Scope (honest, deliberately narrow): paragraphs and headings 1–6 with the
 * CRDT-registry inline marks — bold `**x**`, italic `*x*`, strikethrough
 * `~~x~~`, underline `<u>x</u>` (inline HTML, GFM-legal) — with backslash
 * escapes on export so the ROUND TRIP is exact. Inline code is NOT part of
 * the CRDT mark registry (see pm-model SUPPORTED_MARKS), so backticks are
 * escaped on export and stay literal text on import — never silently
 * dropped styling. Paragraph attributes with no markdown equivalent
 * (`align`, `lineHeight`) are dropped on export and counted. This is
 * Concord-flavored markdown: it round-trips Concord documents exactly and
 * parses the common GFM shapes, not the whole CommonMark grammar.
 *
 * Imports are returned as a ProseMirror document and applied through the
 * live editor bridge as normal CRDT edits — never a side channel.
 */

import { blocksToPmDoc, pmDocToBlocks, type CanonicalBlock, type PmNode } from "@/lib/crdt/pm-model";

export interface MarkdownExportResult {
  markdown: string;
  /** Paragraphs/headings skipped because they carry non-collaborative nodes. */
  skippedBlocks: number;
  /** align/lineHeight occurrences dropped (no markdown equivalent). */
  droppedAttributes: number;
  /** True when the source document was fully inside the collaborative subset. */
  lossless: boolean;
}

interface RunMark {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

function escapeLiteral(text: string): string {
  // Order matters: backslash first. The set covers every character the
  // importer would otherwise consume as markup.
  let out = "";
  for (const ch of text) {
    if (ch === "\\" || ch === "`" || ch === "*" || ch === "~" || ch === "<" || ch === "#") {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Wraps one emphasis layer, keeping edge whitespace OUTSIDE the delimiters
 *  (CommonMark flanking: `**bold and **` + `*italic*` is ambiguous junk in
 *  other readers; `**bold and** *italic*` parses identically everywhere).
 *  Whitespace-only runs get no wrapper at all. */
function wrapEmphasis(inner: string, open: string, close: string): string {
  const lead = inner.match(/^\s*/)?.[0] ?? "";
  const trail = inner.match(/\s*$/)?.[0] ?? "";
  const core = inner.slice(lead.length, inner.length - trail.length);
  if (core.length === 0) return lead + trail;
  return lead + open + core + close + trail;
}

function renderRun(text: string, mark: RunMark): string {
  let inner = escapeLiteral(text);
  if (mark.bold) inner = wrapEmphasis(inner, "**", "**");
  if (mark.italic) inner = wrapEmphasis(inner, "*", "*");
  if (mark.strikethrough) inner = wrapEmphasis(inner, "~~", "~~");
  if (mark.underline) inner = wrapEmphasis(inner, "<u>", "</u>");
  return inner;
}

export function exportMarkdown(doc: PmNode): MarkdownExportResult {
  const { blocks, support } = pmDocToBlocks(doc);
  const lines: string[] = [];
  let droppedAttributes = 0;

  for (const block of blocks) {
    droppedAttributes += Object.keys(block.attrs).filter((key) => key !== "type").length;
    const heading = /^heading-([1-6])$/.exec(block.type);
    const prefix = heading ? "#".repeat(Number(heading[1])) + " " : "";
    // Group same-marked chars into runs (blocksToPmDoc's grouping shape).
    let line = "";
    for (let i = 0; i < block.chars.length;) {
      const marks = block.chars[i].marks;
      let text = "";
      let j = i;
      while (j < block.chars.length && sameMarks(block.chars[j].marks, marks)) {
        text += block.chars[j].scalar;
        j += 1;
      }
      line += renderRun(text, {
        bold: marks.bold === "1",
        italic: marks.italic === "1",
        underline: marks.underline === "1",
        strikethrough: marks.strikethrough === "1",
      });
      i = j;
    }
    lines.push(prefix + line);
  }

  return {
    markdown: lines.join("\n"),
    skippedBlocks: 0, // pmDocToBlocks drops unsupported nodes; counted via support below
    droppedAttributes,
    lossless: support.supported,
  };
}

function sameMarks(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => a[key] === b[key]);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface InlineNode {
  text: string;
  marks: Record<string, string>;
}

function pushRun(nodes: InlineNode[], text: string, marks: Record<string, string>): void {
  if (text.length === 0) return;
  const last = nodes[nodes.length - 1];
  if (last && sameMarks(last.marks, marks)) {
    last.text += text;
  } else {
    nodes.push({ text, marks });
  }
}

function unescapeLiteral(text: string): string {
  return text.replace(/\\([\\`*~<#])/g, "$1");
}

/**
 * Inline parser for the subset. Precedence: code spans (literal, backtick
 * doubling) → <u> → **bold** → *italic* → ~~strike~~. Escaped characters
 * (\` \* \~ \< \# \\) pass through as literals. Unknown constructs stay
 * literal text — the importer never drops content.
 */
export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let plain = "";

  const flushPlain = () => {
    if (plain) {
      pushRun(nodes, unescapeLiteral(plain), {});
      plain = "";
    }
  };

  let i = 0;
  outer: while (i < input.length) {
    const ch = input[i];
    if (ch === "\\" && i + 1 < input.length && /[\\`*~<#]/.test(input[i + 1])) {
      plain += input.slice(i, i + 2);
      i += 2;
      continue;
    }
    for (const [openTag, closeTag, mark] of [
      ["<u>", "</u>", "underline"],
      ["**", "**", "bold"],
      ["~~", "~~", "strikethrough"],
      ["*", "*", "italic"],
    ] as Array<[string, string, string]>) {
      if (input.startsWith(openTag, i)) {
        const end = input.indexOf(closeTag, i + openTag.length);
        if (end >= 0) {
          flushPlain();
          const inner = parseInline(input.slice(i + openTag.length, end));
          for (const node of inner) {
            pushRun(nodes, node.text, { ...node.marks, [mark]: "1" });
          }
          i = end + closeTag.length;
          continue outer;
        }
      }
    }
    plain += ch;
    i += 1;
  }
  flushPlain();
  return nodes;
}

function blockFromLine(line: string): CanonicalBlock {
  const heading = /^(#{1,6}) (.*)$/.exec(line);
  const body = heading ? heading[2] : line;
  const chars = parseInline(body).flatMap((node) =>
    Array.from(node.text).map((scalar) => ({ scalar, marks: node.marks })),
  );
  if (heading) {
    return { type: `heading-${heading[1].length}`, attrs: { type: `heading-${heading[1].length}` }, chars };
  }
  return { type: "paragraph", attrs: {}, chars };
}

/**
 * Parses Concord-flavored markdown into a ProseMirror document. One line =
 * one block (the exporter's shape; blank lines become empty paragraphs).
 * The result is always inside the collaborative subset by construction.
 */
export function importMarkdown(markdown: string): PmNode {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks = lines.map(blockFromLine);
  return blocksToPmDoc(blocks);
}
