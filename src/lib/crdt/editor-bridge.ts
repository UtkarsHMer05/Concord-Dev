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
import { reconcile, type ReconcileOp, type StreamEntryJson } from "./adapter";
import type { CrdtClient } from "./worker/client";
import { replicaStorageId } from "./worker/idb";

/**
 * P7-M033: per-render-pass RPC budget (ms). A visibleJson on a converged
 * replica is sub-millisecond native work; 5s covers pathological-but-alive
 * workers (GC pause, cold JIT) while still recovering the pipeline within
 * one fanout burst instead of freezing it for the whole session.
 */
const RENDER_RPC_TIMEOUT_MS = 5_000;

export type BridgeState =
    | { mode: "idle" }
    | { mode: "crdt"; lastBlocks: CanonicalBlock[] }
    | { mode: "fallback"; reason: string };

export interface BridgeInit {
    editor: Editor;
    client: CrdtClient;
    /** Document the replica belongs to. */
    documentId: string;
    /** Authenticated owner for browser-local replica isolation. */
    userId?: string | null;
    /** Optional parsed JSON seed for direct bridge clients and tests. */
    seedPmDoc?: PmNode | null;
    onStatusChange?: (state: BridgeState) => void;
}

/**
 * Stable per-browser+document replica identity. New IDs use the high half of
 * u64, disjoint from the system's low reserved REST/SYSC IDs. Existing
 * stored client IDs remain valid for backwards compatibility.
 */
