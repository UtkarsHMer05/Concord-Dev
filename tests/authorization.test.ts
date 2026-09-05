import { describe, expect, it } from "vitest";

import {
  assertCapability,
  CAPABILITIES,
  resolveEffectiveRole,
  roleHasCapability,
  type Capability,
  type EffectiveRole,
} from "../src/server/auth/authorization";
import type { ActorContext } from "../src/server/auth/actor-context";
import {
  ForbiddenError,
  ValidationError,
} from "../src/server/errors";
import {
  toActionError,
  type ActionErrorType,
} from "../src/server/result";
import {
  ConflictError,
  DependencyError,
  NotFoundError,
  UnauthenticatedError,
} from "../src/server/errors";

/**
 * M021/M043: exhaustive capability-matrix proofs (docs/AUTHORIZATION.md §3-4).
 * Pure unit tests — no UI, no DB, no Clerk.
 */

const ACTOR: ActorContext = {
  userId: "11111111-1111-1111-1111-111111111111",
  clerkUserId: "user_test",
  organization: null,
};

function actorInOrg(orgId: string): ActorContext {
  return { ...ACTOR, organization: { id: orgId, clerkOrganizationId: "org_1", role: "member" } };
}

const DOC = {
  ownerUserId: ACTOR.userId,
  organizationId: null as string | null,
};

const ALL_ROLES: EffectiveRole[] = ["OWNER", "EDITOR", "COMMENTER", "VIEWER"];
const ALL_CAPABILITIES: Capability[] = [
  "read",
  "editContent",
  "rename",
  "delete",
  "managePermissions",
  "comment",
];

// The capability matrix from docs/AUTHORIZATION.md §3:
const EXPECTED: Record<Capability, EffectiveRole[]> = {
  read: ["OWNER", "EDITOR", "COMMENTER", "VIEWER"],
  editContent: ["OWNER", "EDITOR"],
  rename: ["OWNER", "EDITOR"],
  delete: ["OWNER"],
  managePermissions: ["OWNER"],
  comment: ["OWNER", "EDITOR", "COMMENTER"],
};

describe("capability matrix", () => {
  for (const capability of ALL_CAPABILITIES) {
    it(`capability "${capability}" grants exactly the documented roles`, () => {
      for (const role of ALL_ROLES) {
        const granted = roleHasCapability(role, capability);
        const expected = EXPECTED[capability].includes(role);
        expect(granted, `${role}.${capability}`).toBe(expected);
      }
      // Deny-by-default: null role never has any capability.
      expect(roleHasCapability(null, capability)).toBe(false);
    });
  }

  it("declares OWNER as the minimum role for security-critical capabilities", () => {
    expect(CAPABILITIES.delete).toEqual(["OWNER"]);
    expect(CAPABILITIES.managePermissions).toEqual(["OWNER"]);
  });

  it("never grants content edit to COMMENTER or VIEWER", () => {
    expect(CAPABILITIES.editContent).not.toContain("COMMENTER");
    expect(CAPABILITIES.editContent).not.toContain("VIEWER");
  });
});

describe("effective role resolution", () => {
  it("owner wins even when an ACL row would say less", () => {
    const role = resolveEffectiveRole(ACTOR, DOC, "VIEWER");
    expect(role).toBe("OWNER");
  });

  it("owner wins even inside an organization document", () => {
    const doc = { ...DOC, organizationId: "org-uuid" };
    expect(resolveEffectiveRole(ACTOR, doc, null)).toBe("OWNER");
  });

  it("direct ACL grant applies for non-owners", () => {
    const other = { ...ACTOR, userId: "22222222-2222-2222-2222-222222222222" };
    // DOC is owned by ACTOR; `other` is not the owner.
    const doc = { ...DOC, ownerUserId: ACTOR.userId };
    expect(resolveEffectiveRole(other, doc, "COMMENTER")).toBe("COMMENTER");
  });

  it("organization membership yields EDITOR on org documents", () => {
    const doc = { ...DOC, organizationId: "org-uuid", ownerUserId: "99999999-9999-9999-9999-999999999999" };
    expect(resolveEffectiveRole(actorInOrg("org-uuid"), doc, null)).toBe("EDITOR");
  });

  it("organization membership does NOT grant personal documents", () => {
    const doc = { ...DOC, organizationId: null, ownerUserId: "99999999-9999-9999-9999-999999999999" };
    expect(resolveEffectiveRole(actorInOrg("org-uuid"), doc, null)).toBeNull();
  });

  it("membership in a DIFFERENT organization does not grant access", () => {
    const doc = { ...DOC, organizationId: "org-uuid", ownerUserId: "99999999-9999-9999-9999-999999999999" };
    expect(resolveEffectiveRole(actorInOrg("other-org"), doc, null)).toBeNull();
  });

  it("no resolvable context denies (deny-by-default)", () => {
    const doc = { ...DOC, ownerUserId: "99999999-9999-9999-9999-999999999999" };
    expect(resolveEffectiveRole(ACTOR, doc, null)).toBeNull();
  });

  it("direct grant takes precedence over the organization-derived role (never additive)", () => {
    // Same user: member of the owning org (→ EDITOR) but downgraded to
    // VIEWER by a direct grant; the direct grant wins.
    const other = { ...ACTOR, userId: "22222222-2222-2222-2222-222222222222" };
    const doc = {
      ownerUserId: "99999999-9999-9999-9999-999999999999",
      organizationId: "org-uuid",
    };
    const otherInOrg = {
      ...other,
      organization: { id: "org-uuid", clerkOrganizationId: "org_1", role: "member" as const },
    };
    expect(resolveEffectiveRole(otherInOrg, doc, null)).toBe("EDITOR");
    expect(resolveEffectiveRole(otherInOrg, doc, "VIEWER")).toBe("VIEWER");
  });
});

describe("assertCapability", () => {
  it("returns the role when granted", () => {
    expect(assertCapability("EDITOR", "editContent")).toBe("EDITOR");
    expect(assertCapability("VIEWER", "read")).toBe("VIEWER");
  });

  it("throws ForbiddenError when denied", () => {
    expect(() => assertCapability("VIEWER", "editContent")).toThrow(ForbiddenError);
    expect(() => assertCapability("EDITOR", "delete")).toThrow(ForbiddenError);
    expect(() => assertCapability(null, "read")).toThrow(ForbiddenError);
  });
});

describe("error mapping to client-safe results", () => {
  const CASES: Array<[unknown, ActionErrorType]> = [
    [new UnauthenticatedError(), "unauthenticated"],
    [new NotFoundError(), "not_found"],
    [new ForbiddenError(), "forbidden"],
    [new ConflictError(), "conflict"],
    [new ValidationError(), "validation"],
    [new DependencyError(), "dependency"],
    [new Error("internal detail with secrets"), "unknown"],
    ["a string", "unknown"],
  ];

  for (const [error, expectedType] of CASES) {
    it(`maps ${error instanceof Error ? error.constructor.name : typeof error} to "${expectedType}" with a user-safe message`, () => {
      const result = toActionError(error);
      expect(result.type).toBe(expectedType);
      expect(result.message).not.toContain("secrets");
      expect(result.message.length).toBeGreaterThan(0);
    });
  }
});
