// The dependency graph's pure parts: the walk's order and bounds, the choice of a stale
// reason, and the ranking. The queries and the access rule are proven against a real
// database in dependencies.realdb.test.ts.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  MAX_RECOMMENDATIONS,
  rankStale,
  staleDependencies,
  walkDependents,
  type DependencyEdge,
  type StaleDependency,
} from "./dependencies";

const at = (s: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, s));
const rel = (fromId: string, toId: string, s: number, kind: DependencyEdge["kind"] = "dependsOn"): DependencyEdge => ({
  fromId,
  toId,
  kind,
  scopePath: "org_x.eng",
  createdAt: at(s),
});

/** A fetch over a fixed set of relations, as the database would answer it. */
const graph = (edges: DependencyEdge[], truncatedFor: string[] = []) =>
  vi.fn(async (ids: string[]) => ({
    rows: edges.filter((e) => ids.includes(e.toId)),
    truncated: ids.some((id) => truncatedFor.includes(id)),
  }));

describe("walkDependents", () => {
  it("lists dependents nearest first, newest relation first within a distance, ties by id", async () => {
    const fetch = graph([rel("b", "root", 1), rel("a", "root", 5), rel("c", "root", 5), rel("d", "a", 9)]);
    const { items, truncated } = await walkDependents("root", fetch);
    expect(items.map((i) => [i.recordId, i.distance])).toEqual([
      ["a", 1],
      ["c", 1],
      ["b", 1],
      ["d", 2],
    ]);
    expect(items[3]!.path.map((e) => `${e.fromId}>${e.toId}`)).toEqual(["a>root", "d>a"]);
    expect(truncated).toBe(false);
  });

  it("lists a record reachable two ways once, by its shortest path", async () => {
    const fetch = graph([rel("a", "root", 1), rel("b", "a", 2), rel("b", "root", 0)]);
    const { items } = await walkDependents("root", fetch);
    expect(items.filter((i) => i.recordId === "b")).toEqual([expect.objectContaining({ distance: 1 })]);
  });

  it("does not loop on a cycle and never lists the root", async () => {
    const fetch = graph([rel("a", "root", 1), rel("root", "a", 2)]);
    const { items } = await walkDependents("root", fetch);
    expect(items.map((i) => i.recordId)).toEqual(["a"]);
  });

  it("stops at the depth bound, truncated only when a dependent was left unvisited", async () => {
    const chain = [rel("a", "root", 1), rel("b", "a", 1), rel("c", "b", 1)];
    const cut = await walkDependents("root", graph(chain), { depth: 2, items: 10 });
    expect(cut.items.map((i) => i.recordId)).toEqual(["a", "b"]);
    expect(cut.truncated).toBe(true);
    expect((await walkDependents("root", graph(chain), { depth: 3, items: 10 })).truncated).toBe(false);
    // A dependent beyond the bound that the walk already listed is not left unvisited.
    const loop = [rel("a", "root", 1), rel("b", "a", 1), rel("a", "b", 2)];
    expect((await walkDependents("root", graph(loop), { depth: 2, items: 10 })).truncated).toBe(false);
  });

  it("says truncated when the item bound leaves a record unvisited, and not when it is exactly met", async () => {
    const edges = [rel("a", "root", 1), rel("b", "root", 2)];
    expect((await walkDependents("root", graph(edges), { depth: 8, items: 1 })).truncated).toBe(true);
    expect((await walkDependents("root", graph(edges), { depth: 8, items: 2 })).truncated).toBe(false);
  });

  it("says truncated when any fetch was cut off", async () => {
    const { truncated } = await walkDependents("root", graph([rel("a", "root", 1)], ["a"]));
    expect(truncated).toBe(true);
  });
});

