import { describe, expect, it } from "vitest";

import {
  peerColor,
  PRESENCE_TTL_MS,
  usePresenceStore,
} from "@/lib/presence/use-presence-store";
import type { PresenceUpdate } from "@/lib/sync/protocol";

function update(overrides: Partial<PresenceUpdate> & { connectionId: string }): PresenceUpdate {
  return {
    userId: "user-1",
    replicaId: "42",
    anchorItem: "7:3",
    anchorSide: "before",
    headItem: "7:5",
    headSide: "after",
    ...overrides,
  };
}

describe("presence store", () => {
  it("upserts peers keyed by connection id and maps optional items to points", () => {
    usePresenceStore.getState().clear();
    usePresenceStore.getState().applyUpdate(update({ connectionId: "c1" }), 1_000);
    // Unanchored caret (empty doc): items absent → null points.
    usePresenceStore
      .getState()
      .applyUpdate(update({ connectionId: "c2", anchorItem: undefined, headItem: undefined }), 1_000);

    const peers = usePresenceStore.getState().peers;
    expect(peers.c1.anchor).toEqual({ itemId: "7:3", side: "before" });
    expect(peers.c1.head).toEqual({ itemId: "7:5", side: "after" });
    expect(peers.c2.anchor).toBeNull();
    expect(peers.c2.head).toBeNull();

    // A later update replaces the same peer, never duplicates it.
    usePresenceStore.getState().applyUpdate(update({ connectionId: "c1", anchorItem: "9:1" }), 2_000);
    expect(Object.keys(usePresenceStore.getState().peers)).toHaveLength(2);
    expect(usePresenceStore.getState().peers.c1.anchor).toEqual({ itemId: "9:1", side: "before" });
  });

  it("removes a peer on leave and expires silent peers past the TTL", () => {
    usePresenceStore.getState().clear();
    usePresenceStore.getState().applyUpdate(update({ connectionId: "fresh" }), 10_000);
    usePresenceStore.getState().applyUpdate(update({ connectionId: "stale" }), 10_000);

    usePresenceStore.getState().removePeer("fresh");
    expect(usePresenceStore.getState().peers.fresh).toBeUndefined();
    expect(usePresenceStore.getState().peers.stale).toBeDefined();

    // Refresh "stale" so it survives, then sweep well past the TTL.
    usePresenceStore.getState().applyUpdate(update({ connectionId: "stale" }), 20_000);
    usePresenceStore.getState().sweep(20_000 + PRESENCE_TTL_MS - 1);
    expect(usePresenceStore.getState().peers.stale).toBeDefined();
    usePresenceStore.getState().sweep(20_000 + PRESENCE_TTL_MS + 1);
    expect(usePresenceStore.getState().peers.stale).toBeUndefined();
  });

  it("derives a stable, legible color per key", () => {
    expect(peerColor("abc")).toBe(peerColor("abc"));
    expect(peerColor("abc")).toMatch(/^hsl\(\d{1,3} 70% 45%\)$/);
  });
});
