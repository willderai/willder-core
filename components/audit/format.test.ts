import { describe, expect, it } from "vitest";
import {
  AGENT_TOKEN_MARKER,
  agentKeyMarker,
  displayWriterLabel,
  formatDuration,
  parseAction,
  parseTarget,
  scopeLabel,
  splitWriterLabel,
  tokenShortId,
  truncateWriterLabel,
} from "./format";
import { AUDIT_ACTIONS } from "@/services/audit/audit-actions";

// item audit-visibility-map-fix: parseAction used to be a switch with a
// `default: return action` fallback — every AccessAction not explicitly
// listed (memory.entity, access.manage) silently rendered as its raw string
// instead of a real label. Now backed by the same exhaustive AUDIT_ACTIONS
// map the row-visibility rule shares, so a newly added action can't drop out
// of just this one display.

describe("parseAction", () => {
  it("labels every known AccessAction from AUDIT_ACTIONS, not the raw string", () => {
    for (const [action, meta] of Object.entries(AUDIT_ACTIONS)) {
      expect(parseAction(action)).toBe(meta.label);
    }
  });

  // Guard-removal: pins the two actions that were actually missing before
  // this fix. If parseAction regresses to a switch/lookup that forgot these,
  // this fails with the raw action string instead of a real label.
  it("labels memory.entity and access.manage specifically", () => {
    expect(parseAction("memory.entity")).toBe("Viewed entity");
    expect(parseAction("access.manage")).toBe("Managed access");
  });

  it("falls back to the raw string for a genuinely unknown action (not a narrowing regression)", () => {
    expect(parseAction("something.unheard-of")).toBe("something.unheard-of");
  });
});

// The `entity:`/`fact:` tag in a target names the record's TYPE, not the row's
// verb: one `entity:<id>` tag is written for both a `memory.delete`
// authorization row and its `memory.delete.effect` counterpart, and `fact:<id>`
// covers a delete as well as a `memory.write` provenance link. The What column
// therefore shows the type and the Action column shows the verb. Record ids
// are opaque graph uuids, so the type is the only thing that separates an
// entity removal from a fact removal.
describe("parseTarget", () => {
  it("keeps bare scope authorization targets in their actual partition", () => {
    expect(parseTarget("org_acme.engineering")).toEqual({ scope: "Engineering", what: "Scope", recordId: undefined });
    expect(parseTarget("group:acme.support")).toEqual({
      scope: "Untagged › Support",
      what: "Scope",
      recordId: undefined,
    });
  });
  it("labels an entity removal differently from a fact removal", () => {
    const entity = parseTarget("org_acme.sales/entity:0b6f2c1e-9d4a-4f3e-8a11-2c7d5e9f0a13");
    const fact = parseTarget("org_acme.sales/fact:7e3a9b40-1c2d-4e5f-9a8b-6c7d8e9f0a1b");
    expect(entity.what).toBe("Entity");
    expect(fact.what).toBe("Fact");
    expect(entity.what).not.toBe(fact.what);
  });

  it("never repeats a verb, so a delete row cannot read as a view", () => {
    for (const target of ["org_acme.sales/entity:ent_123", "org_acme.sales/fact:f_1"]) {
      const { what } = parseTarget(target);
      for (const meta of Object.values(AUDIT_ACTIONS)) {
        expect(what).not.toBe(meta.label);
      }
    }
  });

  it("keeps the record id visible for cross-reference", () => {
    expect(parseTarget("org_acme.sales/entity:ent_123").recordId).toBe("ent_123");
    expect(parseTarget("org_acme.sales/fact:f_1").recordId).toBe("f_1");
  });

  it("leaves query and graph targets alone", () => {
    expect(parseTarget("org_acme.sales/query:revenue").what).toBe('"revenue"');
    expect(parseTarget("graph").what).toBe("Explored graph");
  });
});

// The three access.manage mutation markers (AUDIT_ACTIONS["access.manage"]
// .visibility) reach GET /api/audit and used to render as raw internal
// strings in the What column.
describe("parseTarget — access.manage mutation markers", () => {
  it("labels a grant creation without repeating the scope already shown separately", () => {
    // app/api/access/grants/route.ts writes `grants:create:${scope.path}`,
    // and recordAudit() prefixes that same scope path, so only the outer
    // one is a useful label.
    expect(parseTarget("org_x.eng/grants:create:org_x.eng")).toEqual({
      scope: "Eng",
      what: "New grant",
      recordId: undefined,
    });
  });

  it("labels a grant creation on the org root scope", () => {
    expect(parseTarget("org_x/grants:create:org_x")).toEqual({
      scope: "Org root",
      what: "New grant",
      recordId: undefined,
    });
  });

  it("labels a grant revocation and keeps the grant id for cross-reference", () => {
    expect(parseTarget("org_x.eng/grants:revoke:grant_xyz789")).toEqual({
      scope: "Eng",
      what: "Revoked grant",
      recordId: "grant_xyz789",
    });
  });

  it("labels a token revoked after a GitHub leak report and keeps the capability id", () => {
    expect(parseTarget("org_x.eng/capabilities:leak-revoke:cap_123")).toEqual({
      scope: "Eng",
      what: "Leaked token revoked",
      recordId: "cap_123",
    });
  });

  it("labels an audit log export with the range it covered", () => {
    expect(parseTarget("org_x.eng/audit:export:2026-09-01T00:00:00.000Z..2026-10-01T00:00:00.000Z")).toEqual({
      scope: "Eng",
      what: "Exported audit log 2026-09-01T00:00:00.000Z..2026-10-01T00:00:00.000Z",
      recordId: undefined,
    });
  });

  it("labels a dispute resolution and keeps the dispute id for cross-reference", () => {
    expect(parseTarget("org_x.eng/fact_dispute:disp_456")).toEqual({
      scope: "Eng",
      what: "Resolved dispute",
      recordId: "disp_456",
    });
  });

  it("renders the probe/list markers raw rather than matching a mutation branch", () => {
    // These are filtered server-side and should never reach the client.
    expect(parseTarget("org_x.eng/grants:list").what).toBe("grants:list");
    expect(parseTarget("org_x.eng/fact_disputes").what).toBe("fact_disputes");
  });
});