describe("staleDependencies", () => {
  const brief = rel("brief", "fact", 10, "cites");

  it("names the replacement when a supersedes edge points at the source, whenever it was recorded", () => {
    const stale = staleDependencies([brief], [{ id: "e1", fromId: "fact2", toId: "fact", createdAt: at(1) }], []);
    expect(stale).toEqual([
      { recordId: "brief", sourceId: "fact", kind: "cites", reason: { kind: "superseded", at: at(1), byId: "fact2" } },
    ]);
  });

  it("prefers a replacement over a change event, and the latest replacement, ties by id", () => {
    const stale = staleDependencies(
      [brief],
      [
        { id: "e2", fromId: "v-b", toId: "fact", createdAt: at(20) },
        { id: "e1", fromId: "v-a", toId: "fact", createdAt: at(20) },
        { id: "e0", fromId: "v-old", toId: "fact", createdAt: at(15) },
      ],
      [{ id: "c1", recordId: "fact", op: "delete", createdAt: at(30) }],
    );
    expect(stale[0]!.reason).toEqual({ kind: "superseded", at: at(20), byId: "v-a" });
  });

  it("counts a change only after the dependent was built, and only a staling op", () => {
    const changes = [
      { id: "c0", recordId: "fact", op: "delete" as const, createdAt: at(10) },
      { id: "c1", recordId: "fact", op: "create" as const, createdAt: at(11) },
      { id: "c2", recordId: "other", op: "delete" as const, createdAt: at(12) },
    ];
    expect(staleDependencies([brief], [], changes)).toEqual([]);
    const later = staleDependencies(
      [brief],
      [],
      [...changes, { id: "c3", recordId: "fact", op: "revoke", createdAt: at(13) }],
    );
    expect(later.map((s) => s.reason)).toEqual([{ kind: "changed", at: at(13), op: "revoke" }]);
  });

  it.each(["update", "supersede", "delete", "revoke"] as const)("treats %s as a change", (op) => {
    expect(staleDependencies([brief], [], [{ id: "c", recordId: "fact", op, createdAt: at(11) }])).toHaveLength(1);
  });

  it("never reads a supersedes relation as a dependency", () => {
    const stale = staleDependencies(
      [rel("v2", "fact", 1, "supersedes")],
      [{ id: "e", fromId: "v3", toId: "fact", createdAt: at(2) }],
      [],
    );
    expect(stale).toEqual([]);
  });
});

describe("rankStale", () => {
  const stale = (recordId: string, sourceId: string, s: number): StaleDependency => ({
    recordId,
    sourceId,
    kind: "cites",
    reason: { kind: "changed", at: at(s), op: "delete" },
  });

  it("ranks by dependents, then by the latest reason, then by id", () => {
    const ranked = rankStale(
      [stale("old-but-depended", "f1", 1), stale("new", "f2", 9), stale("b-tie", "f3", 5), stale("a-tie", "f4", 5)],
      new Map([["old-but-depended", 2]]),
      10,
    );
    expect(ranked.map((r) => r.recordId)).toEqual(["old-but-depended", "new", "a-tie", "b-tie"]);
  });

  it("lists a record once, with its newest reason and how many sources moved", () => {
    const [only] = rankStale([stale("brief", "f1", 1), stale("brief", "f2", 7), stale("brief", "f2", 3)], new Map(), 3);
    expect(only).toEqual({
      recordId: "brief",
      dependents: 0,
      staleSources: 2,
      latest: { sourceId: "f2", kind: "cites", reason: { kind: "changed", at: at(7), op: "delete" } },
    });
  });

  it("clamps the limit to 1..MAX_RECOMMENDATIONS and reads a non-number as the default", () => {
    const many = Array.from({ length: 30 }, (_, i) => stale(`r${String(i).padStart(2, "0")}`, "f", i));
    expect(rankStale(many, new Map(), 0)).toHaveLength(1);
    expect(rankStale(many, new Map(), 99)).toHaveLength(MAX_RECOMMENDATIONS);
    expect(rankStale(many, new Map(), Number.NaN)).toHaveLength(3);
    expect(rankStale(many, new Map(), 2.7)).toHaveLength(2);
  });
});
