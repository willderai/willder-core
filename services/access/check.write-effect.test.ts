// The write-effect audit row.
//
// check()'s own audit row records the scope a write was AUTHORIZED against.
// The write itself lands at `scope ?? input.groupId`, which is not always
// that same path (transferEntity's org-root case is the live example), so
// recordWriteEffect() writes a separate, linked row naming the executed
// partition, only after the real store mutation resolved.
//
// Naming it is not enough: the row has to name it in a form the audit screens
// can read back. The executed partition is usually a `group_id` (`<orgId>`,
// `<orgId>.<sub>`) while every target check() writes is a scope path
// (`org_<orgId>...`). Writing the raw string either way makes an unscoped
// delete, the default route path, render as "Org root" with an unparsed blob
// and no record id. resolveExecutedPartition() marks which namespace the
// string is in; see services/audit/audit-target.ts.
//
// Every fixture org id here is a realistic cuid, deliberately: a literal
// `org_1` begins with `org_` by coincidence and so parses as a scope path,
// hiding the defect completely.
//
// These tests drive the recorder directly against a mocked `db.auditLog.create`
// and assert on the row that reaches the database. The wiring from the three
// guarded-store writers is covered separately in
// services/memory/guarded-store.write-effect.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_effect_1" }) } },
}));

import { db } from "@/lib/db";
import {
  orgRootPath,
  recordWriteEffect,
  resolveExecutedPartition,
  type AccessContext,
  type AccessDecision,
} from "./check";
import { parseTarget } from "@/components/audit/format";

const ORG = "clx7k2m0a0000q1r3s5t7u9v1";
/** The untagged partition a write lands in when no scope is passed. */
const BARE = ORG;
/** The org-root scope path check() authorizes that same write against. */
const ROOT = orgRootPath(ORG);

const ctx = (runId?: string): AccessContext => ({
  orgId: ORG,
  actor: { type: "agent", id: "agent_1", capabilityToken: "tok_1" },
  origin: "mcp",
  runId,
});

const allowed = (auditLogId: string = "audit_1"): AccessDecision => ({
  allowed: true,
  reason: "grant covers scope",
  auditLogId,
});

/** An allow decision from a caller that never recorded an authorization row. */
const allowedUnlinked = (): AccessDecision => ({ allowed: true, reason: "grant covers scope" });

/** What a guarded writer passes: the partition it really ran against. */
const executed = (groupId: string) => resolveExecutedPartition(ORG, groupId);

const rowsWritten = () =>
  vi.mocked(db.auditLog.create).mock.calls.map((c) => (c[0] as { data: Record<string, unknown> }).data);

beforeEach(() => vi.clearAllMocks());

describe("resolveExecutedPartition", () => {
  it("marks a group_id so it cannot be read back as a scope path", () => {
    expect(resolveExecutedPartition(ORG, BARE)).toEqual({
      groupId: BARE,
      targetPath: `group:${BARE}`,
    });
    expect(resolveExecutedPartition(ORG, `${ORG}.engineering`)).toEqual({
      groupId: `${ORG}.engineering`,
      targetPath: `group:${ORG}.engineering`,
    });
  });

  it("leaves a scope path alone, since that is what every other target already is", () => {
    expect(resolveExecutedPartition(ORG, ROOT)).toEqual({ groupId: ROOT, targetPath: ROOT });
    expect(resolveExecutedPartition(ORG, `${ROOT}.engineering`)).toEqual({
      groupId: `${ROOT}.engineering`,
      targetPath: `${ROOT}.engineering`,
    });
  });

  // The prefix-sniffing defect, pinned directly. An org id that itself starts with
  // `org_` is exactly the case a `target.startsWith("org_")` test gets wrong:
  // the bare partition `org_1` is a group_id, and its org-root scope path is
  // the different string `org_org_1`. Anchoring on the org id tells them apart;
  // sniffing the prefix does not.
  it("still separates the namespaces for an org whose own id starts with org_", () => {
    expect(resolveExecutedPartition("org_1", "org_1")).toEqual({
      groupId: "org_1",
      targetPath: "group:org_1",
    });
    expect(resolveExecutedPartition("org_1", "org_org_1")).toEqual({
      groupId: "org_org_1",
      targetPath: "org_org_1",
    });
    expect(parseTarget("group:org_1/entity:e1").scope).not.toBe(parseTarget("org_org_1/entity:e1").scope);
  });

  // Unreachable through the guarded store, which calls assertTenant() first.
  // It throws rather than guessing a namespace because callers resolve before
  // the store mutation: failing here costs a rejected request, while a
  // mislabelled row silently misstates where a destructive write landed.
  it("refuses a partition belonging to neither namespace of this org", () => {
    expect(() => resolveExecutedPartition(ORG, "clx_someone_else.sales")).toThrow(
      /neither a group_id nor a scope path/,
    );
  });
});

