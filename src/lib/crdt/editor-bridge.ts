// TipTap ⇐⇒ CRDT editor bridge (P2-M039/M040/M041/M042).
//
// Connects one TipTap editor to the CRDT worker:
//
// - LOCAL: editor transactions (typing, paste, selection replace, undo/redo)
//   are diffed against the CRDT canonical blocks and emitted as CRDT
//   operations through the worker (durable via IndexedDB). Undo/redo ride
//   TipTap's local history: an undo changes the PM document, and the
//   reconciliation emits the inverse operations — the documented scoped
//   local-inverse model (PROTOCOL §8 / M042).
// - REMOTE (test harness / future transport): remote ops are applied in the
//   worker; the bridge re-renders the editor via setContent with
//   emitUpdate=false so remote updates never re-enter the op pipeline
//   (feedback-loop prevention — M038).
// - Unsupported content (images, tables, lists, …) disables the CRDT path
//   for the session and falls back to the Phase 1 persistence — never
//   silently corrupted (M041).
"use client";

import type { Editor } from "@tiptap/react";

import { blocksToPmDoc, pmDocToBlocks, type CanonicalBlock, type PmNode } from "./pm-model";
import { reconcile, type StreamEntryJson } from "./adapter";
import type { CrdtClient } from "./worker/client";

export type BridgeState =
    | { mode: "idle" }
    | { mode: "crdt"; lastBlocks: CanonicalBlock[] }
    | { mode: "fallback"; reason: string };

export interface BridgeInit {
    editor: Editor;
    client: CrdtClient;
    /** Document the replica belongs to. */
    documentId: string;
    /** Server-side seed (Phase 1 envelope) for the first open of a document. */
    seedPmDoc: PmNode | null;
    onStatusChange?: (state: BridgeState) => void;
}

/**
 * Stable per-browser+document replica identity (never zero; collision with a
 * concurrent editor is astronomically unlikely for 63 random bits).
 */
function replicaIdForDocument(documentId: string): bigint {
    const key = `concord.replica.${documentId}`;
    try {
        const stored = globalThis.localStorage?.getItem(key);
        if (stored !== null && BigInt(stored) !== 0n) {
            return BigInt(stored);
        }
    } catch {
        // localStorage unavailable (private mode): per-session identity.
    }
    const bytes = new Uint8Array(8);
    if (typeof globalThis.crypto?.getRandomValues === "function") {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < 8; ++i) {
            bytes[i] = Math.floor(Math.random() * 256);
        }
    }
    bytes[0] |= 1; // never zero
    const value = new DataView(bytes.buffer).getBigUint64(0);
    try {
        globalThis.localStorage?.setItem(key, value.toString());
    } catch {
        // Best-effort persistence; the identity stays for this session.
    }
    return value;
}

export class CrdtEditorBridge {
    private state: BridgeState = { mode: "idle" };
    private reconciling = false;

    constructor(private readonly init: BridgeInit) {}

    getState(): BridgeState {
        return this.state;
    }

