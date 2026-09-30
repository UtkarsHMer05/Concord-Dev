// TipTap JSON ⇄ flat CRDT blocks. Structure lives on delimiters; marks on text IDs.
export const RICH_TEXT_CAPABILITY = "rich-text-v2";
export const MAX_LIST_DEPTH = 8;
export const SUPPORTED_MARKS = new Set(["bold", "italic", "underline", "strikethrough", "strike", "code", "link", "textStyle", "highlight"]);
export interface PmMark { type: string; attrs?: Record<string, unknown> }
export interface PmNode { type: string; attrs?: Record<string, unknown>; content?: PmNode[]; text?: string; marks?: PmMark[] }
export interface CanonicalChar { scalar: string; marks: Record<string, string> }
export interface CanonicalBlock { type: string; attrs: Record<string, string>; chars: CanonicalChar[] }
export interface DocSupport { supported: boolean; unsupportedTypes: string[] }
const LIST_TYPES: Record<string, string> = { bulletList: "bullet", orderedList: "ordered", taskList: "task" };
const TEXT_STYLE = ["color", "fontFamily", "fontSize"];

/** Same bounded value registry as the native engine. Unknown data fails closed. */
export function validRichTextValue(name: string, value: string): boolean {
    if (!value || new TextEncoder().encode(value).length > 256 || /[\x00-\x1f\x7f]/.test(value)) return false;
    if (["bold", "italic", "underline", "strikethrough", "code"].includes(name)) return value === "1";
    if (name === "link") return /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i.test(value) && !/[\s<>\\]/.test(value);
    if (name === "linkTarget") return ["_blank", "_self", "_parent", "_top"].includes(value);
    if (name === "linkRel") return /^(noopener|noreferrer|nofollow)( (noopener|noreferrer|nofollow))*$/.test(value);
    if (name === "fontSize") return /^[1-9]\d{0,2}(?:\.\d{1,2})?px$/.test(value) && parseFloat(value) <= 400;
    if (name === "fontFamily") return /^[a-zA-Z0-9 ,'"-]+$/.test(value);
    if (name === "color" || name === "highlight") return /^[a-zA-Z0-9#(),.% -]+$/.test(value);
    if (name === "type" || name === "contentType") return value === "paragraph" || /^heading-[1-6]$/.test(value) || (name === "type" && ["list-item", "list-continuation"].includes(value));
    if (name === "align") return ["left", "center", "right", "justify"].includes(value);
    if (name === "lineHeight") return ["normal", "1", "1.15", "1.5", "2"].includes(value);
    if (name === "list") return ["bullet", "ordered", "task"].includes(value);
    if (name === "depth") return /^[0-8]$/.test(value);
    if (name === "checked") return ["yes", "no"].includes(value);
    if (name === "listStart") return /^[1-9]\d{0,5}$/.test(value);
    return false;
}

export function pmDocToBlocks(doc: PmNode): { blocks: CanonicalBlock[]; support: DocSupport } {
    const unsupported = new Set<string>();
    const blocks: CanonicalBlock[] = [];
    const put = (attrs: Record<string, string>, name: string, value: unknown) => {
        if (value == null) return;
        const text = String(value);
        if (validRichTextValue(name, text)) attrs[name] = text;
        else unsupported.add(`attr:${name}`);
    };
    const checkAttrs = (attrs: Record<string, unknown> | undefined, allowed: string[]) => {
        for (const [name, value] of Object.entries(attrs ?? {})) {
            if (value != null && !allowed.includes(name)) unsupported.add(`attr:${name}`);
        }
    };
    const marksOf = (pmMarks: PmMark[] | undefined): Record<string, string> => {
        const marks: Record<string, string> = {};
        for (const mark of pmMarks ?? []) {
            if (["bold", "italic", "underline", "strikethrough", "strike", "code"].includes(mark.type)) {
                checkAttrs(mark.attrs, []);
                marks[mark.type === "strike" ? "strikethrough" : mark.type] = "1";
            } else if (mark.type === "textStyle") {
                checkAttrs(mark.attrs, TEXT_STYLE);
                for (const name of TEXT_STYLE) put(marks, name, mark.attrs?.[name]);
            } else if (mark.type === "link") {
                checkAttrs(mark.attrs, ["href", "target", "rel", "class"]);
                put(marks, "link", mark.attrs?.href);
                put(marks, "linkTarget", mark.attrs?.target);
                put(marks, "linkRel", mark.attrs?.rel);
                if (mark.attrs?.class != null) unsupported.add("attr:link.class");
                if (!marks.link) unsupported.add("attr:link.href");
            } else if (mark.type === "highlight") {
                checkAttrs(mark.attrs, ["color"]);
                put(marks, "highlight", mark.attrs?.color ?? "1");
            } else unsupported.add(`mark:${mark.type}`);
        }
        return marks;
    };
    const addTextBlock = (node: PmNode, structural: Record<string, string> = {}, continuation = false) => {
        if (node.type !== "paragraph" && node.type !== "heading") { unsupported.add(node.type); return; }
        const type = node.type === "heading" ? `heading-${node.attrs?.level ?? 1}` : "paragraph";
        const block: CanonicalBlock = { type: structural.list ? continuation ? "list-continuation" : "list-item" : type, attrs: {}, chars: [] };
        if (block.type !== "paragraph") put(block.attrs, "type", block.type);
        if (structural.list) {
            Object.assign(block.attrs, structural);
            if (type !== "paragraph") put(block.attrs, "contentType", type);
        }
        if (!validRichTextValue("contentType", type)) unsupported.add(type);
        checkAttrs(node.attrs, node.type === "heading" ? ["level", "textAlign", "lineHeight"] : ["textAlign", "lineHeight"]);
        if (node.attrs?.textAlign && node.attrs.textAlign !== "left") put(block.attrs, "align", node.attrs.textAlign);
        if (node.attrs?.lineHeight && node.attrs.lineHeight !== "normal") put(block.attrs, "lineHeight", node.attrs.lineHeight);
        for (const child of node.content ?? []) {
            checkAttrs(child.attrs, []);
            if (child.type === "text") {
                const marks = marksOf(child.marks);
                for (const scalar of child.text ?? "") block.chars.push({ scalar, marks });
            } else if (child.type === "hardBreak") block.chars.push({ scalar: "\n", marks: marksOf(child.marks) });
            else unsupported.add(child.type);
        }
        blocks.push(block);
    };
    const walkList = (list: PmNode, depth: number) => {
        if (depth > MAX_LIST_DEPTH) { unsupported.add("list-depth"); return; }
        checkAttrs(list.attrs, list.type === "orderedList" ? ["start", "type"] : []);
        if (list.attrs?.type != null) unsupported.add("attr:orderedList.type");
        for (const item of list.content ?? []) {
            if (item.type !== (list.type === "taskList" ? "taskItem" : "listItem")) { unsupported.add(item.type); continue; }
            checkAttrs(item.attrs, list.type === "taskList" ? ["checked"] : []);
            if (item.attrs?.checked != null && typeof item.attrs.checked !== "boolean") unsupported.add("attr:checked");
            const attrs: Record<string, string> = { list: LIST_TYPES[list.type], depth: String(depth) };
            if (list.type === "taskList") attrs.checked = item.attrs?.checked === true ? "yes" : "no";
            if (list.type === "orderedList" && list.attrs?.start != null && list.attrs.start !== 1) put(attrs, "listStart", list.attrs.start);
            let first = true;
            for (const child of item.content ?? []) {
                if (LIST_TYPES[child.type]) walkList(child, depth + 1);
                else { addTextBlock(child, attrs, !first); first = false; }
            }
            if (first) unsupported.add("empty-list-item");
        }
    };
    if (doc.type !== "doc") unsupported.add(doc.type);
    checkAttrs(doc.attrs, []);
    for (const node of doc.content ?? []) {
        if (LIST_TYPES[node.type]) walkList(node, 0);
        else addTextBlock(node);
    }
    return { blocks, support: { supported: unsupported.size === 0, unsupportedTypes: [...unsupported] } };
}

function pmMarks(marks: Record<string, string>): PmMark[] {
    const result: PmMark[] = [];
    for (const type of ["bold", "italic", "underline", "strikethrough", "code"]) {
        if (marks[type]) result.push({ type: type === "strikethrough" ? "strike" : type });
    }
    const attrs = Object.fromEntries(TEXT_STYLE.filter((name) => marks[name] !== undefined).map((name) => [name, marks[name]]));
    if (Object.keys(attrs).length) result.push({ type: "textStyle", attrs });
    if (marks.link) result.push({ type: "link", attrs: { href: marks.link, target: marks.linkTarget ?? null, rel: marks.linkRel ?? null, class: null } });
    if (marks.highlight) result.push({ type: "highlight", attrs: { color: marks.highlight === "1" ? null : marks.highlight } });
    return result;
}

function textNode(block: CanonicalBlock): PmNode {
    const type = block.attrs.contentType ?? block.type;
    const node: PmNode = { type: type.startsWith("heading-") ? "heading" : "paragraph", attrs: {}, content: [] };
    if (type.startsWith("heading-")) node.attrs!.level = Number(type.slice(8));
    if (block.attrs.align !== undefined) node.attrs!.textAlign = block.attrs.align;
    if (block.attrs.lineHeight !== undefined) node.attrs!.lineHeight = block.attrs.lineHeight;
    for (const ch of block.chars) {
        const marks = pmMarks(ch.marks);
        const last = node.content!.at(-1);
        if (ch.scalar === "\n") node.content!.push({ type: "hardBreak", marks });
        else if (last?.type === "text" && JSON.stringify(last.marks) === JSON.stringify(marks)) last.text += ch.scalar;
        else node.content!.push({ type: "text", text: ch.scalar, marks });
    }
    return node;
}

/** Orphaned/depth-jumping children are promoted to the nearest live parent.
 * Projection changes no CRDT registers and never hides their text. */
export function blocksToPmDoc(blocks: CanonicalBlock[]): PmNode {
    const content: PmNode[] = [];
    const stack: Array<{ list: PmNode; item: PmNode | null; signature: string }> = [];
    for (const block of blocks) {
        if (block.type !== "list-item" && block.type !== "list-continuation") { stack.length = 0; content.push(textNode(block)); continue; }
        const requested = Math.max(0, Math.min(MAX_LIST_DEPTH, Number(block.attrs.depth) || 0));
        const depth = Math.min(requested, stack.length);
        const listType = block.attrs.list === "task" ? "taskList" : block.attrs.list === "ordered" ? "orderedList" : "bulletList";
        const signature = `${listType}:${block.attrs.listStart ?? "1"}`;
        stack.length = Math.min(stack.length, depth + 1);
        if (stack[depth]?.signature !== signature) {
            const list: PmNode = { type: listType, content: [], ...(listType === "orderedList" ? { attrs: { start: Number(block.attrs.listStart ?? 1) } } : {}) };
            const parent = depth > 0 ? stack[depth - 1].item!.content! : content;
            parent.push(list);
            stack[depth] = { list, item: null, signature };
        }
        const frame = stack[depth];
        if (block.type === "list-continuation" && frame.item) frame.item.content!.push(textNode(block));
        else {
            const item: PmNode = { type: listType === "taskList" ? "taskItem" : "listItem", content: [textNode(block)], ...(listType === "taskList" ? { attrs: { checked: block.attrs.checked === "yes" } } : {}) };
            frame.list.content!.push(item);
            frame.item = item;
        }
    }
    return { type: "doc", content: content.length ? content : [{ type: "paragraph", content: [] }] };
}
