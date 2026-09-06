// ProseMirror document model ⇄ canonical CRDT blocks (P2-M038).
//
// Pure data transformation — the adapter maps TipTap's JSON document to the
// collaborative block subset (paragraph / heading-1..6 with text and the
// marks bold/italic/underline/strikethrough). Documents containing
// unsupported nodes (images, tables, lists, …) are detected and reported so
// callers can fall back to the Phase 1 persistence path instead of silently
// corrupting content (M038/M041 honesty rules).

export const SUPPORTED_MARKS = new Set(["bold", "italic", "underline", "strikethrough"]);

export interface PmMark {
    type: string;
    attrs?: Record<string, unknown>;
}

export interface PmNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: PmNode[];
    text?: string;
    marks?: PmMark[];
}

export interface CanonicalChar {
    scalar: string; // single code point as a JS string
    marks: Record<string, string>;
}

export interface CanonicalBlock {
    type: string;
    attrs: Record<string, string>;
    chars: CanonicalChar[];
}

/** The adapter's supported feature set. */
export interface DocSupport {
    supported: boolean;
    unsupportedTypes: string[];
}

function marks_of(pmMarks: PmMark[] | undefined): Record<string, string> {
    const marks: Record<string, string> = {};
    for (const mark of pmMarks ?? []) {
        if (SUPPORTED_MARKS.has(mark.type)) {
            marks[mark.type] = "1";
        }
    }
    return marks;
}

/** Extracts the canonical blocks from a ProseMirror JSON document. */
export function pmDocToBlocks(doc: PmNode): { blocks: CanonicalBlock[]; support: DocSupport } {
    const unsupportedTypes: string[] = [];
    const blocks: CanonicalBlock[] = [];

    const walkText = (nodes: PmNode[] | undefined, chars: CanonicalChar[]): void => {
        for (const node of nodes ?? []) {
            if (node.type === "text") {
                const marks = marks_of(node.marks);
                for (const ch of node.text ?? "") {
                    chars.push({ scalar: ch, marks });
                }
            } else if (node.type === "hardBreak") {
                // Hard breaks inside a paragraph degrade to a space in the
                // collaborative subset; the original node stays in the PM doc
                // (non-collaborative fallback preserves it fully).
                unsupportedTypes.push("hardBreak");
                chars.push({ scalar: " ", marks: {} });
            } else {
                unsupportedTypes.push(node.type);
            }
        }
    };

    for (const node of doc.content ?? []) {
        if (node.type === "paragraph" || node.type.startsWith("heading")) {
            const block: CanonicalBlock = { type: "paragraph", attrs: {}, chars: [] };
            // Canonical block type follows the PROTOCOL registry
            // (paragraph | heading-1..6) — block.type IS attrs["type"].
            if (node.type.startsWith("heading")) {
                const level = (node.attrs?.level as number | undefined) ?? 1;
                block.attrs["type"] = `heading-${level}`;
                block.type = `heading-${level}`;
            }
            const align = node.attrs?.textAlign;
            if (typeof align === "string" && align !== "left") {
                block.attrs["align"] = align;
            }
            const lineHeight = node.attrs?.lineHeight;
            if (typeof lineHeight === "string" && lineHeight !== "normal") {
                block.attrs["lineHeight"] = lineHeight;
            }
            walkText(node.content, block.chars);
            blocks.push(block);
        } else {
            unsupportedTypes.push(node.type);
        }
    }

    // Validate block types are in the supported registry.
    for (const block of blocks) {
        const allowed =
            block.type === "paragraph" || /^heading-[1-6]$/.test(block.type);
        if (!allowed) {
            unsupportedTypes.push(block.type);
        }
        for (const name of Object.keys(block.attrs)) {
            if (name !== "type" && name !== "align" && name !== "lineHeight") {
                unsupportedTypes.push(`attr:${name}`);
            }
        }
    }

    return { blocks, support: { supported: unsupportedTypes.length === 0, unsupportedTypes } };
}

/** Builds a ProseMirror JSON document from canonical blocks. */
export function blocksToPmDoc(blocks: CanonicalBlock[]): PmNode {
    const content: PmNode[] = [];
    // The first canonical block is the implicit root block — skip its
    // delimiter (there is none in the stream; blocks[0] IS the root).
    for (const block of blocks) {
        const node: PmNode = {
            type: block.type.startsWith("heading") ? "heading" : "paragraph",
            attrs: {},
            content: [],
        };
        if (block.type.startsWith("heading")) {
            node.attrs = {
                level: Number.parseInt(block.type.replace("heading-", ""), 10),
                ...(block.attrs["align"] !== undefined ? { textAlign: block.attrs["align"] } : {}),
                ...(block.attrs["lineHeight"] !== undefined
                    ? { lineHeight: block.attrs["lineHeight"] }
                    : {}),
            };
        } else if (Object.keys(block.attrs).length > 0) {
            node.attrs = { ...block.attrs };
        }
        // Group runs of same-marked chars into text nodes.
        for (let i = 0; i < block.chars.length;) {
            const marks = block.chars[i].marks;
            let text = "";
            let j = i;
            while (j < block.chars.length && sameMarks(block.chars[j].marks, marks)) {
                text += block.chars[j].scalar;
                ++j;
            }
            node.content!.push({
                type: "text",
                text,
                marks: Object.keys(marks).map((type) => ({ type })),
            });
            i = j;
        }
        content.push(node);
    }
    return { type: "doc", content };
}

function sameMarks(a: Record<string, string>, b: Record<string, string>): boolean {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) {
        return false;
    }
    return ka.every((key) => a[key] === b[key]);
}
