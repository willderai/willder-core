// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The free plan's lifetime episode cap (services/guardrails.ts checkEpisodeCap) is a hosted
// billing limit. A self-hosted or local install's org (lib/selfhost-install.ts) is created
// on the schema's default plan, "free", with the default cap of 1,000, so before this a
// self-host install refused every memory write after its 1,000th, forever. Here an org in
// exactly that state, already holding 1,000 episodes, takes write #1001 through the request
// path's real ingest, while a hosted free org in the same state is still refused, and a
// self-host org is refused too when the process carries a hosted deployment's marker.
//
// Real: Postgres, ingestMemory's store-and-announce path, checkEpisodeCap and recordEpisode.
// Stand-ins: the graph store (writes skipped) and the memory service's /embed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

vi.mock("@/services/memory/store", () => ({
  memory: { ingest: async () => ({ episodeId: "graph-episode" }) },
  graphitiStore: { ingest: async () => ({ episodeId: "graph-episode" }) },
}));

const QA_URL = process.env.QA_DATABASE_URL;

/** Org id → the clerkOrgId it is created under. */
const ORGS = {
  "org-qa-cap-selfhosted": "self-hosted",
  "org-qa-cap-localdev": "local-dev",
  "org-qa-cap-hosted": "org_qa_cap_hosted",
} as const;
type OrgId = keyof typeof ORGS;
const HOSTED_MARKERS = ["VERCEL", "VERCEL_ENV", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"];

describe.skipIf(!QA_URL)("the free plan's episode cap on a self-hosted install and on hosted", () => {
  let db: PrismaClient;
  let ingestMemory: (typeof import("./inngest"))["ingestMemory"];

  const write = (orgId: OrgId, content: string) =>
    ingestMemory({
      groupId: orgId,
      content,
      name: `Cap probe ${content}`,
      source: "mcp",
      actorType: "agent",
      origin: "mcp",
      actorId: "agent-cap",
      actorName: "agent-cap",
      scopePath: `org_${orgId}.notes`,
      skipGraphExtraction: true,
    });

  async function clear() {
    const ids = Object.keys(ORGS);
    const clerkIds = Object.values(ORGS) as string[];
    const orgs = await db.org.findMany({
      where: { OR: [{ id: { in: ids } }, { clerkOrgId: { in: clerkIds } }] },
      select: { id: true },
    });
    const all = orgs.map((o) => o.id);
    await db.changeEvent.deleteMany({ where: { orgId: { in: all } } });
    for (const id of all) {
      await db.$executeRaw`DELETE FROM fact_edges WHERE "orgId" = ${id}`;
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${id}`;
    }
    await db.org.deleteMany({ where: { id: { in: all } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubEnv("INNGEST_BYPASS", "1");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith("/embed")) throw new Error(`unexpected fetch to ${url}`);
      return { ok: true, status: 200, json: async () => ({ embedding: new Array(384).fill(0.01) }) } as Response;
    });
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ ingestMemory } = await import("./inngest"));
    await clear();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (!db) return;
    await clear();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const name of HOSTED_MARKERS) vi.stubEnv(name, "");
    await clear();
    // As an install created before this fix looks: the schema's default plan and cap
    // (plan "free", episodeCapIncluded 1000), with the cap already reached.
    for (const [id, clerkOrgId] of Object.entries(ORGS)) {
      await db.org.create({ data: { id, clerkOrgId, name: id, episodeCount: 1000 } });
    }
  });

  it("starts every org on the hosted free plan at its cap", async () => {
    const orgs = await db.org.findMany({ where: { id: { in: Object.keys(ORGS) } } });
    expect(orgs).toHaveLength(3);
    for (const org of orgs) expect(org).toMatchObject({ plan: "free", episodeCapIncluded: 1000, episodeCount: 1000 });
  });

  it.each(["org-qa-cap-selfhosted", "org-qa-cap-localdev"] as const)(
    "%s accepts write #1001 and #1002",
    async (orgId) => {
      const first = await write(orgId, "the 1001st write");
      expect(first.versionId).toBeDefined();
      const second = await write(orgId, "the 1002nd write");
      expect(second.versionId).toBeDefined();
      const org = await db.org.findUniqueOrThrow({ where: { id: orgId } });
      expect(org).toMatchObject({ plan: "free", episodeCount: 1002 });
    },
  );

  it("a hosted free org is still refused at write #1001, storing nothing", async () => {
    await expect(write("org-qa-cap-hosted", "the 1001st write")).rejects.toMatchObject({
      name: "GuardrailError",
      code: "episode_cap_exceeded",
      message: "Free plan memory cap (1000 episodes) reached — upgrade to keep adding memory",
    });
    expect((await db.org.findUniqueOrThrow({ where: { id: "org-qa-cap-hosted" } })).episodeCount).toBe(1000);
    const [{ n }] = await db.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM memory_chunks WHERE "orgId" = 'org-qa-cap-hosted'`;
    expect(Number(n)).toBe(0);
  });

  it("a hosted free org below its cap still takes writes and counts them", async () => {
    await db.org.update({ where: { id: "org-qa-cap-hosted" }, data: { episodeCount: 999 } });
    expect((await write("org-qa-cap-hosted", "the 1000th write")).versionId).toBeDefined();
    expect((await db.org.findUniqueOrThrow({ where: { id: "org-qa-cap-hosted" } })).episodeCount).toBe(1000);
    await expect(write("org-qa-cap-hosted", "the 1001st write")).rejects.toMatchObject({
      code: "episode_cap_exceeded",
    });
  });

  it("a self-host org is capped when the process is a hosted deployment (fails closed)", async () => {
    vi.stubEnv("VERCEL", "1");
    await expect(write("org-qa-cap-selfhosted", "the 1001st write")).rejects.toMatchObject({
      code: "episode_cap_exceeded",
    });
    expect((await db.org.findUniqueOrThrow({ where: { id: "org-qa-cap-selfhosted" } })).episodeCount).toBe(1000);
  });
});
