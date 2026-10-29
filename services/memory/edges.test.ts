// recordReplacements is the one place lineage between two versions of an item is written
// outside the conflict rule. It must keep both ends of every edge in one scope, never record
// a version as replacing itself, never record a replacement from or into a version another
// has already replaced, and write what it keeps in one statement.
import { describe, expect, it, vi } from "vitest";
import { recordReplacements, type FactEdgeWriter, type Replacement } from "./edges";

/** A writer over `existing` edges, as `orgId/fromId>toId`, recording what it is asked to write. */
function writer(existing: string[] = []): FactEdgeWriter & { rows: () => unknown[] } {
  const edges = existing.map((e) => {
    const [orgId, rest] = e.split("/") as [string, string];
    const [fromId, toId] = rest.split(">") as [string, string];
    return { orgId, fromId, toId };
  });
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
  const findMany = vi.fn(async ({ where }: { where: { kind: string; OR: { orgId: string; toId: string }[] } }) =>
    edges.filter((e) => where.kind === "supersedes" && where.OR.some((w) => w.orgId === e.orgId && w.toId === e.toId)),
  );
  return {
    factEdge: { createMany, findMany } as never,
    rows: () => createMany.mock.calls.flatMap(([arg]) => arg.data),
  };
}

const replacement = (over: Partial<Replacement>): Replacement => ({
  orgId: "org1",
  replacementId: "v2",
  replacementScopePath: "org_org1.hb",
  replacedId: "v1",
  replacedScopePath: "org_org1.hb",
  actor: { type: "extraction", id: "slack-sync:src1" },
  ...over,
});

describe("recordReplacements", () => {
  it("records a replacement in the scope both versions share, from the new version to the old", async () => {
    const w = writer();
    expect(await recordReplacements(w, [replacement({})])).toBe(1);
    expect(w.rows()).toEqual([
      {
        orgId: "org1",
        fromId: "v2",
        toId: "v1",
        kind: "supersedes",
        scopePath: "org_org1.hb",
        actorType: "extraction",
        actorId: "slack-sync:src1",
      },
    ]);
  });

  it("records nothing between versions in two scopes, a sibling whose path starts the same included", async () => {
    const w = writer();
    const count = await recordReplacements(w, [
      replacement({ replacementScopePath: "org_org1.hbx" }),
      replacement({ replacedScopePath: "org_org1" }),
    ]);
    expect(count).toBe(0);
    expect(w.rows()).toEqual([]);
  });

  it("never records a version as replacing itself", async () => {
    const w = writer();
    expect(await recordReplacements(w, [replacement({ replacementId: "v1" })])).toBe(0);
    expect(w.rows()).toEqual([]);
  });

  it("records nothing from a version another version has already replaced, in this org only", async () => {
    const w = writer(["org1/v3>v2", "org2/v9>v4"]);
    const count = await recordReplacements(w, [
      replacement({}),
      replacement({ replacementId: "v4", replacedId: "v0" }),
    ]);
    expect(count).toBe(1);
    expect(w.rows().map((row) => (row as { fromId: string }).fromId)).toEqual(["v4"]);
  });

  it("records nothing into a version another version already replaced: a version is replaced once", async () => {
    const w = writer(["org1/v9>v1", "org2/v8>v0"]);
    const count = await recordReplacements(w, [replacement({}), replacement({ replacedId: "v0" })]);
    expect(count).toBe(1);
    expect(w.rows().map((row) => (row as { toId: string }).toId)).toEqual(["v0"]);
  });

  it("keeps the recordable replacements of a batch and drops the rest", async () => {
    const w = writer();
    const count = await recordReplacements(w, [
      replacement({ replacedId: "v0" }),
      replacement({ replacedId: "v1", replacedScopePath: "org_org1.hbx" }),
      replacement({ replacedId: "v-1" }),
    ]);
    expect(count).toBe(2);
    expect(w.rows().map((row) => (row as { toId: string }).toId)).toEqual(["v0", "v-1"]);
  });
});
