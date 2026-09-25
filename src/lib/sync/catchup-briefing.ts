import { identityFromOpBytes } from "./identities";

const MAX_REPLICA_SUMMARY = 128;

export interface CatchupBriefing {
  /** Count-only prototype: it does not infer edit intent or passage overlap. */
  fromCursor: string;
  toCursor: string;
  /** null when a snapshot covered operations the client did not receive individually. */
  durableOperationCount: number | null;
  /** Origin replica IDs from operation headers; these are not person IDs. */
  replicas: Array<{ replicaId: string; operationCount: number }> | null;
  unattributedOperationCount: number | null;
  replicaListTruncated: boolean | null;
  /** null means the local outbox could not be read. */
  localUnackedOperationCount: number | null;
}

export interface CatchupOpCounts {
  operationCount: number;
  unattributedOperationCount: number;
  replicas: Map<string, number>;
  replicaListTruncated: boolean;
}

export function countCatchupOps(counts: CatchupOpCounts, ops: Uint8Array[]): void {
  counts.operationCount += ops.length;
  for (const op of ops) {
    const identity = identityFromOpBytes(op);
    if (identity === null) {
      counts.unattributedOperationCount += 1;
      continue;
    }
    const replicaId = identity.replica.toString();
    if (counts.replicas.has(replicaId)) {
      counts.replicas.set(replicaId, counts.replicas.get(replicaId)! + 1);
    } else if (counts.replicas.size < MAX_REPLICA_SUMMARY) {
      counts.replicas.set(replicaId, 1);
    } else {
      counts.replicaListTruncated = true;
    }
  }
}

export function createCatchupBriefing(input: {
  fromCursor: string;
  toCursor: string;
  counts: CatchupOpCounts;
  localUnackedOperationCount: number | null;
  /** False when snapshot resync skipped individual operation frames. */
  operationCountsComplete: boolean;
}): CatchupBriefing | null {
  try {
    if (BigInt(input.toCursor) <= BigInt(input.fromCursor)) return null;
  } catch {
    return null;
  }
  return {
    fromCursor: input.fromCursor,
    toCursor: input.toCursor,
    durableOperationCount: input.operationCountsComplete ? input.counts.operationCount : null,
    replicas: input.operationCountsComplete
      ? [...input.counts.replicas].map(([replicaId, operationCount]) => ({ replicaId, operationCount }))
      : null,
    unattributedOperationCount: input.operationCountsComplete ? input.counts.unattributedOperationCount : null,
    replicaListTruncated: input.operationCountsComplete ? input.counts.replicaListTruncated : null,
    localUnackedOperationCount: input.localUnackedOperationCount,
  };
}