describe("recordWriteEffect", () => {
  it("records the executed partition, linked to the authorizing audit row", async () => {
    await recordWriteEffect(ctx(), allowed("audit_1"), "memory.delete", executed(`${ORG}.engineering`), "fact:f1");

    expect(rowsWritten()).toEqual([
      {
        orgId: ORG,
        actorType: "agent",
        actorId: "agent_1",
        action: "memory.delete.effect",
        target: `group:${ORG}.engineering/fact:f1`,
        decision: "allow",
        metadata: { auditLogId: "audit_1", executedGroupId: `${ORG}.engineering`, origin: "mcp" },
        runId: undefined,
      },
    ]);
  });

  // metadata keeps the exact partition string the store ran against; only the
  // target carries the namespace marker, so the raw value stays queryable.
  it("keeps the raw group_id in metadata, unmarked", async () => {
    await recordWriteEffect(ctx(), allowed(), "memory.delete", executed(BARE), "fact:f1");

    expect(rowsWritten()[0]).toMatchObject({
      target: `group:${BARE}/fact:f1`,
      metadata: { auditLogId: "audit_1", executedGroupId: BARE, origin: "mcp" },
    });
  });

  it("uses memory.write.effect for a write and memory.delete.effect for a delete", async () => {
    await recordWriteEffect(ctx(), allowed(), "memory.write", executed(`${ORG}.sales`), "merge:A→B");
    await recordWriteEffect(ctx(), allowed(), "memory.delete", executed(`${ORG}.sales`), "fact:f1");

    expect(rowsWritten().map((d) => d.action)).toEqual(["memory.write.effect", "memory.delete.effect"]);
  });

  it("carries runId so two overlapping runs of one agent stay distinguishable", async () => {
    await recordWriteEffect(ctx("run_7"), allowed(), "memory.write", executed(`${ORG}.sales`), "fact:f1");

    expect(rowsWritten()[0]).toMatchObject({ runId: "run_7" });
  });

  // The row annotates a specific authorization row; without one there is
  // nothing to link it to, so it is skipped rather than written unlinked --
  // the same additive, never-gating contract recordReadFactIds() has.
  it("records nothing when the decision carries no auditLogId", async () => {
    await recordWriteEffect(ctx(), allowedUnlinked(), "memory.write", executed(`${ORG}.sales`), "fact:f1");

    expect(rowsWritten()).toEqual([]);
  });

  it("records nothing for a denied decision", async () => {
    await recordWriteEffect(
      ctx(),
      { allowed: false, reason: "no grant", auditLogId: "audit_1" },
      "memory.delete",
      executed(`${ORG}.sales`),
      "fact:f1",
    );

    expect(rowsWritten()).toEqual([]);
  });
});

// These are the first ALWAYS-VISIBLE audit rows any recorder writes, so unlike
// recordReadFactIds' invisible rows they reach components/audit/format.ts's
// parseTarget() -- which dereferences `target` without a null check, and
// resolves a partition label only when the string holds a "/". A null or
// partition-less target renders every audit row after it as "Org root", or
// throws inside the page's entries.map() and blanks the whole table.
describe("every row recordWriteEffect writes renders on the audit screens", () => {
  it("always writes a non-null target carrying a partition and a record tag", async () => {
    await recordWriteEffect(ctx(), allowed(), "memory.delete", executed(`${ROOT}.engineering`), "entity:e1");

    const row = rowsWritten()[0];
    expect(row.target).toBe(`${ROOT}.engineering/entity:e1`);
    expect(row.target).toContain("/");
    // The What column names the record type; the verb lives in the Action
    // column, so a delete-effect row can never read as a view here.
    expect(parseTarget(row.target as string)).toEqual({
      scope: "Engineering",
      what: "Entity",
      recordId: "e1",
    });
  });

  // The default route path. An unscoped delete executes against the untagged
  // partition, and its row has to read as that partition -- not as the org-root
  // scope check() authorized, and not as an unparsed blob.
  it("renders the untagged partition as itself, with its record id intact", async () => {
    await recordWriteEffect(ctx(), allowed(), "memory.delete", executed(BARE), "entity:e1");

    const row = rowsWritten()[0];
    expect(parseTarget(row.target as string)).toEqual({
      scope: "Untagged",
      what: "Entity",
      recordId: "e1",
    });
    // Distinguishable from the row that authorized it, which names the org root.
    expect(parseTarget(`${ROOT}/entity:e1`).scope).toBe("Org root");
    expect(parseTarget(row.target as string).scope).not.toBe(parseTarget(`${ROOT}/entity:e1`).scope);
  });

  it("renders an untagged sub-partition under its own namespace, not as a scope", async () => {
    await recordWriteEffect(ctx(), allowed(), "memory.delete", executed(`${ORG}.engineering`), "fact:f1");

    const row = rowsWritten()[0];
    expect(parseTarget(row.target as string)).toEqual({
      scope: "Untagged › Engineering",
      what: "Fact",
      recordId: "f1",
    });
  });
});
