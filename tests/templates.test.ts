import { describe, expect, it } from "vitest";

import { templates } from "../src/constants/templates";

describe("document templates", () => {
  it("exposes a non-empty template list", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it("gives every template a unique id and required fields", () => {
    const ids = templates.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of templates) {
      expect(t.id).toBeTruthy();
      expect(t.label).toBeTruthy();
      expect(t.imageUrl).toMatch(/^\/.*\.svg$/);
      expect(typeof t.initialContent).toBe("string");
    }
  });

  it("provides non-empty initial content for every template except blank", () => {
    for (const t of templates) {
      if (t.id === "blank") {
        expect(t.initialContent).toBe("");
      } else {
        expect(t.initialContent.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
