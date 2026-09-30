import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ConcordEngine } from "@/lib/crdt/runtime";
import { pmDocToBlocks, blocksToPmDoc, validRichTextValue, type CanonicalBlock, type PmNode } from "@/lib/crdt/pm-model";
import { applyReconcileOpsSync, reconcile, type StreamEntryJson } from "@/lib/crdt/adapter";
import { anchorSelection, resolveAnchor } from "@/lib/comments/anchors";
import { acquireReplica } from "@/lib/crdt/editor-bridge";
import { exportMarkdown } from "@/lib/markdown";

async function factory() {
    const source = await readFile("wasm/dist/concord-crdt.js", "utf8");
    const binary = await readFile("wasm/dist/concord-crdt.wasm");
    const load = new Function(`${source}; return loadConcordCrdt;`)();
    return await load({ instantiateWasm(info: WebAssembly.Imports, receive: (i: WebAssembly.Instance) => void) {
        return WebAssembly.instantiate(binary, info).then((result) => { receive(result.instance); return result.instance.exports; });
    } });
}
function visible(engine: ConcordEngine): CanonicalBlock[] {
    return JSON.parse(engine.visibleJson()).blocks.map((b: { type: string; attrs: Record<string, string>; runs: Array<{ t: string; m: Record<string, string> }> }) => ({
        type: b.type, attrs: b.attrs, chars: b.runs.flatMap((r) => [...r.t].map((scalar) => ({ scalar, marks: r.m }))),
    }));
}
function edit(engine: ConcordEngine, doc: PmNode): Uint8Array[] {
    const mapped = pmDocToBlocks(doc);
    expect(mapped.support).toEqual({ supported: true, unsupportedTypes: [] });
    return applyReconcileOpsSync(engine, reconcile(visible(engine), mapped.blocks, JSON.parse(engine.streamJson())));
}
const paragraph = (text: string): PmNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const item = (text: string, children: PmNode[] = []): PmNode => ({ type: "listItem", content: [paragraph(text), ...children] });
const nested: PmNode = { type: "doc", content: [
    { type: "bulletList", content: [item("Parent", [{ type: "orderedList", attrs: { start: 3 }, content: [item("Child", [paragraph("Continuation")])] }]), item("Sibling")] },
    { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("Ship"), { type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph("Test")] }] }] }] },
] };

