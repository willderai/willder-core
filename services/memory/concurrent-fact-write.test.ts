// Two agents writing the same fact at once, end to end over one store.
//
// Two agents write the same fact — the same entity name in the same scope — one
// millisecond apart. This file asserts three things:
// a winner is recorded, the loser receives a change notice, and both versions remain
// readable by id afterwards.
//
// The store here is an in-memory fake for the three tables involved —
// `memory_chunks`, `fact_edges`, `change_events` — so the whole write and read path
// runs for real over it. What it cannot show is Postgres serializing two real
// transactions behind the per-org advisory lock, which is what makes the second writer
// see the first's committed row; `change-events.realdb.test.ts` makes that claim for
// the lock this path takes by calling `recordChangeEvent`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";

interface ChunkRow {
  id: string;
  orgId: string;
  content: string;
  entityName: string | null;
  scopePath: string | null;
  actorId: string | null;
  createdAt: Date;
}
interface EdgeRow {
  orgId: string;
  fromId: string;
  toId: string;
  kind: string;
  scopePath: string;
  actorType: string;
  actorId: string;
  createdAt: Date;
}
interface EventRow {
  orgId: string;
  recordType: string;
  recordId: string;
  op: string;
  actorId: string;
  summary: string;
}

const store = { chunks: [] as ChunkRow[], edges: [] as EdgeRow[], events: [] as EventRow[] };

vi.mock("@/lib/db", () => {
  const matchesEdge = (row: EdgeRow, candidate: Omit<EdgeRow, "createdAt">) =>
    row.orgId === candidate.orgId &&
    row.fromId === candidate.fromId &&
    row.toId === candidate.toId &&
    row.kind === candidate.kind;

  const db = {
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    convention: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    // No one erased: the erased-content filter memory_version applies finds nothing, so
    // the rows and announcements it reads for a version's lineage can be empty too.
    erasureSuppression: { findMany: vi.fn().mockResolvedValue([]) },
    memoryChunk: { findMany: vi.fn().mockResolvedValue([]) },
    changeEvent: {
      create: vi.fn(async ({ data }: { data: EventRow }) => {
        store.events.push(data);
        return { id: `event-${store.events.length}` };
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    factEdge: {
      createMany: vi.fn(async ({ data }: { data: Omit<EdgeRow, "createdAt">[] }) => {
        let count = 0;
        for (const candidate of data) {
          if (store.edges.some((row) => matchesEdge(row, candidate))) continue;
          store.edges.push({ ...candidate, createdAt: new Date() });
          count += 1;
        }
        return { count };
      }),
      findMany: vi.fn(
        async ({ where }: { where: { orgId: string; kind: string; OR: { fromId?: string; toId?: string }[] } }) => {
          const id = where.OR[0].fromId ?? where.OR[1].toId!;
          return store.edges.filter(
            (row) => row.orgId === where.orgId && row.kind === where.kind && (row.fromId === id || row.toId === id),
          );
        },
      ),
    },
    $queryRaw: vi.fn(async (query: Prisma.Sql | TemplateStringsArray) => {
      // recordChangeEvent's advisory lock and next-seq statements arrive as tagged
      // templates; the two queries this feature adds arrive as Prisma.Sql values.
      if (Array.isArray(query)) return [{ next: BigInt(store.events.length + 1) }];
      const sql = query as Prisma.Sql;
      const values = sql.values as (string | number | null)[];
      if (sql.sql.includes('FROM "memory_chunks" c, stored s')) {
        const [versionId, orgId, , entityName, scopePath, windowSeconds] = values;
        const target = store.chunks.find((row) => row.id === versionId && row.orgId === orgId);
        if (!target) return [];
        const windowMs = Number(windowSeconds) * 1000;
        return (
          store.chunks
            .filter(
              (row) =>
                row.orgId === orgId &&
                row.entityName === entityName &&
                row.scopePath === scopePath &&
                Math.abs(row.createdAt.getTime() - target.createdAt.getTime()) <= windowMs,
            )
            // Creation time, then the row's place in the store, the order it was inserted in,
            // as `storedSeq` is.
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() || store.chunks.indexOf(a) - store.chunks.indexOf(b),
            )
            .map((row, index) => ({ ...row, storedOrder: index + 1 }))
        );
      }
      const [id, orgId] = values;
      return store.chunks.filter((row) => row.id === id && row.orgId === orgId);
    }),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: typeof db) => unknown) => fn(db));
  return { db };
});

// The real orgRootPath, isValidLtreePath and scope helpers run; only the decision and
// the applied-audit row are stubbed out, neither of which this file is about.
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return {
    ...actual,
    check: vi.fn().mockResolvedValue({ allowed: true }),
    recordAppliedChange: vi.fn().mockResolvedValue(undefined),
  };
});

