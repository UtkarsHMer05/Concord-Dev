import { describe, expect, it } from "vitest";

import {
  countCatchupOps,
  createCatchupBriefing,
  type CatchupOpCounts,
} from "@/lib/sync/catchup-briefing";

function insert(replica: bigint, counter: bigint): Uint8Array {
  const bytes = new Uint8Array([
    1, 1, // version, insert
    ...new Uint8Array(8),
    ...new Uint8Array(8),
    ...new Uint8Array(8),
    0, 0, // no left or right anchor
    1, 1, 97, // text item: "a"
    0, // no attributes
  ]);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(2, replica, true);
  view.setBigUint64(10, counter, true);
  view.setBigUint64(18, 1n, true);
  return bytes;
}

function counts(): CatchupOpCounts {
  return {
    operationCount: 0,
    unattributedOperationCount: 0,
    replicas: new Map(),
    replicaListTruncated: false,
  };
}

describe("reconnect catch-up briefing", () => {
  it("counts durable operations by exact replica ID and only briefs cursor progress", () => {
    const accumulated = counts();
    countCatchupOps(accumulated, [
      insert(9007199254740993n, 1n),
      insert(9007199254740993n, 2n),
      insert(7n, 1n),
      new Uint8Array([1, 1]),
    ]);

    expect(createCatchupBriefing({
      fromCursor: "12",
      toCursor: "12",
      counts: accumulated,
      localUnackedOperationCount: 3,
      operationCountsComplete: true,
    })).toBeNull();
    expect(createCatchupBriefing({
      fromCursor: "12",
      toCursor: "14",
      counts: accumulated,
      localUnackedOperationCount: null,
      operationCountsComplete: true,
    })).toEqual({
      fromCursor: "12",
      toCursor: "14",
      durableOperationCount: 4,
      replicas: [
        { replicaId: "9007199254740993", operationCount: 2 },
        { replicaId: "7", operationCount: 1 },
      ],
      unattributedOperationCount: 1,
      replicaListTruncated: false,
      localUnackedOperationCount: null,
    });

    expect(createCatchupBriefing({
      fromCursor: "12",
      toCursor: "20",
      counts: accumulated,
      localUnackedOperationCount: 2,
      operationCountsComplete: false,
    })).toEqual({
      fromCursor: "12",
      toCursor: "20",
      durableOperationCount: null,
      replicas: null,
      unattributedOperationCount: null,
      replicaListTruncated: null,
      localUnackedOperationCount: 2,
    });
  });
});
