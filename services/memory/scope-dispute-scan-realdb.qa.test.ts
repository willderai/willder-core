// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Real-Postgres proof of the same-tier dispute filer's de-dup guarantee
// (services/memory/scope-dispute-scan.ts).
//
// scope-dispute-scan.test.ts mocks BOTH resolveContradictions AND @/lib/db,
// so its de-dup case only proves the reuse BRANCH runs when
// db.factDispute.findFirst is made to return a row. It never exercises the de-dup
// KEY against a real table, which is where the documented guarantee lives:
//
//   "De-duplicates against any already-open dispute on the same edge (`status:
//    "disputed"`) so a still-stale brief re-viewed repeatedly does not spam
//    duplicate rows for the same underlying conflict"
//
// Here only resolveContradictions (the graph/LLM layer) is stubbed. Everything from
// fileSameTierScopeDisputes down through openFactDispute and Prisma to Postgres is
// real, so the row counts below are what the database actually holds.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL, which may point at a live database. Skips cleanly without it.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-qa-137";
const OTHER_ORG = "org-qa-137-other";
const SCOPE = "org_qa137.eng";

const qa = QA_URL
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) })
  : (null as unknown as PrismaClient);

// Real Prisma/Postgres, just pointed at the isolated QA database instead of
// whatever DATABASE_URL the environment inherited.
vi.mock("@/lib/db", () => ({
  get db() {
    return qa;
  },
}));
vi.mock("@/services/facts/conflicts", () => ({ resolveContradictions: vi.fn() }));

const { resolveContradictions } = await import("@/services/facts/conflicts");
const { fileSameTierScopeDisputes } = await import("./scope-dispute-scan");

const ctx = { orgId: ORG, actor: { type: "human", id: "u1" } } as AccessContext;

// One underlying conflict between two real edges in the same scope, same tier.
const EDGE_A = "edge-case137-aaa";
const EDGE_B = "edge-case137-bbb";
const INPUT = [{ factA: "ship date is March", factB: "ship date is June", note: "incompatible dates" }];

// The SAME conflict as the scan reports it when the two facts land in one order...
const ORIENTATION_1 = [
  {
    ...INPUT[0],
    existing: { uuid: EDGE_A, actorType: "human" as const, actorId: "u1" },
    proposer: { uuid: EDGE_B, actorType: "human" as const, actorId: "u2" },
  },
];
// ...and in the other. Nothing pins the orientation: findScopeContradictions numbers
// the facts by the order guardedMemory.graph returns edges in, and whichever index
// the model names first becomes factA -> `existing` -> the de-dup key. The
// memory-service Cypher behind that read (graphiti_client.py graph_for_group)
// orders that read by uuid before capping it,
// but the orientation itself is still whichever fact the LLM names first in a given
// scan, so this pair can still report either edge as `existing`.
const ORIENTATION_2 = [
  {
    factA: INPUT[0].factB,
    factB: INPUT[0].factA,
    note: INPUT[0].note,
    existing: { uuid: EDGE_B, actorType: "human" as const, actorId: "u2" },
    proposer: { uuid: EDGE_A, actorType: "human" as const, actorId: "u1" },
  },
];

describe.skipIf(!QA_URL)("same-tier dispute de-dup, real Postgres", () => {
  async function ensureOrg(id: string) {
    // fact_disputes.orgId is a real FK to orgs.id, so the tenant must genuinely exist.
    await qa.org.upsert({ where: { id }, update: {}, create: { id, name: id } });
  }
  async function disputeRows(orgId = ORG) {
    return qa.factDispute.findMany({
      where: { orgId, scopePath: orgId === ORG ? SCOPE : `${OTHER_ORG}.eng` },
      select: { graphitiFactUuid: true, status: true },
      orderBy: { createdAt: "asc" },
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await ensureOrg(ORG);
    await ensureOrg(OTHER_ORG);
    await qa.factDispute.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  });

  afterAll(async () => {
    if (!QA_URL) return;
    await qa.factDispute.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await qa.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await qa.$disconnect();
  });

  it("files exactly one real row for a same-tier pair, and the row is really in the table", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue(ORIENTATION_1);
    const ids = await fileSameTierScopeDisputes(ctx, ORG, SCOPE, INPUT);
    expect(ids).toHaveLength(1);
    const rows = await disputeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].graphitiFactUuid).toBe(EDGE_A);
    expect(rows[0].status).toBe("disputed");
  });

  it("de-dups repeat views that report the pair in the SAME orientation", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue(ORIENTATION_1);
    await fileSameTierScopeDisputes(ctx, ORG, SCOPE, INPUT);
    await fileSameTierScopeDisputes(ctx, ORG, SCOPE, INPUT);
    await fileSameTierScopeDisputes(ctx, ORG, SCOPE, INPUT);
    // Documented behavior holds on this path: three views, still one row.
    expect(await disputeRows()).toHaveLength(1);
  });

  it("FIXED: the same conflict in the swapped orientation reuses the existing row, not a second one", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue(ORIENTATION_1);
    const firstIds = await fileSameTierScopeDisputes(ctx, ORG, SCOPE, INPUT);
    expect(await disputeRows()).toHaveLength(1);

    // Second view of the SAME still-stale brief, same two edges, one real-world
    // disagreement -- only the reported orientation differs.
    vi.mocked(resolveContradictions).mockResolvedValue(ORIENTATION_2);
    const secondIds = await fileSameTierScopeDisputes(ctx, ORG, SCOPE, [
      { factA: INPUT[0].factB, factB: INPUT[0].factA, note: INPUT[0].note },
    ]);

    // The de-dup lookup now matches on EITHER side's uuid, so the swapped
    // orientation's `existing` (EDGE_B) still finds the row filed under EDGE_A --
    // same id returned, no second row opened for one real conflict.
    expect(secondIds).toEqual(firstIds);
    const rows = await disputeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].graphitiFactUuid).toBe(EDGE_A);
  });

  it("de-dup is correctly tenant-scoped: another org's identical edge gets its own row", async () => {
    vi.mocked(resolveContradictions).mockResolvedValue(ORIENTATION_1);
    await fileSameTierScopeDisputes(ctx, ORG, SCOPE, INPUT);
    await fileSameTierScopeDisputes(
      { orgId: OTHER_ORG, actor: { type: "human", id: "u9" } } as AccessContext,
      OTHER_ORG,
      `${OTHER_ORG}.eng`,
      INPUT,
    );
    // This one is correct and must stay: orgs must never share dispute state.
    expect(await disputeRows(ORG)).toHaveLength(1);
    expect(await disputeRows(OTHER_ORG)).toHaveLength(1);
  });
});
