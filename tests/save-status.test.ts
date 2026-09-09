/**
 * Save-status presentation mapping tests (M007/M008).
 *
 * The truthfulness rules from docs/FAILURE_MODEL.md §1 are contract:
 * - offline/error states must say edits are saved locally;
 * - nothing is presented as server-saved before the durable point;
 * - conflict is the highest-precedence state.
 */
import { describe, expect, it } from "vitest";

import { toSaveStatusView } from "@/lib/collaboration/save-status";

describe("toSaveStatusView", () => {
  it("shows offline with local-save wording when the browser is offline, regardless of mirror status", () => {
    for (const status of ["idle", "saving", "error"] as const) {
      const view = toSaveStatusView(status, false);
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
    const view = toSaveStatusView("conflict", false);
    expect(view.state).toBe("conflict");
    expect(view.description).toContain("another tab");
  });

  it("idle+online is presented as saved on the server (durable point reached)", () => {
    const view = toSaveStatusView("idle", true);
    expect(view.state).toBe("saved-mirror");
    expect(view.label).toBe("Saved");
    expect(view.description).toContain("server");
    expect(view.prominent).toBe(false);
  });

  it("saving is transient and quiet", () => {
    const view = toSaveStatusView("saving", true);
    expect(view.state).toBe("saving");
    expect(view.label).toBe("Saving…");
    expect(view.prominent).toBe(false);
  });

  it("mirror errors are retry wording with the local-safety guarantee", () => {
    const view = toSaveStatusView("error", true);
    expect(view.state).toBe("error");
    expect(view.label).toContain("Retrying");
    expect(view.description).toContain("safe on this device");
    expect(view.prominent).toBe(true);
  });

  it("never claims cloud/server save for offline or error states", () => {
    const offline = toSaveStatusView("idle", false);
    const error = toSaveStatusView("error", true);
    for (const view of [offline, error]) {
      expect(view.label).not.toMatch(/saved on server|all changes saved/i);
    }
  });
});
