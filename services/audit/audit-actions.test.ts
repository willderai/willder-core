import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, auditActionLabel } from "./audit-actions";
import type { AccessAction, DerivedAuditAction } from "@/services/access";

// AUDIT_ACTIONS is the one Record that holds both the target-aware
// visibility rule and the label for every action. These are guard-removal
// tests: each pins a property that only holds because AUDIT_ACTIONS is
// declared as Record<AccessAction, AuditActionMeta> (a missing key is a
// TypeScript compile error) rather than a weaker type an edit could quietly
// widen (Partial<Record<...>>, Record<string, ...>) without any test catching
// it.

// The canonical, exhaustive list of AccessAction members. Kept here as a
// literal (not derived from AUDIT_ACTIONS' own keys, which would make this
// test trivially circular) so a change to the AccessAction union that
// doesn't update this list -- the guard-removal scenario itself -- is
// exactly what makes the "every member has an entry" test below meaningful.
const ALL_ACCESS_ACTIONS: AccessAction[] = [
  "memory.read",
  "memory.entity",
  "memory.write",
  "memory.delete",
  "access.manage",
];

// The map is keyed on AuditAction, which is AccessAction plus the
// actions the additive recorders in services/access/check.ts write after the
// fact -- rows that are not authorization decisions and that check() can never
// be asked to evaluate. Same literal-not-derived rule as the list above.
const ALL_DERIVED_ACTIONS: DerivedAuditAction[] = [
  "memory.read.factIds",
  "memory.write.declassified",
  "memory.write.applied",
  "memory.delete.applied",
  "memory.write.effect",
  "memory.delete.effect",
  "brief.acknowledged",
  "brief.unretired",
  "capability.refused",
  "access.refused",
  "source.widening.acknowledged",
  "person.erased",
  "person.erasure_step",
  "person.erasure_failed",
  "oauth.disconnected",
  "record.removed",
];

const ALL_AUDIT_ACTIONS = [...ALL_ACCESS_ACTIONS, ...ALL_DERIVED_ACTIONS];

describe("AUDIT_ACTIONS", () => {
  it("has an entry for every AuditAction member, no more and no fewer", () => {
    expect(Object.keys(AUDIT_ACTIONS).sort()).toEqual([...ALL_AUDIT_ACTIONS].sort());
  });

  it("gives every member a non-empty label and an explicit visibility rule", () => {
    for (const action of ALL_AUDIT_ACTIONS) {
      const meta = AUDIT_ACTIONS[action];
      expect(meta, `missing AUDIT_ACTIONS entry for ${action}`).toBeDefined();
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.label).not.toBe(action);
      expect(meta.visibility === "always" || meta.visibility === "never" || typeof meta.visibility === "object").toBe(
        true,
      );
    }
  });

  // The two actions a hand-kept allowlist most easily drops: every audit
  // surface records them, so every surface must display them.
  it("memory.entity is always-visible and access.manage is target-conditional for allows, always for denies", () => {
    expect(AUDIT_ACTIONS["memory.entity"].visibility).toBe("always");
    expect(AUDIT_ACTIONS["access.manage"].visibility).toEqual({
      targetContains: [
        "grants:create:",
        "grants:revoke:",
        "fact_dispute:",
        "capabilities:leak-revoke:",
        "audit:export:",
      ],
      denyAlways: true,
    });
  });

  // The whole point of one Record: the row filter and the display label can
  // no longer disagree about which actions exist. A visible action with no
  // real label would render as its raw string in the Action column.
  it("every action the visibility rule can surface also has a real label", () => {
    for (const action of ALL_AUDIT_ACTIONS) {
      if (AUDIT_ACTIONS[action].visibility === "never") continue;
      expect(auditActionLabel(action)).toBe(AUDIT_ACTIONS[action].label);
    }
  });
});

// The two effect actions are the only derived actions that are meant to be
// read by a human, so they are the only ones that are not "never".
describe("AUDIT_ACTIONS — the write-effect actions", () => {
  it("memory.write.effect and memory.delete.effect are always visible", () => {
    expect(AUDIT_ACTIONS["memory.write.effect"].visibility).toBe("always");
    expect(AUDIT_ACTIONS["memory.delete.effect"].visibility).toBe("always");
  });

  it("the other derived actions stay hidden", () => {
    for (const action of [
      "memory.read.factIds",
      "memory.write.applied",
      "memory.delete.applied",
      "brief.acknowledged",
    ] as const) {
      expect(AUDIT_ACTIONS[action].visibility, action).toBe("never");
    }
  });
});

describe("auditActionLabel", () => {
  it("labels memory.entity and access.manage specifically, not as raw strings", () => {
    expect(auditActionLabel("memory.entity")).toBe("Viewed entity");
    expect(auditActionLabel("access.manage")).toBe("Managed access");
  });

  it("falls back to the raw string for a genuinely unknown action", () => {
    expect(auditActionLabel("something.unheard-of")).toBe("something.unheard-of");
  });
});
