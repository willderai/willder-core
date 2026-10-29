import { describe, expect, it } from "vitest";
import { isVisibleAuditRow, visibleAuditRowSql } from "./visibility";

// The canonical definition of which AuditLog rows every audit-adjacent screen
// shows. An access.manage allow row needs target-level discrimination (real
// mutation vs. probe/list read), since both share the one action. An
// access.manage deny row is always shown: a refusal is what an org reads its
// trail for, and only callers without the permission produce one.

describe("isVisibleAuditRow", () => {
  it("memory.read/memory.write/memory.delete are always visible, target aside", () => {
    expect(isVisibleAuditRow("memory.read", null, "allow")).toBe(true);
    expect(isVisibleAuditRow("memory.write", "anything", "allow")).toBe(true);
    expect(isVisibleAuditRow("memory.delete", null, "allow")).toBe(true);
  });

  // memory.entity is an ordinary always-visible memory action; nothing about
  // it needs target-level discrimination the way access.manage does.
  it("memory.entity is always visible, target aside", () => {
    expect(isVisibleAuditRow("memory.entity", "org_1/entity_1", "allow")).toBe(true);
    expect(isVisibleAuditRow("memory.entity", null, "allow")).toBe(true);
  });

  // Allow-case: real access.manage mutations, stored as `${targetPath}/${req.target}`
  // by check.ts's recordAudit (e.g. "org_1.dept/grants:create:org_1.dept").
  it("allow-case: grants:create mutation is visible", () => {
    expect(isVisibleAuditRow("access.manage", "org_1.dept/grants:create:org_1.dept", "allow")).toBe(true);
  });

  it("allow-case: grants:revoke mutation is visible", () => {
    expect(isVisibleAuditRow("access.manage", "org_1.dept/grants:revoke:grant_cuid_1", "allow")).toBe(true);
  });

  it("allow-case: fact_dispute resolve mutation is visible", () => {
    expect(isVisibleAuditRow("access.manage", "org_1.dept/fact_dispute:dispute_cuid_1", "allow")).toBe(true);
  });

  it("allow-case: a leak-report revocation is visible, an admin token revoke check is not", () => {
    expect(isVisibleAuditRow("access.manage", "org_1.dept/capabilities:leak-revoke:cap_1", "allow")).toBe(true);
    expect(isVisibleAuditRow("access.manage", "org_1.dept/capabilities:revoke:cap_1", "allow")).toBe(false);
  });

  // Probe/list reads over the same action, recorded as allow rows, real target strings
  // written by app/api/access/grants/route.ts's GET and
  // app/api/facts/disputes/route.ts's GET.
  it("allow-case probe: grants:list probe read stays invisible", () => {
    expect(isVisibleAuditRow("access.manage", "org_1/grants:list", "allow")).toBe(false);
  });

  it("allow-case probe: fact_disputes (plural, no id) probe read stays invisible", () => {
    expect(isVisibleAuditRow("access.manage", "org_1.dept/fact_disputes", "allow")).toBe(false);
  });

  it("allow-case probe: a null target on access.manage stays invisible", () => {
    expect(isVisibleAuditRow("access.manage", null, "allow")).toBe(false);
  });

  // capabilities:*/scopes:* access.manage targets are not markers and stay
  // invisible.
  it("out of boundary: capabilities/scopes access.manage targets stay invisible", () => {
    expect(isVisibleAuditRow("access.manage", "org_1.dept/capabilities:issue:org_1.dept", "allow")).toBe(false);
    expect(isVisibleAuditRow("access.manage", "org_1/scopes:create:org_1", "allow")).toBe(false);
    expect(isVisibleAuditRow("access.manage", "org_1.dept/scopes:delete:org_1.dept", "allow")).toBe(false);
  });

  // The write-effect rows say which partition a destructive write
  // actually executed against, which is the half of the story check()'s own
  // authorization row cannot tell. Ordinary always-visible memory actions.
  it("the write-effect actions are always visible, target aside", () => {
    expect(isVisibleAuditRow("memory.write.effect", null, "allow")).toBe(true);
    expect(isVisibleAuditRow("memory.delete.effect", "anything", "allow")).toBe(true);
  });

  // These are declared members of the map and they stay hidden -- they are
  // internal linkage and staleness plumbing, not something an org reads.
  // Pinned so a visibility flip has to be deliberate.
  it("the other derived actions stay invisible", () => {
    expect(isVisibleAuditRow("memory.read.factIds", "org_1/fact_1", "allow")).toBe(false);
    expect(isVisibleAuditRow("memory.write.applied", "org_1/fact_1", "allow")).toBe(false);
    expect(isVisibleAuditRow("memory.delete.applied", "org_1/fact_1", "allow")).toBe(false);
    expect(isVisibleAuditRow("brief.acknowledged", "org_1/brief:b1/acknowledged", "allow")).toBe(false);
  });

  // A refusal at an admin gate is shown whatever its target, including the
  // targets whose allow rows stay hidden as probe noise.
  it("every access.manage deny row is visible, target aside", () => {
    for (const target of [
      "org_1/grants:list",
      "org_1/audit:list",
      "org_1/scopes:create:org_1.dept",
      "org_1.dept/scopes:delete:org_1.dept",
      "org_1/capabilities:issue:org_1",
      "org_1/capabilities:revoke:cap_1",
      "org_1/audit:timeline:change_1",
      null,
    ]) {
      expect(isVisibleAuditRow("access.manage", target, "deny"), String(target)).toBe(true);
    }
  });

  it("a deny row of a never-visible action stays hidden", () => {
    expect(isVisibleAuditRow("memory.write.applied", "org_1/fact_1", "deny")).toBe(false);
    expect(isVisibleAuditRow("something.unheard-of", "org_1/fact_1", "deny")).toBe(false);
  });

  it("a genuinely unknown action is never visible", () => {
    expect(isVisibleAuditRow("something.unheard-of", "org_1/fact_1", "allow")).toBe(false);
  });
});

// The two forms must agree on the new actions the same way they already agree
// on the old ones: an action the JS predicate shows but the SQL filter omits
// is a row the audit page would claim to display and never return.
describe("visibleAuditRowSql — the write-effect actions reach the query", () => {
  it("binds both effect actions into the always-visible IN list", () => {
    const values = visibleAuditRowSql().values;
    expect(values).toContain("memory.write.effect");
    expect(values).toContain("memory.delete.effect");
  });

  it("binds none of the actions declared never-visible", () => {
    const values = visibleAuditRowSql().values;
    for (const action of [
      "memory.read.factIds",
      "memory.write.applied",
      "memory.delete.applied",
      "brief.acknowledged",
    ]) {
      expect(values, action).not.toContain(action);
    }
  });
});

describe("visibleAuditRowSql — access.manage refusals reach the query", () => {
  it("emits a deny leg for access.manage, derived from the map", () => {
    const fragment = visibleAuditRowSql();
    expect(fragment.sql).toMatch(/\("action" = \? AND "decision" = 'deny'\)/);
    // The action literal is bound once for its marker leg and once for its deny leg.
    expect(fragment.values.filter((v) => v === "access.manage")).toHaveLength(2);
  });
});