import { recordIngestApplied } from "./fact-change-event";
import { readMemoryVersion } from "./versions";
import type { AccessContext } from "@/services/access";
import type { IngestInput } from "@/types/memory";

const ORG = "org-cuid-cfw";
const SCOPE = "org_org-cuid-cfw.cfw";
const ENTITY = "Launch date";
const ctx = { orgId: ORG, actor: { type: "agent", id: "agent-reader" } } as AccessContext;

/** Store one writer's version the way the request path does, then announce it. */
async function write(versionId: string, actorId: string, content: string, atMs: number): Promise<void> {
  store.chunks.push({
    id: versionId,
    orgId: ORG,
    content,
    entityName: ENTITY,
    scopePath: SCOPE,
    actorId,
    createdAt: new Date(atMs),
  });
  const input: IngestInput = {
    groupId: ORG,
    content,
    name: ENTITY,
    actorType: "agent",
    origin: "mcp",
    actorId,
    scopePath: SCOPE,
  };
  await recordIngestApplied(input, versionId);
}

/** The two writers of the production trial: FRIDAY first, MONDAY one millisecond later. */
async function twoConcurrentWrites(): Promise<void> {
  await write("version-friday", "agent-one", "The launch date is FRIDAY.", 1_700_000_000_000);
  await write("version-monday", "agent-two", "The launch date is MONDAY.", 1_700_000_000_001);
}

const supersedesEdges = () => store.edges.filter((edge) => edge.kind === "supersedes");

beforeEach(() => {
  store.chunks = [];
  store.edges = [];
  store.events = [];
});

describe("two agents write the same fact one millisecond apart", () => {
  it("records a winner: one supersedes edge, from the version stored first", async () => {
    await twoConcurrentWrites();

    expect(supersedesEdges()).toEqual([
      expect.objectContaining({ fromId: "version-friday", toId: "version-monday", scopePath: SCOPE }),
    ]);
  });

  it("tells the losing writer, on the feed, attributed to the winner's writer", async () => {
    await twoConcurrentWrites();

    const notice = store.events.filter((event) => event.op === "supersede");
    expect(notice).toHaveLength(1);
    // Attribution decides whether the loser ever sees this line: an agent's own
    // writes are filtered out of its change notices.
    expect(notice[0]).toMatchObject({ recordId: "version-monday", actorId: "agent-one" });
    expect(notice[0].summary).toContain("superseded by version-friday");
  });

  it("keeps both versions readable by id, one current and one superseded", async () => {
    await twoConcurrentWrites();

    const winner = await readMemoryVersion(ctx, "version-friday");
    const loser = await readMemoryVersion(ctx, "version-monday");

    expect(winner).toMatchObject({
      id: "version-friday",
      kind: "fact",
      status: "current",
      content: "The launch date is FRIDAY.",
      supersededById: null,
      supersedesIds: ["version-monday"],
    });
    expect(loser).toMatchObject({
      id: "version-monday",
      kind: "fact",
      status: "superseded",
      content: "The launch date is MONDAY.",
      supersededById: "version-friday",
    });
  });

  it("records one winner however many times the announcement is replayed", async () => {
    await twoConcurrentWrites();
    await recordIngestApplied(
      {
        groupId: ORG,
        content: "The launch date is MONDAY.",
        name: ENTITY,
        actorType: "agent",
        origin: "mcp",
        actorId: "agent-two",
        scopePath: SCOPE,
      },
      "version-monday",
    );

    expect(supersedesEdges()).toHaveLength(1);
    expect(store.events.filter((event) => event.op === "supersede")).toHaveLength(1);
  });

  it("leaves two writes about different entities alone", async () => {
    await write("version-friday", "agent-one", "The launch date is FRIDAY.", 1_700_000_000_000);
    store.chunks.push({
      id: "version-other",
      orgId: ORG,
      content: "The office is in Austin.",
      entityName: "Office",
      scopePath: SCOPE,
      actorId: "agent-two",
      createdAt: new Date(1_700_000_000_001),
    });
    await recordIngestApplied(
      {
        groupId: ORG,
        content: "The office is in Austin.",
        name: "Office",
        actorType: "agent",
        origin: "mcp",
        actorId: "agent-two",
        scopePath: SCOPE,
      },
      "version-other",
    );

    expect(supersedesEdges()).toEqual([]);
  });

  it("leaves a later write outside the window alone: that is an update, not a conflict", async () => {
    await write("version-friday", "agent-one", "The launch date is FRIDAY.", 1_700_000_000_000);
    await write("version-monday", "agent-two", "The launch date is MONDAY.", 1_700_000_002_000);

    expect(supersedesEdges()).toEqual([]);
  });
});

describe("reading a version by id", () => {
  it("reports a version this org does not have as missing", async () => {
    expect(await readMemoryVersion(ctx, "version-nowhere")).toBeNull();
  });
});
