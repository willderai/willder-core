// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// After a source changes, every brief derived from it reads
// stale, and no unrelated brief does. Read through the two routes a grantee reads the
// verdict from: GET /api/briefs/:id/staleness and POST /api/briefs/:id/acknowledge.
//
// The workload: two connected Slack channels write into one scope, and a handoff
// brief is generated from each, recording the channel it read and the fact it cited,
// as a real handoff run does. Then one channel's message is edited upstream and
// re-synced through the real connector sync step, and an agent writes an unrelated
// fact into the same scope.
//
// What runs for real: the connector sync step and its change events, createBrief()
// with its citations and provenance, check() with live capabilities and their audit
// rows, both routes. The graph store is a double, because Graphiti needs Neo4j: it
// holds one fact per episode and drops an episode's fact when the episode is removed,
// which is what Graphiti does for a fact only that episode mentioned.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { FindFactByIdInput, IngestInput } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

/** The graph double's state: fact id to its text, and the episode each fact came from. */
const graph = vi.hoisted(() => ({
  facts: new Map<string, { fact: string; episodeId: string }>(),
  nextEpisode: 0,
}));

vi.mock("@/services/memory/store", () => {
  const memory = {
    ingest: async (input: IngestInput) => {
      graph.nextEpisode += 1;
      const episodeId = `ep-${graph.nextEpisode}`;
      graph.facts.set(`fact-of-${episodeId}`, { fact: input.content, episodeId });
      return { episodeId };
    },
    findFactById: async (input: FindFactByIdInput) => {
      const found = graph.facts.get(input.factId);
      return found ? { uuid: input.factId, fact: found.fact, invalidAt: null } : null;
    },
  };
  const graphitiStore = {
    removeEpisode: async ({ episodeId }: { episodeId: string }) => {
      let removed = false;
      for (const [id, f] of graph.facts) {
        if (f.episodeId === episodeId) {
          graph.facts.delete(id);
          removed = true;
        }
      }
      return { removed };
    },
  };
  return { memory, graphitiStore };
});
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));
vi.mock("@/services/enrichment", () => ({ enrich: vi.fn() }));
// The contradiction scan behind a changed brief is a paid model call; it is not what is measured here.
vi.mock("@/services/facts/conflicts", () => ({ findScopeContradictions: vi.fn(async () => []) }));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_brief_staleness";
const ROOT = `org_${ORG}`;
const ENG = `${ROOT}.eng`;
const DEPLOYS = "src-qa-stale-deploys";
const DESIGN = "src-qa-stale-design";

