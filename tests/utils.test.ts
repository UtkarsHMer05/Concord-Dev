import { describe, expect, it } from "vitest";

import { cn } from "../src/lib/utils";

describe("cn class merger", () => {
  it("merges class names", () => {
    expect(cn("a", "b")).toContain("a");
    expect(cn("a", "b")).toContain("b");
  });

  it("resolves conflicting tailwind classes keeping the last", () => {
    const result = cn("px-2", "px-4");
    expect(result).toContain("px-4");
    expect(result).not.toContain("px-2 ");
  });

  it("drops falsy values", () => {
    expect(cn("a", undefined, false && "b", null, "c")).toBe("a c");
  });
});
