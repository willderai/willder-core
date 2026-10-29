import { describe, expect, it } from "vitest";
import { AUDIT_ORIGINS, type AuditOrigin } from "@/services/access/origin";
import { AU3_FIELDS, TIMELINE_EVENT_KINDS, au3Gaps, au3Records } from "./au3";
import { buildTimeline, type Timeline, type TimelineReadInput, type TimelineWriteInput } from "./timeline";

const CREW = "org_acme.crew_1c5b79";
const t = (seconds: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, seconds));
const ORIGINS = Object.keys(AUDIT_ORIGINS) as AuditOrigin[];

function write(id: string, extra: Partial<TimelineWriteInput> = {}): TimelineWriteInput {
  return {
    id,
    at: t(1),
    actorType: "agent",
    actorId: "agent-writer",
    origin: "mcp",
    scopePath: CREW,
    op: "create",
    recordType: "fact",
    recordId: `rec-${id}`,
    ...extra,
  };
}

function read(id: string, extra: Partial<TimelineReadInput> = {}): TimelineReadInput {
  return {
    id,
    at: t(30),
    actorType: "agent",
    actorId: "agent-reader",
    origin: "mcp",
    action: "memory.read",
    target: CREW,
    decision: "allow",
    ...extra,
  };
}

/** One timeline holding every event kind, from every writer type and every origin. */
function everyKind(): Timeline {
  const writes: TimelineWriteInput[] = [
    write("fact-by-agent"),
    write("fact-by-person", { actorType: "human", actorId: "user-1", origin: "app" }),
    write("fact-by-sync", { actorType: "extraction", actorId: "slack-sync:src_1", origin: "connector-sync" }),
    write("fact-delete", { op: "delete", origin: "api" }),
    write("fact-supersede", { op: "supersede", origin: "agent-run" }),
    write("brief", { recordType: "brief", origin: "agent-run" }),
    write("brief-erased", { recordType: "brief", op: "delete", actorType: "human", actorId: "user-1", origin: "app" }),
    write("source", { recordType: "source", op: "update", actorType: "human", actorId: "user-1", origin: "app" }),
    write("convention", { recordType: "convention", origin: "mcp" }),
    write("document", { recordType: "document", origin: "app" }),
    write("by-script", { origin: "script" }),
    write("by-webhook", { actorType: "extraction", actorId: "github-secret-scanning", origin: "webhook" }),
  ];
  const reads: TimelineReadInput[] = [
    read("read-1"),
    read("deny-read", { decision: "deny", actorType: "human", actorId: "user-2", origin: "app" }),
    read("deny-entity", { decision: "deny", action: "memory.entity", target: `${CREW}/entity:e1`, origin: "api" }),
  ];
  return buildTimeline({ writes, reads, names: new Map() });
}

/** The timeline's own keys whose values are lists of timestamped events, found at runtime. */
function eventListKeys(timeline: Timeline): string[] {
  return Object.entries(timeline)
    .filter(([, value]) => Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && "at" in value[0])
    .map(([key]) => key)
    .sort();
}

describe("AU-3 content of the audit timeline export", () => {
  it("maps every kind of event the timeline carries, found from the timeline itself", () => {
    const timeline = everyKind();
    expect(eventListKeys(timeline)).toEqual([...TIMELINE_EVENT_KINDS].sort());
    // Each kind is really present in the fixture, so the next test checks all of them.
    for (const kind of TIMELINE_EVENT_KINDS) expect(timeline[kind].length).toBeGreaterThan(0);
  });

  it("every event of every kind carries what, when, where, source, outcome and identity", () => {
    const records = au3Records(everyKind());
    expect(records.length).toBeGreaterThan(0);
    for (const { kind, id, record } of records) {
      expect({ kind, id, gaps: au3Gaps(record) }).toEqual({ kind, id, gaps: [] });
      expect(typeof record.what).toBe("string");
      expect(new Date(record.when!).toISOString()).toBe(record.when);
      expect(record.where).toMatch(/^org_[a-z0-9_]+(\.[a-z0-9_]+)*$/);
      expect(ORIGINS).toContain(record.source);
      expect(["success", "allow", "deny"]).toContain(record.outcome);
      expect(record.identity!.id).not.toBe("");
    }
    expect([...new Set(records.map((r) => r.kind))].sort()).toEqual([...TIMELINE_EVENT_KINDS].sort());
  });

  it("states each event's outcome rather than leaving it to be inferred", () => {
    const byId = new Map(au3Records(everyKind()).map((r) => [r.id, r.record]));
    expect(byId.get("fact-by-agent")!.outcome).toBe("success");
    expect(byId.get("read-1")!.outcome).toBe("allow");
    expect(byId.get("deny-read")!.outcome).toBe("deny");
    expect(byId.get("read-1")!.what).toBe("memory.read");
    expect(byId.get("deny-entity")!.what).toBe("memory.entity");
    expect(byId.get("fact-delete")!.what).toBe("fact.delete");
  });

  it("names a connector sync and a webhook as system principals, never as agents", () => {
    const byId = new Map(au3Records(everyKind()).map((r) => [r.id, r.record]));
    expect(byId.get("fact-by-sync")!.identity).toEqual({ type: "extraction", id: "slack-sync:src_1" });
    expect(byId.get("by-webhook")!.identity).toEqual({ type: "extraction", id: "github-secret-scanning" });
    expect(byId.get("fact-by-person")!.identity).toEqual({ type: "human", id: "user-1" });
  });

  it("reports a source that was never recorded as missing, not as a guess", () => {
    const timeline = buildTimeline({
      writes: [write("legacy", { origin: null })],
      reads: [read("legacy-read", { origin: null })],
      names: new Map(),
    });
    const gaps = au3Records(timeline).map((r) => [r.id, au3Gaps(r.record)]);
    expect(gaps).toEqual([
      ["legacy", ["source"]],
      ["legacy-read", ["source"]],
    ]);
  });

  it("rejects a malformed field as a gap, field by field", () => {
    const record = au3Records(everyKind())[0]!.record;
    expect(au3Gaps({ ...record, what: "" })).toEqual(["what"]);
    expect(au3Gaps({ ...record, when: "yesterday" })).toEqual(["when"]);
    expect(au3Gaps({ ...record, where: null })).toEqual(["where"]);
    expect(au3Gaps({ ...record, source: "carrier-pigeon" })).toEqual(["source"]);
    expect(au3Gaps({ ...record, outcome: null })).toEqual(["outcome"]);
    expect(au3Gaps({ ...record, identity: { type: "agent", id: "" } })).toEqual(["identity"]);
    expect(au3Gaps({ ...record, identity: { type: "robot", id: "x" } })).toEqual(["identity"]);
    expect(AU3_FIELDS).toEqual(["what", "when", "where", "source", "outcome", "identity"]);
  });
});