describe("formatDuration", () => {
  it("picks the unit that keeps a latency readable", () => {
    expect(formatDuration(840)).toBe("840 ms");
    expect(formatDuration(6496)).toBe("6.5 s");
    expect(formatDuration(252_000)).toBe("4.2 min");
    expect(formatDuration(4_680_000)).toBe("1.3 h");
  });
});

describe("parseTarget for a Timeline change read", () => {
  it("names the opened change and keeps its id", () => {
    expect(parseTarget("org_c1.crew/change:ch1")).toMatchObject({ what: "Opened change", recordId: "ch1" });
  });
});

describe("scopeLabel", () => {
  it("labels a bare scope path by its descendants, not as the org root", () => {
    expect(scopeLabel("org_c1")).toBe("Org root");
    expect(scopeLabel("org_c1.crew_1c5b79.docs_36c2d6")).toBe("Crew_1c5b79 › Docs_36c2d6");
  });
});

describe("tokenShortId", () => {
  // Two real-shaped cuids minted in the same minute: their first eight
  // characters are the shared timestamp, so a prefix could not tell them apart.
  it("gives tokens minted moments apart different short ids", () => {
    const first = "cmg6k2m1p0001l804a7f3x9qz";
    const second = "cmg6k2m1q0002l804k2d8w4vn";
    expect(first.slice(0, 8)).toBe(second.slice(0, 8));
    expect(tokenShortId(first)).toBe("a7f3x9qz");
    expect(tokenShortId(second)).toBe("k2d8w4vn");
  });
});

describe("truncateWriterLabel", () => {
  const REAL = "Architecture agent Agent";
  const SPOOF = `Architecture agent Agent${agentKeyMarker("custom-1")}`;

  it("cuts the name and keeps the whole marker, so a marked label never truncates to a product label", () => {
    expect(truncateWriterLabel(SPOOF, 22)).toBe('A… (agent key "custom-1")');
    expect(truncateWriterLabel(SPOOF, 40)).toBe('Architecture age… (agent key "custom-1")');
    expect(truncateWriterLabel(SPOOF, 22)).not.toBe(truncateWriterLabel(REAL, 22));
  });

  it("cuts an unmarked label at the end, and leaves a short label alone", () => {
    expect(truncateWriterLabel(REAL, 22)).toBe("Architecture agent Ag…");
    expect(truncateWriterLabel("QA agent Agent", 22)).toBe("QA agent Agent");
  });

  it("keeps a token label's marker", () => {
    expect(truncateWriterLabel(`"a-very-long-free-text-agent-id"${AGENT_TOKEN_MARKER}`, 22)).toBe(
      '"a-very… (agent token)',
    );
  });
});

describe("splitWriterLabel", () => {
  it("splits only the product's own markers off a label", () => {
    expect(splitWriterLabel(`QA agent Agent${agentKeyMarker('cu"st')}`)).toEqual({
      name: "QA agent Agent",
      marker: ' (agent key "cu\\"st")',
    });
    expect(splitWriterLabel("Agent Sam (synthetic)")).toEqual({ name: "Agent Sam (synthetic)", marker: "" });
  });
});

describe("displayWriterLabel", () => {
  it("escapes bidi controls so the label is drawn in stored order, and leaves other labels alone", () => {
    expect(displayWriterLabel("‮metsyS‬ Agent")).toBe("[U+202E]metsyS[U+202C] Agent");
    expect(displayWriterLabel("QA agent Agent")).toBe("QA agent Agent");
  });

  it("is applied before truncation, so the marker still survives", () => {
    expect(truncateWriterLabel(`‮metsyS‬ Agent${agentKeyMarker("custom-1")}`, 40)).toBe(
      '[U+202E]metsyS… (agent key "custom-1")',
    );
  });

  it("never cuts through an escaped control, at any width", () => {
    const TOKEN = /\[U\+[0-9A-F]{4}\]/g;
    const raw = `ab\u202Ecd\u2066ef\u202C\u2069gh long name${agentKeyMarker("custom-1")}`;
    const unmarked = "ab\u202Ecd\u2066ef\u202C\u2069gh long name";
    for (const label of [raw, unmarked]) {
      for (let max = 1; max <= displayWriterLabel(label).length; max++) {
        const { name } = splitWriterLabel(truncateWriterLabel(label, max));
        const stripped = name.replace(TOKEN, "");
        expect(stripped, `max=${max}: ${name}`).not.toContain("[");
      }
    }
    expect(truncateWriterLabel(unmarked, 12)).toBe("ab[U+202E]c…");
    expect(truncateWriterLabel(unmarked, 10)).toBe("ab…");
  });
});
