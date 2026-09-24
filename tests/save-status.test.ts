/**
 * Save-status presentation mapping tests (M007/M008).
 *
 * The truthfulness rules from docs/FAILURE_MODEL.md §1 are contract:
 * - only CRDT state may claim local durability; fallback errors warn that
 *   changes remain in the current tab;
 * - nothing is presented as server-saved before the durable point;
 * - conflict is the highest-precedence state.
 */
import { describe, expect, it } from "vitest";

import { toSaveStatusView } from "@/lib/collaboration/save-status";

describe("toSaveStatusView", () => {
  it("shows offline with local-save wording when the browser is offline, regardless of mirror status", () => {
    for (const status of ["idle", "saving", "error"] as const) {
      const view = toSaveStatusView(status, false, true);
      expect(view.state).toBe("offline");
      expect(view.label).toContain("Offline");
      // Local-first guarantee is stated in the user-facing copy.
      expect(view.label).toContain("locally");
      expect(view.description).toContain("saved");
      expect(view.description).toContain("device");
      expect(view.prominent).toBe(true);
    }
  });

  it("conflict wins over offline (the user must reload)", () => {
    const view = toSaveStatusView("conflict", false, true);
    expect(view.state).toBe("conflict");
    expect(view.description).toContain("another tab");
  });

  it("idle+online in CRDT mode does not claim a server save", () => {
    const view = toSaveStatusView("idle", true, true);
    expect(view.state).toBe("saved-locally");
    expect(view.label).toBe("Saved on this device");
  });

  it("CRDT mode ignores stale mirror statuses without a durable sync ack", () => {
    for (const status of ["idle", "saving", "saved", "error"] as const) {
      const view = toSaveStatusView(status, true, true);
      expect(view.state).toBe("saved-locally");
      expect(view.label).toBe("Saved on this device");
    }
  });

  it("labels unconfigured CRDT sync as local-only", () => {
    const view = toSaveStatusView("saved", true, true, { localOnly: true });
    expect(view.state).toBe("local-only");
    expect(view.description).toContain("not being copied to the server");
  });

  it("shows durable local edits waiting for a server ACK", () => {
    const view = toSaveStatusView("saved", true, true, {
      outbox: { pending: 2, sent: 1, durablyAcked: 0, serverConfirmed: false },
    });
    expect(view.state).toBe("pending-sync");
    expect(view.label).toBe("Pending sync (3)");
    expect(view.description).toContain("durable server acknowledgement");
  });

  it("shows a durable gateway ACK and a completed cursor catch-up separately", () => {
    const acked = toSaveStatusView("saved", true, true, {
      outbox: { pending: 0, sent: 0, durablyAcked: 1, serverConfirmed: false },
    });
    const caughtUp = toSaveStatusView("saved", true, true, {
      outbox: { pending: 0, sent: 0, durablyAcked: 0, serverConfirmed: true },
    });
    expect(acked.state).toBe("server-acknowledged");
    expect(caughtUp.state).toBe("server-acknowledged");
    expect(acked.description).toContain("durably acknowledged");
  });

  it("keeps local durability visible when server sync fails", () => {
    const view = toSaveStatusView("saved", true, true, {
      error: "database unavailable",
      outbox: { pending: 1, sent: 0, durablyAcked: 0, serverConfirmed: false },
    });
    expect(view.state).toBe("error");
    expect(view.label).toBe("Saved locally — sync error");
    expect(view.description).toContain("database unavailable");
    expect(view.description).toContain("durable replica");
  });

  it("does not claim local durability for the whole-document fallback", () => {
    const idle = toSaveStatusView("idle", true, false);
    expect(idle.state).toBe("saved-mirror");

    const failed = toSaveStatusView("error", true, false);
    expect(failed.label).toBe("Not saved — retrying");
    expect(failed.description).toContain("only in this tab");
    const offline = toSaveStatusView("saving", false, false);
    expect(offline.label).toBe("Offline — changes not saved");
    expect(offline.description).toContain("only in this tab");

    const conflict = toSaveStatusView("conflict", true, false);
    expect(conflict.description).toContain("copy them before reloading");
  });

  it("a successful mirror response is presented as saved on the server", () => {
    const view = toSaveStatusView("saved", true, false);
    expect(view.state).toBe("saved-mirror");
    expect(view.description).toContain("server");
    expect(view.prominent).toBe(false);
  });

  it("saving is transient and quiet", () => {
    const view = toSaveStatusView("saving", true, false);
    expect(view.state).toBe("saving");
    expect(view.label).toBe("Saving…");
    expect(view.prominent).toBe(false);
  });

  it("mirror errors do not claim local durability", () => {
    const view = toSaveStatusView("error", true, false);
    expect(view.state).toBe("error");
    expect(view.label).toBe("Not saved — retrying");
    expect(view.description).toContain("only in this tab");
    expect(view.prominent).toBe(true);
  });

  it("never claims cloud/server save for offline or error states", () => {
    const offline = toSaveStatusView("idle", false, true);
    const error = toSaveStatusView("error", true, false);
    for (const view of [offline, error]) {
      expect(view.label).not.toMatch(/saved on server|all changes saved/i);
    }
  });
});
