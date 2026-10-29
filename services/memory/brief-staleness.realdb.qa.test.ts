// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Edge cases of services/memory/brief-staleness.ts. The
// sibling brief-staleness.realdb.test.ts proves the main path (a channel edit makes
// the brief that read it stale, and not another channel's). This file pins the edges
// that suite leaves open, one guard each: a source change before the brief existed, a
// new message that replaces nothing, a deleted source, a cited fact that moved with no
// source change behind it (changed, gone, invalidated, superseded), and a brief whose
// run read no connected source.
//
// Same harness as the sibling: the real connector sync step and its change events,
// createBrief() with citations and provenance, check() with a live capability, both
// read routes. The graph store is a double that can also report a fact invalidated.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { FindFactByIdInput, IngestInput } from "@/types/memory";

/** The graph double's state: fact id to its text, and the episode each fact came from. */
const graph = vi.hoisted(() => ({
  facts: new Map<string, { fact: string; episodeId: string; invalidAt?: string }>(),
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
      return found ? { uuid: input.factId, fact: found.fact, invalidAt: found.invalidAt ?? null } : null;
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

const ORG = "qa_brief_staleness_edges";
const ROOT = `org_${ORG}`;
const ENG = `${ROOT}.eng`;
const DEPLOYS = "src-qa-stale-edges-deploys";
const DESIGN = "src-qa-stale-edges-design";

describe.skipIf(!QA_URL)("brief staleness: the edges of what counts as derived-from changing", () => {
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
    return briefCiting(`fact-of-${episodeId}`, new Set([sourceId]));
  }

  /** A handoff brief citing one fact, recording `sourcesRead` as the sources its run read. */
  async function briefCiting(factId: string, sourcesRead: ReadonlySet<string>): Promise<string> {
    const brief = await createBrief(
      {
        orgId: ORG,
        type: "handoff",
        scopePath: ENG,
        title: `Handoff citing ${factId}`,
        summary: "s",
        sections: [{ heading: "Notes", content: "c" }],
      },
      { actorType: "agent", actorId: "handoff-agent", origin: "agent-run" },
      [{ sectionIndex: 0, factId, factText: graph.facts.get(factId)!.fact }],
      sourcesRead,
    );
    return brief.id;
  }

  /** A fact an agent wrote straight into the graph, from no connected source. */
  function agentFact(factId: string, fact: string): string {
    graph.facts.set(factId, { fact, episodeId: `agent-episode-${factId}` });
    return factId;
  }

  const FRESH = { route: false, acknowledge: false };
  const STALE = { route: true, acknowledge: true };

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
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    graph.facts.clear();
    await db.org.deleteMany({ where: { id: ORG } });
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

  describe("a source change counts only when it lands after the brief, and only when it replaces or removes", () => {
    it("reads a brief fresh when its channel was edited before the brief was generated", async () => {
      const first = await sync(DEPLOYS, "#deploys", "Deploys go out on Tuesdays", "d1");
      const edited = await sync(DEPLOYS, "#deploys", "Deploys go out on Thursdays", "d2", first);
      const brief = await briefFrom(DEPLOYS, edited);

      expect(await readStale(brief)).toEqual(FRESH);
    });

    // The rule: "a new item is not a change to what was read".
    it("reads a brief fresh when its channel only gained a new message after it", async () => {
      const brief = await briefFrom(DEPLOYS, await sync(DEPLOYS, "#deploys", "Deploys go out on Tuesdays", "d1"));
      await sync(DEPLOYS, "#deploys", "Welcome to the channel", "w1", undefined, "welcome");

      expect(await readStale(brief)).toEqual(FRESH);
    });

    it("reads a brief stale once a source it read no longer exists, and leaves the other source's brief fresh", async () => {
      const deploysBrief = await briefFrom(
        DEPLOYS,
        await sync(DEPLOYS, "#deploys", "Deploys go out on Tuesdays", "d1"),
      );
      const designBrief = await briefFrom(DESIGN, await sync(DESIGN, "#design", "Buttons use the ember accent", "g1"));
      await db.source.delete({ where: { id: DEPLOYS } });

      expect(await readStale(deploysBrief)).toEqual(STALE);
      expect(await readStale(designBrief)).toEqual(FRESH);
    });
  });

  describe("a cited fact that moved makes its brief stale on its own, with no source change behind it", () => {
    // Agent-written facts: no connector sync writes a change event for them, so only the citation can carry the change.
    it("reads a brief stale when the fact it cited now says something else", async () => {
      const factId = agentFact("fact-agent-runbook", "Rollbacks need two approvals");
      const brief = await briefCiting(factId, new Set([DESIGN]));
      const other = await briefCiting(agentFact("fact-agent-oncall", "On-call rotates weekly"), new Set([DESIGN]));
      graph.facts.set(factId, { fact: "Rollbacks need one approval", episodeId: graph.facts.get(factId)!.episodeId });

      expect(await readStale(brief)).toEqual(STALE);
      expect(await readStale(other)).toEqual(FRESH);
    });

    it("reads a brief stale when the fact it cited is gone from the store", async () => {
      const factId = agentFact("fact-agent-runbook", "Rollbacks need two approvals");
      const brief = await briefCiting(factId, new Set([DESIGN]));
      graph.facts.delete(factId);

      expect(await readStale(brief)).toEqual(STALE);
    });

    it("reads a brief stale when the store marks the fact it cited invalid", async () => {
      const factId = agentFact("fact-agent-runbook", "Rollbacks need two approvals");
      const brief = await briefCiting(factId, new Set([DESIGN]));
      graph.facts.set(factId, { ...graph.facts.get(factId)!, invalidAt: new Date().toISOString() });

      expect(await readStale(brief)).toEqual(STALE);
    });

    it("reads a brief stale when a later fact is recorded as superseding the one it cited", async () => {
      const factId = agentFact("fact-agent-runbook", "Rollbacks need two approvals");
      const brief = await briefCiting(factId, new Set([DESIGN]));
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "fact-agent-runbook-v2",
          toId: factId,
          kind: "supersedes",
          scopePath: ENG,
          actorType: "agent",
          actorId: "notes-agent",
        },
      });

      expect(await readStale(brief)).toEqual(STALE);
    });
  });

  it("reads a brief whose run read no connected source fresh through any source edit or scope write", async () => {
    const deploysEpisode = await sync(DEPLOYS, "#deploys", "Deploys go out on Tuesdays", "d1");
    const brief = await briefCiting(agentFact("fact-agent-runbook", "Rollbacks need two approvals"), new Set());
    await sync(DEPLOYS, "#deploys", "Deploys go out on Thursdays", "d2", deploysEpisode);
    await recordAppliedChange({
      orgId: ORG,
      actorType: "agent",
      actorId: "notes-agent",
      action: "memory.write",
      scopePath: ENG,
      origin: "mcp",
    });

    expect(await readStale(brief)).toEqual(FRESH);
  });
});
