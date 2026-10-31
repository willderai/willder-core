// readMemoryVersion dates the lineage it names: when the version was superseded, and the date
// each version it names is served with (its occurredAt, else when it was written), so
// memory_version can answer "when did this change" without a call per version. It dates only
// ids the lineage already names after its erasure filter: a replacement that reads as erased is
// neither named nor dated.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    convention: { findFirst: vi.fn(), findMany: vi.fn() },
    factEdge: { findMany: vi.fn() },
    memoryChunk: { findMany: vi.fn() },
    changeEvent: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(async () => ({ allowed: true })),
}));
// Erased: exactly the ids in `erasedIds`.
const erasedIds = new Set<string>();
vi.mock("./erasure-suppression", () => ({
  loadErasedContentFilter: vi.fn(async () =>
    Object.assign(
      (_content: string, _at: Date | null, _entity: string | null, id?: string) => (id ? erasedIds.has(id) : false),
      {
        byRuleId: (id: string) => erasedIds.has(id),
      },
    ),
  ),
}));

import { db } from "@/lib/db";
import { readMemoryVersion } from "./versions";

const ctx = { orgId: "org1", actor: { type: "agent", id: "reader" }, origin: "mcp" } as never;
const day = (iso: string) => new Date(iso);

function factRow(id: string, createdAt: string, occurredAt: string | null = null) {
  return {
    id,
    content: `${id} text`,
    entityName: "Database",
    scopePath: "org_org1.eng",
    actorId: "agent_1",
    createdAt: day(createdAt),
    occurredAt: occurredAt ? day(occurredAt) : null,
  };
}

beforeEach(() => {
  erasedIds.clear();
  vi.mocked(db.$queryRaw)
    .mockReset()
    .mockResolvedValue([] as never);
  vi.mocked(db.convention.findFirst).mockReset().mockResolvedValue(null);
  vi.mocked(db.convention.findMany).mockReset().mockResolvedValue([]);
  vi.mocked(db.factEdge.findMany).mockReset().mockResolvedValue([]);
  vi.mocked(db.memoryChunk.findMany).mockReset().mockResolvedValue([]);
});

describe("readMemoryVersion — lineage dates", () => {
  it("dates a superseded fact by its edge, and its replacement and predecessor by their served dates", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([
      factRow("v2", "2026-03-01T09:00:00Z", "2026-02-20T00:00:00Z"),
    ] as never);
    vi.mocked(db.factEdge.findMany).mockResolvedValueOnce([
      { fromId: "v3", toId: "v2", createdAt: day("2026-06-01T10:00:00Z") },
      { fromId: "v2", toId: "v1", createdAt: day("2026-03-01T09:00:00Z") },
    ] as never);
    vi.mocked(db.memoryChunk.findMany).mockImplementation((async (args: { select: Record<string, boolean> }) =>
      // The erased-version check reads content; the lineage dates read occurredAt.
      args.select.occurredAt
        ? [
            { id: "v3", createdAt: day("2026-06-01T10:00:00Z"), occurredAt: day("2026-05-15T00:00:00Z") },
            { id: "v1", createdAt: day("2026-01-05T08:00:00Z"), occurredAt: null },
          ]
        : []) as never);

    const version = await readMemoryVersion(ctx, "v2");
    expect(version).toMatchObject({
      status: "superseded",
      supersededById: "v3",
      supersedesIds: ["v1"],
      supersededAt: day("2026-06-01T10:00:00Z"),
      occurredAt: day("2026-02-20T00:00:00Z"),
      lineageDatedAt: { v3: day("2026-05-15T00:00:00Z"), v1: day("2026-01-05T08:00:00Z") },
    });
  });

  it("dates a rule replaced through its own row by when the replacement was written", async () => {
    vi.mocked(db.convention.findFirst).mockResolvedValueOnce({
      id: "c1",
      scopePath: "org_org1.crew",
      kind: "decision",
      subject: "cadence",
      text: "weekly",
      actorId: "agent_1",
      createdAt: day("2026-01-02T07:00:00Z"),
      supersedesId: null,
      supersededById: null,
      retiredAt: null,
      replacedBy: { id: "c2" },
    } as never);
    // An edge dated otherwise is not what the row's own replacement is dated by.
    vi.mocked(db.factEdge.findMany).mockResolvedValueOnce([
      { fromId: "c9", toId: "c1", createdAt: day("2026-09-09T00:00:00Z") },
    ] as never);
    vi.mocked(db.convention.findMany).mockImplementation((async (args: { select: Record<string, boolean> }) =>
      args.select.text ? [] : [{ id: "c2", createdAt: day("2026-04-04T12:00:00Z") }]) as never);
    const version = await readMemoryVersion(ctx, "c1");
    expect(version).toMatchObject({
      supersededById: "c2",
      supersededAt: day("2026-04-04T12:00:00Z"),
      lineageDatedAt: { c2: day("2026-04-04T12:00:00Z") },
    });
  });

  it("neither names nor dates a replacement that reads as erased", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([factRow("v2", "2026-03-01T09:00:00Z")] as never);
    vi.mocked(db.factEdge.findMany).mockResolvedValueOnce([
      { fromId: "v-erased", toId: "v2", createdAt: day("2026-06-01T10:00:00Z") },
    ] as never);
    erasedIds.add("v-erased");
    const version = await readMemoryVersion(ctx, "v2");
    expect(version).toMatchObject({
      status: "superseded",
      supersededById: null,
      supersededAt: null,
      lineageDatedAt: {},
    });
    // Nothing is looked up for a lineage that names nothing once erased versions are left out.
    expect(
      vi
        .mocked(db.memoryChunk.findMany)
        .mock.calls.some(([args]) => (args as { select: Record<string, boolean> }).select.occurredAt),
    ).toBe(false);
  });

  it("is undated for a current version that replaced nothing", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([factRow("v1", "2026-01-05T08:00:00Z")] as never);
    expect(await readMemoryVersion(ctx, "v1")).toMatchObject({
      status: "current",
      supersededAt: null,
      occurredAt: null,
      lineageDatedAt: {},
    });
  });
});