export function replicaIdForDocument(documentId: string, userId?: string | null): bigint {
    const key = userId
        ? `concord.replica.${encodeURIComponent(userId)}.${documentId}`
        : `concord.replica.${documentId}`;
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
    bytes[0] |= 0x80; // getBigUint64 is big-endian: high bit disjoins maintenance IDs
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
    /**
     * Local edits may arrive faster than the worker can export its stream and
     * apply a diff. Preserve one trailing pass instead of returning early and
     * silently dropping the newest editor state.
     */
    private reconcileRequested = false;
    private pendingReconcileEditor: Editor | null = null;
    /** Transactions that arrived while start() was still in flight. */
    private startPromise: Promise<void> | null = null;
    /** Render coalescing (P7-M024): one render in flight, one trailing. */
    private renderInFlight = false;
    private renderRequested = false;

    constructor(private readonly init: BridgeInit) {}

    /**
     * P7-M033 render watchdog: bounds ONE render-pass RPC. On timeout the
     * pass aborts (renderRemote's catch logs it; finally releases
     * renderInFlight) so a never-settling worker RPC cannot wedge the
     * coalescer for the rest of the session. The underlying RPC is NOT
     * cancelled — its eventual resolution is simply ignored (the client
     * resolves the pending map entry either way; a stale result is
     * harmless because every render re-reads the worker's then-current
     * state).
     */
    private withRenderTimeout<T>(rpc: Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("render RPC timed out (watchdog)"));
            }, RENDER_RPC_TIMEOUT_MS);
            void rpc.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error: unknown) => {
                    clearTimeout(timer);
                    reject(error instanceof Error ? error : new Error(String(error)));
                },
            );
        });
    }

    getState(): BridgeState {
        return this.state;
    }

    /** Engine visible-JSON (runs) → adapter canonical blocks (chars). */
    private static toCanonicalBlocks(json: string): CanonicalBlock[] {
        const raw = (JSON.parse(json) as {
            blocks: Array<{
                type: string;
                attrs: Record<string, string>;
                runs: Array<{ t: string; m: Record<string, string> }>;
            }>;
        }).blocks;
        return raw.map((block) => ({
            type: block.type,
            attrs: block.attrs,
            chars: block.runs.flatMap((run) =>
                [...run.t].map((scalar) => ({ scalar, marks: run.m })),
            ),
        }));
    }

    /**
     * Initializes the bridge: the worker restores/creates the local replica
     * (IndexedDB-first), and the editor content is seeded from the CRDT
     * state — or from the server snapshot when the local replica is new.
     */
    async start(): Promise<BridgeState> {
        const { editor, client, documentId, userId, seedPmDoc } = this.init;
        // Serialize: no transaction may reconcile while the seed/restore is
        // mid-flight (concurrent start + typing produced out-of-range stream
        // indices in the double-mounted dev mode - the bug this guards).
        const run = this.runStart(editor, client, documentId, seedPmDoc, userId);
        this.startPromise = run;
        await run;
        return this.state;
    }

    private async runStart(
        editor: Editor,
        client: CrdtClient,
        documentId: string,
        seedPmDoc?: PmNode | null,
        userId?: string | null,
    ): Promise<void> {
        try {
            await client.init(
                documentId,
                replicaIdForDocument(documentId, userId),
                replicaStorageId(documentId, userId),
            );
            const crdtBlocks = CrdtEditorBridge.toCanonicalBlocks(
                await client.visibleJson(),
            );
            const crdtIsEmpty =
                crdtBlocks.length <= 1 && (crdtBlocks[0]?.chars.length ?? 0) === 0;

            let seedBlocks: CanonicalBlock[];
            let seedIsNew = false;
            if (!crdtIsEmpty) {
                // Local replica exists: it is the editing truth (offline-first).
                seedBlocks = crdtBlocks;
            } else if (seedPmDoc === null) {
                seedBlocks = [{ type: "paragraph", attrs: { type: "paragraph" }, chars: [] }];
                seedIsNew = true;
            } else {
                const parsed = pmDocToBlocks(seedPmDoc ?? editor.getJSON() as PmNode);
                if (!parsed.support.supported) {
                    this.state = {
                        mode: "fallback",
                        reason: `unsupported: ${parsed.support.unsupportedTypes.join(", ")}`,
                    };
                    this.init.onStatusChange?.(this.state);
                    return;
                }
                seedBlocks = parsed.blocks;
                seedIsNew = true;
            }

            // Seed the editor: emitUpdate=false - this is not a local
            // transaction, so the op pipeline is never re-entered (M038).
            editor.commands.setContent(blocksToPmDoc(seedBlocks), {
                emitUpdate: false,
            });
            this.state = { mode: "crdt", lastBlocks: seedBlocks };

            if (seedIsNew) {
                // First open: emit the seed content into the durable CRDT
                // replica. Inline reconcile (NOT via onLocalTransaction —
                // that would await this.startPromise, which is the very
                // runStart promise executing here: self-deadlock).
                // NOTE: the guard MUST be `seedIsNew` alone — seedIsNew is
                // only ever true when the replica was empty, so the old
                // `seedIsNew && !crdtIsEmpty` was dead code and the seed
                // never reached the engine.
                const stream = (await this.init.client.exportStream()) as StreamEntryJson[];
                const ops = reconcile(
                    [{ type: "paragraph", attrs: { type: "paragraph" }, chars: [] }],
                    seedBlocks,
                    stream,
                );
                await this.applyOps(ops);
                this.state = { mode: "crdt", lastBlocks: seedBlocks };
            }
            this.init.onStatusChange?.(this.state);
        } catch (error) {
            // Surface worker/persistence failures honestly (fallback). The
            // worker RPC rejects with STRUCTURED errors ({code, message} —
            // CrdtWorkerError), not Error instances; stringify both shapes
            // (P7-M032: an [object Object] log hid a CSP failure for hours).
            // The reason never contains secrets.
            const describe = (e: unknown): string => {
                if (e instanceof Error) return e.message;
                if (typeof e === "object" && e !== null && "message" in e) {
                    return String((e as { message: unknown }).message);
                }
                return String(e);
            };
            console.error("[concord-crdt] bridge start failed:", describe(error));
            this.state = {
                mode: "fallback",
                reason: describe(error) || "worker init failed",
            };
            this.init.onStatusChange?.(this.state);
        }
    }

    /**
     * Local transaction handler — call from the editor's onUpdate. Diffs the
     * PM document against the CRDT canonical state and emits operations.
     */
    async onLocalTransaction(editor: Editor): Promise<void> {
        // Wait for start() (seed/restore) to finish before reconciling. The
        // seed emission inside start() calls reconcileTransaction() DIRECTLY
        // (not this method): awaiting startPromise from within start() itself
        // would deadlock.
        if (this.startPromise !== null) {
            await this.startPromise;
        }
        await this.reconcileTransaction(editor);
    }

    /** Shared reconciliation core — no start() coordination (re-entrant). */
    private async reconcileTransaction(editor: Editor): Promise<void> {
        if (this.reconciling) {
            // TipTap's onUpdate does not await this handler. A burst of key
            // presses can therefore enter while the first transaction is
            // awaiting a worker RPC. Coalesce all of those updates into one
            // trailing reconciliation against the editor's latest document.
            this.reconcileRequested = true;
            this.pendingReconcileEditor = editor;
            return;
        }
        if (this.state.mode !== "crdt") {
            return; // fallback path or not started
        }

        this.reconciling = true;
        let currentEditor = editor;
        try {
            do {
                // A request made while the preceding pass awaited the worker
                // is represented by this flag. Reset it before reading the
                // current editor so another edit during this pass schedules
                // exactly one more pass.
                this.reconcileRequested = false;
                this.pendingReconcileEditor = null;

                const parsed = pmDocToBlocks(currentEditor.getJSON() as PmNode);
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

                const stream = (await this.streamEntries()) as StreamEntryJson[];
                const ops = reconcile(this.state.lastBlocks, parsed.blocks, stream);
                if (ops.length > 0) {
                    await this.applyOps(ops);
                }
                this.state = { mode: "crdt", lastBlocks: parsed.blocks };
                currentEditor = this.pendingReconcileEditor ?? currentEditor;
            } while (this.reconcileRequested && this.state.mode === "crdt");
        } catch (error) {
            this.state = { mode: "fallback", reason: "worker persistence failed" };
            this.init.onStatusChange?.(this.state);
            throw error;
        } finally {
            this.reconciling = false;
            this.reconcileRequested = false;
            this.pendingReconcileEditor = null;
        }
    }

    /** Applies reconcile ops through the worker in order. */
    private async applyOps(ops: ReconcileOp[]): Promise<void> {
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
    }

    /**
     * Remote direction (M040): renders the converged canonical state into
     * the editor. setContent with emitUpdate=false — onUpdate never fires.
     *
     * P7-M024 hardening: renders are COALESCED. Fanout batches arrive in
     * bursts (one onRemoteApplied per batch) and concurrent renders raced
     * on the worker RPC; an exception in ANY render (worker RPC failure,
     * transient) previously escaped as an unhandled rejection and could
     * silently stop ALL further renders while the worker kept converging
     * (observed live on staging: the editor froze mid-burst even though
     * the replica was current; only a reload's catch-up rendered it).
     * Now:
     *   - a render in flight absorbs later requests into ONE trailing
     *     render (a burst of N batches ⇒ ≤2 renders, no dropped state),
     *   - a render error is caught + logged; the NEXT batch (or a
     *     reconnect's catch-up) re-renders from the worker's then-current
     *     state. The render pipeline can no longer wedge.
     *
     * P7-M033 render WATCHDOG: the coalescer's blind spot was a visibleJson
     * RPC that never SETTLES (neither resolves nor rejects — observed live
     * on production: the first render of a burst succeeded, every later
     * one was absorbed as renderRequested into a render whose in-flight
     * RPC never returned; the worker replica kept converging but the
     * editor DOM froze for the rest of the session; local typing still
     * worked because onLocalTransaction runs on its own path). A watchdog
     * bounds each render pass: if the RPC exceeds RENDER_RPC_TIMEOUT_MS,
     * the pass is abandoned, renderInFlight is released, and the NEXT
     * onRemoteApplied (or the trailing renderRequested flag) re-renders
     * from the worker's then-current state. A slow render is retried, a
     * dead one cannot wedge the pipeline.
     */
    async renderRemote(): Promise<void> {
        if (this.state.mode !== "crdt") {
            return;
        }
        if (this.renderInFlight) {
            this.renderRequested = true; // coalesce into the trailing render
            return;
        }
        this.renderInFlight = true;
        this.renderRequested = false;
        try {
            do {
                this.renderRequested = false;
                const blocks = CrdtEditorBridge.toCanonicalBlocks(
                    await this.withRenderTimeout(this.init.client.visibleJson()),
                );
                if (this.state.mode !== "crdt") {
                    return; // degraded mid-render: stop rendering
                }
                this.state = { mode: "crdt", lastBlocks: blocks };
                this.init.editor.commands.setContent(blocksToPmDoc(blocks), {
                    emitUpdate: false,
                });
            } while (this.renderRequested);
        } catch (error) {
            // Never let a render failure kill the render pipeline: the
            // worker replica keeps converging; the next batch (or a
            // reconnect's catch-up) re-renders. Log for diagnosis.
            console.error(
                "[concord-crdt] remote render failed:",
                error instanceof Error ? error.message : error,
            );
        } finally {
            this.renderInFlight = false;
        }
    }

    private async streamEntries(): Promise<StreamEntryJson[]> {
        return this.init.client.exportStream();
    }
}
