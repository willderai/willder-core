// readVersionLineage is the audit Timeline's "Replaced" answer. It must say what
// readMemoryVersion says for the same id, without making an access decision of its own.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    // findMany: what the erased-version check reads about the rules a lineage names.
    convention: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    factEdge: { findMany: vi.fn() },
    // No one erased: the erased-content filter memory_version applies finds nothing.
    erasureSuppression: { findMany: vi.fn().mockResolvedValue([]) },
    // What the erased-version check reads about the versions a lineage names.
    memoryChunk: { findMany: vi.fn().mockResolvedValue([]) },
    changeEvent: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(async () => ({ allowed: true })),
}));

import { db } from "@/lib/db";
import { check } from "@/services/access";
import { readVersionLineage } from "./versions";

const ORG = "org1";

function rule(over: Record<string, unknown>) {
  return {
    id: "c1",
    scopePath: "org_org1.crew",
    kind: "decision",
    subject: "cadence",
    text: "weekly",
    actorId: "agent_1",
    createdAt: new Date("2026-10-02T07:00:00Z"),
    supersedesId: null,
    supersededById: null,
    retiredAt: null,
    replacedBy: null,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(db.$queryRaw)
    .mockReset()
    .mockResolvedValue([] as never);
  vi.mocked(db.convention.findFirst).mockReset().mockResolvedValue(null);
  vi.mocked(db.factEdge.findMany).mockReset().mockResolvedValue([]);
  vi.mocked(check).mockClear();
});

describe("readVersionLineage", () => {
  it("names the winner of a race a convention lost, from the rule's own row", async () => {
    vi.mocked(db.convention.findFirst).mockResolvedValueOnce(rule({ id: "loser", supersededById: "winner" }) as never);
    expect(await readVersionLineage(ORG, "loser")).toEqual({ supersededById: "winner", supersedesIds: [] });
    expect(vi.mocked(db.convention.findFirst).mock.calls[0]![0]).toMatchObject({ where: { id: "loser", orgId: ORG } });
  });

  it("names both sides of a replacement a convention took part in", async () => {
    vi.mocked(db.convention.findFirst).mockResolvedValueOnce(
      rule({ id: "c1", supersedesId: "c0", replacedBy: { id: "c2" } }) as never,
    );
    expect(await readVersionLineage(ORG, "c1")).toEqual({ supersededById: "c2", supersedesIds: ["c0"] });
  });

  it("lets the row win over the graph on the replacement, and joins both on what it replaced", async () => {
    vi.mocked(db.convention.findFirst).mockResolvedValueOnce(
      rule({ id: "c1", supersedesId: "c0", supersededById: "row-winner" }) as never,
    );
    vi.mocked(db.factEdge.findMany).mockResolvedValueOnce([
      { fromId: "edge-winner", toId: "c1" },
      { fromId: "c1", toId: "c0" },
      { fromId: "c1", toId: "c-1" },
    ] as never);
    expect(await readVersionLineage(ORG, "c1")).toEqual({ supersededById: "row-winner", supersedesIds: ["c0", "c-1"] });
  });

  it("answers from the dependency graph when the version's row is gone, such as a corrected fact", async () => {
    vi.mocked(db.factEdge.findMany).mockResolvedValueOnce([{ fromId: "f2", toId: "f1" }] as never);
    expect(await readVersionLineage(ORG, "f1")).toEqual({ supersededById: "f2", supersedesIds: [] });
    expect(vi.mocked(db.factEdge.findMany).mock.calls[0]![0]).toMatchObject({
      where: { orgId: ORG, kind: "supersedes" },
    });
  });

  it("orders edges recorded in the same millisecond by id, as supersedingVersions does", async () => {
    await readVersionLineage(ORG, "f1");
    expect(vi.mocked(db.factEdge.findMany).mock.calls[0]![0]).toMatchObject({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it("is nothing for a version nobody replaced, and makes no access decision of its own", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([
      { id: "f1", content: "x", entityName: null, scopePath: "org_org1", actorId: "agent_1", createdAt: new Date() },
    ] as never);
    expect(await readVersionLineage(ORG, "f1")).toEqual({ supersededById: null, supersedesIds: [] });
    expect(db.convention.findFirst).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });
});
