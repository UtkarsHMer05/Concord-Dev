import { afterEach, describe, expect, it } from "vitest";

import { useSyncStatusStore } from "@/store/use-sync-status-store";

describe("sync status compatibility warning", () => {
    afterEach(() => useSyncStatusStore.getState().clear());

    it("keeps a legacy-cache warning visible while connection status changes", () => {
        const warning = "Legacy local cache found; owner and sync status cannot be verified.";
        const store = useSyncStatusStore.getState();

        store.setCompatibilityWarning(warning);
        store.setStatus("ready");

        expect(useSyncStatusStore.getState().compatibilityWarning).toBe(warning);
    });

    it("does not clear a sync error just because the socket reconnects", () => {
        const store = useSyncStatusStore.getState();

        store.setError("database unavailable");
        store.setStatus("ready");

        expect(useSyncStatusStore.getState().error).toBe("database unavailable");
    });

    it("tracks pending, acknowledged, and catch-up-confirmed outbox states", () => {
        const store = useSyncStatusStore.getState();

        store.setOutbox({ pending: 2, sent: 0, durablyAcked: 0, serverConfirmed: false });
        expect(useSyncStatusStore.getState().outbox?.pending).toBe(2);

        store.setOutbox({ pending: 0, sent: 0, durablyAcked: 2, serverConfirmed: false });
        expect(useSyncStatusStore.getState().outbox?.durablyAcked).toBe(2);

        store.setOutbox({ pending: 0, sent: 0, durablyAcked: 0, serverConfirmed: true });
        expect(useSyncStatusStore.getState().outbox?.serverConfirmed).toBe(true);
    });

    it("clears a sync error only after an empty catch-up is durably confirmed", () => {
        const store = useSyncStatusStore.getState();

        store.setError("IndexedDB write failed");
        store.setOutbox({ pending: 0, sent: 0, durablyAcked: 0, serverConfirmed: false });
        expect(useSyncStatusStore.getState().error).toBe("IndexedDB write failed");

        store.setOutbox({ pending: 0, sent: 0, durablyAcked: 0, serverConfirmed: true });
        expect(useSyncStatusStore.getState().error).toBeNull();
    });
});