describe("rich-text-v2", () => {
    it("edits a leading live delimiter after deleted prefix items", async () => {
        const engine = await ConcordEngine.create(100n, factory);
        try {
            edit(engine, { type: "doc", content: [paragraph("deleted"), paragraph("kept")] });
            edit(engine, { type: "doc", content: [paragraph("kept")] });
            const stream = JSON.parse(engine.streamJson()) as StreamEntryJson[];
            expect(stream[0].t).toBe(true);
            edit(engine, { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("kept!")] }] }] });
            expect(visible(engine)[0].attrs).toMatchObject({ checked: "yes", list: "task" });
            expect(visible(engine)[0].chars.map((ch) => ch.scalar).join("")).toBe("kept!");
        } finally { engine.free(); }
    });

    it("round-trips nested mixed lists, ordered starts, tasks, and continuation paragraphs", async () => {
        const engine = await ConcordEngine.create(100n, factory);
        try {
            edit(engine, nested);
            const doc = blocksToPmDoc(visible(engine));
            expect(pmDocToBlocks(doc).blocks).toEqual(pmDocToBlocks(nested).blocks);
            const restored = await ConcordEngine.importFromSnapshot(200n, engine.exportSnapshot(), factory);
            try { expect(restored.digest()).toBe(engine.digest()); expect(blocksToPmDoc(visible(restored))).toEqual(doc); }
            finally { restored.free(); }
        } finally { engine.free(); }
    });

    it("preserves strike, links, inline code, text styles, highlights, breaks, quotes and Unicode", async () => {
        const doc: PmNode = { type: "doc", content: [{ type: "paragraph", attrs: { textAlign: "center", lineHeight: "1.5" }, content: [
            { type: "text", text: '"A\\B" 🧪 日本語', marks: [{ type: "strike" }, { type: "link", attrs: { href: 'https://example.com/?q="x"', target: "_blank", rel: "noopener noreferrer nofollow" } }, { type: "textStyle", attrs: { color: "rgb(255, 0, 0)", fontFamily: '"Courier New", monospace', fontSize: "18px" } }, { type: "highlight", attrs: { color: "#ffee00" } }] },
            { type: "hardBreak" }, { type: "text", text: "npm test", marks: [{ type: "code" }] },
        ] }] };
        const engine = await ConcordEngine.create(100n, factory);
        try {
            edit(engine, doc);
            expect(pmDocToBlocks(blocksToPmDoc(visible(engine))).blocks).toEqual(pmDocToBlocks(doc).blocks);
            expect(JSON.parse(engine.streamJson())).toBeInstanceOf(Array);
            expect(exportMarkdown(doc).lossless).toBe(false);
        } finally { engine.free(); }
    });

    it("rejects unknown marks, attributes, unsafe links, and excessive nesting before reconciliation", () => {
        for (const mark of [{ type: "futureMark" }, { type: "link", attrs: { href: "javascript:alert(1)" } }, { type: "textStyle", attrs: { futureStyle: "x" } }]) {
            expect(pmDocToBlocks({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "keep me", marks: [mark] }] }] }).support.supported).toBe(false);
        }
        expect(validRichTextValue("color", "red; position:fixed")).toBe(false);
        expect(validRichTextValue("fontSize", "401px")).toBe(false);
        for (const doc of [
            { type: "doc", attrs: { future: "x" }, content: [paragraph("keep me")] },
            { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "keep me", attrs: { future: "x" } }] }] },
            { type: "doc", content: [{ type: "bulletList", content: [{ ...item("keep me"), attrs: { checked: true } }] }] },
        ]) expect(pmDocToBlocks(doc).support.supported).toBe(false);
        let list: PmNode = { type: "bulletList", content: [item("leaf")] };
        for (let n = 0; n < 9; n += 1) list = { type: "bulletList", content: [item("parent", [list])] };
        expect(pmDocToBlocks({ type: "doc", content: [list] }).support.unsupportedTypes).toContain("list-depth");
    });

    it("composes overlapping formatting without replacing IDs or duplicating text", async () => {
        const a = await ConcordEngine.create(100n, factory);
        let b: ConcordEngine | undefined;
        try {
            edit(a, { type: "doc", content: [paragraph("abcdef")] });
            b = await ConcordEngine.importFromSnapshot(200n, a.exportSnapshot(), factory);
            const originalIds = JSON.parse(a.streamJson()).map((x: StreamEntryJson) => `${x.r}:${x.c}`);
            const adoc: PmNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "abcd", marks: [{ type: "bold" }] }, { type: "text", text: "ef" }] }] };
            const bdoc: PmNode = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "ab" }, { type: "text", text: "cdef", marks: [{ type: "italic" }] }] }] };
            const ao = edit(a, adoc); const bo = edit(b, bdoc);
            expect([...ao, ...bo].every((op) => op[1] === 3)).toBe(true);
            for (const op of [...bo].reverse()) a.applyRemote(op);
            for (const op of [...ao].reverse()) b.applyRemote(op);
            expect(a.digest()).toBe(b.digest());
            expect(visible(a)[0].chars.map((x) => x.scalar).join("")).toBe("abcdef");
            expect(visible(a)[0].chars[2].marks).toEqual({ bold: "1", italic: "1" });
            expect(JSON.parse(a.streamJson()).map((x: StreamEntryJson) => `${x.r}:${x.c}`)).toEqual(originalIds);
        } finally { a.free(); b?.free(); }
    });

    it("preserves a child edit while its parent is deleted and the surviving child is outdented", async () => {
        const a = await ConcordEngine.create(100n, factory); let b: ConcordEngine | undefined;
        try {
            edit(a, { type: "doc", content: [{ type: "bulletList", content: [item("Parent", [{ type: "bulletList", content: [item("Child")] }])] }] });
            b = await ConcordEngine.importFromSnapshot(200n, a.exportSnapshot(), factory);
            const doc = blocksToPmDoc(visible(a));
            // The real TipTap schema appends an editable paragraph after lists.
            doc.content!.push({ type: "paragraph", content: [] });
            const stream = JSON.parse(a.streamJson());
            const anchor = anchorSelection(doc, stream, 13, 18);
            expect(anchor).not.toBeNull();
            const ao = edit(a, { type: "doc", content: [{ type: "bulletList", content: [item("Child")] }] });
            const bo = edit(b, { type: "doc", content: [{ type: "bulletList", content: [item("Parent", [{ type: "bulletList", content: [item("Child!")] }])] }] });
            for (const op of [...bo].reverse()) a.applyRemote(op);
            for (const op of [...ao].reverse()) b.applyRemote(op);
            expect(a.digest()).toBe(b.digest());
            expect(pmDocToBlocks(blocksToPmDoc(visible(a))).blocks.map((x) => x.chars.map((c) => c.scalar).join(""))).toEqual(["Child!"]);
            expect(resolveAnchor(blocksToPmDoc(visible(a)), JSON.parse(a.streamJson()), anchor!).status).toBe("attached");
        } finally { a.free(); b?.free(); }
    });

    it("makes concurrent task toggles and indent writes deterministic across delivery orders", async () => {
        const a = await ConcordEngine.create(100n, factory); let b: ConcordEngine | undefined;
        try {
            edit(a, { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [paragraph("task")] }] }] });
            b = await ConcordEngine.importFromSnapshot(200n, a.exportSnapshot(), factory);
            const aa = a.localSetAttr(0, "checked", "yes"); const ab = a.localSetAttr(0, "depth", "1");
            const ba = b.localSetAttr(0, "checked", "no"); const bb = b.localSetAttr(0, "depth", "2");
            a.applyRemote(bb); a.applyRemote(ba); b.applyRemote(aa); b.applyRemote(ab);
            expect(a.digest()).toBe(b.digest());
            expect(visible(a)[0].attrs.checked).toBe("no");
            expect(blocksToPmDoc(visible(a)).content![0].type).toBe("taskList");
        } finally { a.free(); b?.free(); }
    });

    it("rejects a stale WASM binary before reading or modifying persisted state", async () => {
        const stale = await factory(); delete stale._concord_rich_text_version;
        await expect(ConcordEngine.create(1n, async () => stale)).rejects.toMatchObject({ code: "UnsupportedVersion" });
    });

    it("gives cloned tabs distinct writer IDs and caches, and releases ownership on close", async () => {
        const held = new Set<string>(); const persistent = new Map<string, string>(); const session = new Map<string, string>();
        vi.stubGlobal("localStorage", { getItem: (k: string) => persistent.get(k) ?? null, setItem: (k: string, v: string) => persistent.set(k, v) });
        vi.stubGlobal("sessionStorage", { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => session.set(k, v) });
        vi.stubGlobal("navigator", { locks: { request: async (key: string, _options: unknown, fn: (lock: object | null) => Promise<void>) => {
            if (held.has(key)) return fn(null);
            held.add(key); try { await fn({}); } finally { held.delete(key); }
        } } });
        try {
            const a = await acquireReplica("shared", "alice"); const b = await acquireReplica("shared", "alice");
            expect(a.replicaId).not.toBe(b.replicaId); expect(a.storageId).not.toBe(b.storageId);
            b.release(); await Promise.resolve(); await Promise.resolve();
            const resumed = await acquireReplica("shared", "alice");
            expect(resumed.replicaId).toBe(b.replicaId); expect(resumed.storageId).toBe(b.storageId);
            a.release(); resumed.release();
        } finally { vi.unstubAllGlobals(); }
    });
});
