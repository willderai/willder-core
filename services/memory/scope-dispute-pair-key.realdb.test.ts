// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The scope scan's dispute de-dup key, against a real database.
//
// `fileSameTierScopeDisputes` must file one row per conflicting edge PAIR: a
// repeat view of the same conflict reuses its row, but a second conflict that
// shares one fact (A-vs-B open, then A-vs-C) is a different disagreement and
// needs its own. Whether that holds depends on the `where` clause Postgres
// actually evaluates, including how it treats NULL `proposerFactUuid` on rows
// filed before that column existed, so a mocked `db` cannot show it. Only the
// graph/LLM layer (`resolveContradictions`) is stubbed here.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL, which may point at a live database. Skips cleanly without it.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import type { ResolvedContradiction } from "@/services/facts/conflicts";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "org-qa-dispute-pair";
const OTHER_ORG = "org-qa-dispute-pair-other";
const SCOPE = "org_qa_dispute_pair.eng";

const qa = QA_URL
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) })
  : (null as unknown as PrismaClient);

vi.mock("@/lib/db", () => ({
  get db() {
    return qa;
  },
}));
vi.mock("@/services/facts/conflicts", () => ({ resolveContradictions: vi.fn() }));

const { resolveContradictions } = await import("@/services/facts/conflicts");
const { fileSameTierScopeDisputes } = await import("./scope-dispute-scan");

const EDGE_A = "edge-pair-aaa";
const EDGE_B = "edge-pair-bbb";
const EDGE_C = "edge-pair-ccc";

/** One same-tier contradiction, reported with `existing` = first edge. */
function conflict(existing: string, proposer: string): ResolvedContradiction {
  return {
    factA: existing,
    factB: proposer,
    note: "incompatible",
    existing: { uuid: existing, actorType: "human", actorId: `author-${existing}` },
    proposer: { uuid: proposer, actorType: "human", actorId: `author-${proposer}` },
  };
}

/** Run one scan whose resolved contradictions are exactly `found`. */
async function scan(...found: ResolvedContradiction[]) {
  return scanIn(ORG, ...found);
}

/** Run one scan as a member of `orgId`, over the shared SCOPE path. */
async function scanIn(orgId: string, ...found: ResolvedContradiction[]) {
  vi.mocked(resolveContradictions).mockResolvedValue(found);
  return fileSameTierScopeDisputes(
    { orgId, actor: { type: "human", id: "u1" } } as AccessContext,
    orgId,
    SCOPE,
    found.map(({ factA, factB, note }) => ({ factA, factB, note })),
  );
}

async function openRows(orgId = ORG) {
  return qa.factDispute.findMany({
    where: { orgId, scopePath: SCOPE, status: "disputed" },
    select: { id: true, graphitiFactUuid: true, proposerFactUuid: true },
    orderBy: { createdAt: "asc" },
  });
}

describe.skipIf(!QA_URL)("scope dispute de-dup on the edge pair, real Postgres", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    for (const id of [ORG, OTHER_ORG]) {
      await qa.org.upsert({ where: { id }, update: {}, create: { id, name: id } });
    }
    await qa.factDispute.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  });

  afterAll(async () => {
    if (!QA_URL) return;
    await qa.factDispute.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
    await qa.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await qa.$disconnect();
  });

  it("records both edges of the pair on the filed row", async () => {
    await scan(conflict(EDGE_A, EDGE_B));
    const rows = await openRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ graphitiFactUuid: EDGE_A, proposerFactUuid: EDGE_B });
  });

  it("files a second row for A-vs-C when A-vs-B is already open", async () => {
    const [abId] = await scan(conflict(EDGE_A, EDGE_B));
    const [acId] = await scan(conflict(EDGE_A, EDGE_C));

    expect(acId).not.toBe(abId);
    const rows = await openRows();
    expect(rows.map((r) => [r.graphitiFactUuid, r.proposerFactUuid])).toEqual([
      [EDGE_A, EDGE_B],
      [EDGE_A, EDGE_C],
    ]);
  });

  it("files C-vs-A separately too, when the shared fact is on the proposer side", async () => {
    await scan(conflict(EDGE_A, EDGE_B));
    await scan(conflict(EDGE_C, EDGE_A));
    expect(await openRows()).toHaveLength(2);
  });

  it("reuses the row when the same pair is reported in either orientation", async () => {
    const [first] = await scan(conflict(EDGE_A, EDGE_B));
    const [again] = await scan(conflict(EDGE_A, EDGE_B));
    const [swapped] = await scan(conflict(EDGE_B, EDGE_A));

    expect(again).toBe(first);
    expect(swapped).toBe(first);
    expect(await openRows()).toHaveLength(1);
  });

  it("files a fresh row for a pair whose earlier dispute was already resolved", async () => {
    const [first] = await scan(conflict(EDGE_A, EDGE_B));
    await qa.factDispute.update({ where: { id: first }, data: { status: "resolved_existing" } });

    const [second] = await scan(conflict(EDGE_A, EDGE_B));
    expect(second).not.toBe(first);
    expect(await openRows()).toHaveLength(1);
  });

  it("reuses an open row with no proposer uuid rather than re-filing it after the upgrade", async () => {
    // A row filed before proposerFactUuid existed: its pair is unknown.
    const legacy = await qa.factDispute.create({
      data: {
        orgId: ORG,
        scopePath: SCOPE,
        graphitiFactUuid: EDGE_B,
        proposerActorType: "human",
        proposerActorId: "author-a",
        existingActorType: "human",
        existingActorId: "author-b",
      },
    });

    const [id] = await scan(conflict(EDGE_A, EDGE_B));
    expect(id).toBe(legacy.id);
    expect(await openRows()).toHaveLength(1);
  });

  it("never reuses another org's open row for the same scope path and edge pair", async () => {
    // Scope paths and edge uuids are not unique across tenants, so the orgId
    // filter is the only thing keeping these two lookups apart. Removing it
    // hands ORG the other tenant's dispute id and files nothing for ORG.
    const [otherId] = await scanIn(OTHER_ORG, conflict(EDGE_A, EDGE_B));
    const [ownId] = await scan(conflict(EDGE_A, EDGE_B));

    expect(ownId).not.toBe(otherId);
    expect((await openRows()).map((r) => r.id)).toEqual([ownId]);
    expect((await openRows(OTHER_ORG)).map((r) => r.id)).toEqual([otherId]);
  });
});