describe.skipIf(!QA_URL)("a brief reads stale exactly when what it was derived from changed", () => {
  let db: PrismaClient;
  let syncOneTextItem: (typeof import("@/lib/inngest"))["syncOneTextItem"];
  let createBrief: (typeof import("./create-brief"))["createBrief"];
  let recordAppliedChange: (typeof import("@/services/access/check"))["recordAppliedChange"];
  let stalenessRoute: typeof import("@/app/api/briefs/[id]/staleness/route");
  let acknowledgeRoute: typeof import("@/app/api/briefs/[id]/acknowledge/route");
  let requireAccessContext: (typeof import("@/lib/access-context"))["requireAccessContext"];

  const channel = (id: string, name: string) => ({
    id,
    orgId: ORG,
    type: "slack",
    name,
    scopePath: ENG,
    connectAuthorizationId: null,
  });

  /** Sync one message of a channel; `previous` is the episode an earlier sync recorded for it. */
  async function sync(
    sourceId: string,
    name: string,
    text: string,
    checksum: string,
    previous?: string,
    message = "msg",
  ) {
    const outcome = await syncOneTextItem(
      channel(sourceId, name),
      { id: `${sourceId}-${message}`, checksum, text },
      previous ? { episodeId: previous, scopePath: ENG } : null,
    );
    expect(outcome).toBe("synced");
    const row = await db.sourceFile.findUniqueOrThrow({
      where: { sourceId_externalFileId: { sourceId, externalFileId: `${sourceId}-${message}` } },
    });
    return row.episodeId as string;
  }

  /** A handoff brief that read one channel and cites the fact that channel's message became. */
  async function briefFrom(sourceId: string, episodeId: string): Promise<string> {
    const factId = `fact-of-${episodeId}`;
    const brief = await createBrief(
      {
        orgId: ORG,
        type: "handoff",
        scopePath: ENG,
        title: `Handoff from ${sourceId}`,
        summary: "s",
        sections: [{ heading: "Notes", content: "c" }],
      },
      { actorType: "agent", actorId: "handoff-agent", origin: "agent-run" },
      [{ sectionIndex: 0, factId, factText: graph.facts.get(factId)!.fact }],
      new Set([sourceId]),
    );
    return brief.id;
  }

  async function signInGrantee(): Promise<void> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "grantee",
        tokenHash: hashCapabilityToken(token),
        scopePath: ENG,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: "grantee", capabilityToken: token },
      origin: "mcp",
    };
    vi.mocked(requireAccessContext).mockResolvedValue({ org: { id: ORG }, user: { id: "grantee" }, ctx } as never);
  }

  /** The verdict each read path gives one brief. */
  async function readStale(briefId: string): Promise<{ route: unknown; acknowledge: unknown }> {
    const params = { params: Promise.resolve({ id: briefId }) };
    const route = await stalenessRoute.GET(new Request("http://t"), params);
    const ack = await acknowledgeRoute.POST(new Request("http://t", { method: "POST" }), params);
    expect([route.status, ack.status]).toEqual([200, 200]);
    return {
      route: ((await route.json()) as { stale?: boolean }).stale,
      acknowledge: ((await ack.json()) as { stale: boolean }).stale,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ syncOneTextItem } = await import("@/lib/inngest"));
    ({ createBrief } = await import("./create-brief"));
    ({ recordAppliedChange } = await import("@/services/access/check"));
    stalenessRoute = await import("@/app/api/briefs/[id]/staleness/route");
    acknowledgeRoute = await import("@/app/api/briefs/[id]/acknowledge/route");
    ({ requireAccessContext } = await import("@/lib/access-context"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    graph.facts.clear();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.scope.createMany({ data: [ROOT, ENG].map((path) => ({ orgId: ORG, path, name: path })) });
    await db.source.createMany({
      data: [
        { id: DEPLOYS, orgId: ORG, type: "slack", externalId: "C-deploys", name: "#deploys", scopePath: ENG },
        { id: DESIGN, orgId: ORG, type: "slack", externalId: "C-design", name: "#design", scopePath: ENG },
      ],
    });
    await signInGrantee();
  });

  it("reads neither brief stale before anything changed", async () => {
    const deploysBrief = await briefFrom(DEPLOYS, await sync(DEPLOYS, "#deploys", "Deploys go out on Tuesdays", "d1"));
    const designBrief = await briefFrom(DESIGN, await sync(DESIGN, "#design", "Buttons use the ember accent", "g1"));

    expect(await readStale(deploysBrief)).toEqual({ route: false, acknowledge: false });
    expect(await readStale(designBrief)).toEqual({ route: false, acknowledge: false });
  });

  it("reads the brief derived from an edited channel stale, and the other channel's brief not", async () => {
    const deploysEpisode = await sync(DEPLOYS, "#deploys", "Deploys go out on Tuesdays", "d1");
    const deploysBrief = await briefFrom(DEPLOYS, deploysEpisode);
    const designBrief = await briefFrom(DESIGN, await sync(DESIGN, "#design", "Buttons use the ember accent", "g1"));

    await sync(DEPLOYS, "#deploys", "Deploys go out on Thursdays", "d2", deploysEpisode);

    expect(await readStale(deploysBrief)).toEqual({ route: true, acknowledge: true });
    expect(await readStale(designBrief)).toEqual({ route: false, acknowledge: false });
  });

  it("reads a brief stale when its channel changed a message it read but did not cite", async () => {
    const deploysEpisode = await sync(DEPLOYS, "#deploys", "Deploys go out on Tuesdays", "d1");
    const freezeEpisode = await sync(DEPLOYS, "#deploys", "Code freeze starts Friday", "f1", undefined, "freeze");
    const deploysBrief = await briefFrom(DEPLOYS, deploysEpisode);
    const designBrief = await briefFrom(DESIGN, await sync(DESIGN, "#design", "Buttons use the ember accent", "g1"));

    await sync(DEPLOYS, "#deploys", "Code freeze starts Thursday", "f2", freezeEpisode, "freeze");

    expect(await readStale(deploysBrief)).toEqual({ route: true, acknowledge: true });
    expect(await readStale(designBrief)).toEqual({ route: false, acknowledge: false });
  });

  it("reads no brief stale for an unrelated fact an agent wrote into the same scope", async () => {
    const deploysBrief = await briefFrom(DEPLOYS, await sync(DEPLOYS, "#deploys", "Deploys go out on Tuesdays", "d1"));
    const designBrief = await briefFrom(DESIGN, await sync(DESIGN, "#design", "Buttons use the ember accent", "g1"));

    // What guarded-store records once an agent's ingest of a new fact has landed.
    await recordAppliedChange({
      orgId: ORG,
      actorType: "agent",
      actorId: "notes-agent",
      action: "memory.write",
      scopePath: ENG,
      origin: "mcp",
    });

    expect(await readStale(deploysBrief)).toEqual({ route: false, acknowledge: false });
    expect(await readStale(designBrief)).toEqual({ route: false, acknowledge: false });
  });
});
