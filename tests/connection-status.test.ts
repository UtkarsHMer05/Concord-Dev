/**
 * Gateway connection status mapping tests (M008).
 *
 * Every SyncSession ConnectionStatus vocabulary entry must map to honest
 * user language. The truthfulness rules (FAILURE_MODEL §1):
 * - "Connected" describes the channel, never peer application;
 * - non-ready states always promise local edit safety;
 * - no state may read as "saved to server" — only durable acks justify
 *   that, and the save-status view owns that claim.
 */
import { describe, expect, it } from "vitest";

import { toConnectionStatusView } from "@/lib/collaboration/connection-status";

describe("toConnectionStatusView", () => {
  it("maps every vocabulary entry", () => {
    const vocabulary = [
      "disconnected",
      "connecting",
      "authenticated",
      "joining",
      "syncing",
      "ready",
      "reconnecting",
      "draining",
      "closed",
    ] as const;
    for (const status of vocabulary) {
      const view = toConnectionStatusView(status);
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.description.length).toBeGreaterThan(10);
    }
  });

  it("ready reads as connected; nothing else claims live sync", () => {
    expect(toConnectionStatusView("ready").label).toBe("Connected");
    for (const status of ["disconnected", "reconnecting", "draining", "closed", "connecting", "joining", "syncing", "authenticated"] as const) {
      expect(toConnectionStatusView(status).label).not.toBe("Connected");
    }
  });

  it("transient-loss states promise local edit safety", () => {
    for (const status of ["reconnecting", "draining", "disconnected", "closed"] as const) {
      const view = toConnectionStatusView(status);
      expect(view.description).toContain("saved locally");
    }
  });

  it("reconnecting and draining are prominent; the rest stay quiet", () => {
    expect(toConnectionStatusView("reconnecting").prominent).toBe(true);
    expect(toConnectionStatusView("draining").prominent).toBe(true);
    for (const status of ["ready", "connecting", "joining", "syncing", "disconnected", "closed", "authenticated"] as const) {
      expect(toConnectionStatusView(status).prominent).toBe(false);
    }
  });

  it("never claims server-saved wording in any connection state", () => {
    const vocabulary = [
      "disconnected", "connecting", "authenticated", "joining", "syncing",
      "ready", "reconnecting", "draining", "closed",
    ] as const;
    for (const status of vocabulary) {
      expect(toConnectionStatusView(status).label.toLowerCase()).not.toContain("saved to server");
      expect(toConnectionStatusView(status).label.toLowerCase()).not.toContain("cloud");
    }
  });
});