    /**
     * Initializes the bridge: the worker restores/creates the local replica
     * (IndexedDB-first), and the editor content is seeded from the CRDT
     * state — or from the server snapshot when the local replica is new.
     */
    async start(): Promise<BridgeState> {
        const { editor, client, documentId, seedPmDoc } = this.init;
        try {
            await client.init(documentId, replicaIdForDocument(documentId));
            const json = await client.visibleJson();
            const crdtBlocks = (JSON.parse(json) as { blocks: unknown }).blocks as CanonicalBlock[];
            const crdtIsEmpty =
                crdtBlocks.length <= 1 && (crdtBlocks[0]?.chars.length ?? 0) === 0;

            let seedBlocks: CanonicalBlock[];
            let seedIsNew = false;
            if (!crdtIsEmpty) {
                // Local replica exists: it is the editing truth (offline-first).
                seedBlocks = crdtBlocks;
            } else if (seedPmDoc !== null) {
                const parsed = pmDocToBlocks(seedPmDoc);
                if (!parsed.support.supported) {
                    this.state = {
                        mode: "fallback",
                        reason: `unsupported: ${parsed.support.unsupportedTypes.join(", ")}`,
                    };
                    this.init.onStatusChange?.(this.state);
                    return this.state;
                }
                seedBlocks = parsed.blocks;
                seedIsNew = true;
            } else {
                seedBlocks = [{ type: "paragraph", attrs: { type: "paragraph" }, chars: [] }];
                seedIsNew = true;
            }

            // Seed the editor: emitUpdate=false — this is not a local
            // transaction, so the op pipeline is never re-entered (M038).
            editor.commands.setContent(blocksToPmDoc(seedBlocks), {
                emitUpdate: false,
            });
            this.state = { mode: "crdt", lastBlocks: seedBlocks };

            if (seedIsNew && !crdtIsEmpty) {
                // First open: emit the seed content into the durable CRDT
                // replica through the normal reconciliation path.
                await this.onLocalTransaction(editor);
            }
            this.init.onStatusChange?.(this.state);
            return this.state;
        } catch (error) {
            // Surface worker/persistence failures honestly (fallback).
            this.state = {
                mode: "fallback",
                reason: error instanceof Error ? error.message : "worker init failed",
            };
            this.init.onStatusChange?.(this.state);
            return this.state;
        }
    }

    /**
     * Local transaction handler — call from the editor's onUpdate. Diffs the
     * PM document against the CRDT canonical state and emits operations.
     */
    async onLocalTransaction(editor: Editor): Promise<void> {
        if (this.reconciling) {
            return;
        }
        if (this.state.mode !== "crdt") {
            return; // fallback path or not started
        }
        const parsed = pmDocToBlocks(editor.getJSON() as PmNode);
        if (!parsed.support.supported) {
            // M041 honesty rule: degrade to the Phase 1 path for this
            // session; existing CRDT state is retained.
            this.state = {
                mode: "fallback",
                reason: `unsupported: ${parsed.support.unsupportedTypes.join(", ")}`,
            };
            this.init.onStatusChange?.(this.state);
            return;
        }

        this.reconciling = true;
        try {
            const stream = (await this.streamEntries()) as StreamEntryJson[];
            const ops = reconcile(this.state.lastBlocks, parsed.blocks, stream);
            if (ops.length === 0) {
                return;
            }
            for (const op of ops) {
                switch (op.kind) {
                    case "insertText":
                        await this.init.client.localInsertText(op.streamIndex, op.codepoint ?? 0x20);
                        break;
                    case "insertDelimiter":
                        await this.init.client.localInsertDelimiter(op.streamIndex, op.blockType ?? "paragraph");
                        break;
                    case "delete":
                        await this.init.client.localDelete(op.streamIndex);
                        break;
                    case "setAttr":
                        await this.init.client.localSetAttr(op.streamIndex, op.name ?? "", op.value ?? null);
                        break;
                }
            }
            this.state = { mode: "crdt", lastBlocks: parsed.blocks };
        } finally {
            this.reconciling = false;
        }
    }

    /**
     * Remote direction (M040): renders the converged canonical state into
     * the editor. setContent with emitUpdate=false — onUpdate never fires.
     */
    async renderRemote(): Promise<void> {
        if (this.state.mode !== "crdt") {
            return;
        }
        const json = await this.init.client.visibleJson();
        const blocks = (JSON.parse(json) as { blocks: CanonicalBlock[] }).blocks;
        this.state = { mode: "crdt", lastBlocks: blocks };
        this.init.editor.commands.setContent(blocksToPmDoc(blocks), {
            emitUpdate: false,
        });
    }

    private async streamEntries(): Promise<StreamEntryJson[]> {
        return this.init.client.exportStream();
    }
}
