// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test here is skipped, not failed.
//
// An excerpt is not a read. services/memory/fact-reads.ts defines a READ as a version
// served whole with its id, and a SIGHTING as one shown with text that may not be the
// whole version; only a read moves the writer's horizon past a version. memory_query now
// serves an over-budget fact as a query-focused excerpt (services/memory/query-excerpt.ts)
// with its version id. If that excerpt is recorded as a read, an agent that has seen only
// part of a newer version can write past it as if it had read it, from the part it saw:
// the lost update the stale-read check exists to stop, by way of the excerpt.
//
// Same shape as fact-update-read-paths.realdb.test.ts's change-feed case: A reads the
// short first version whole, B replaces it with a long version, A is served B's version
// only as an excerpt, and A writes back without a base after the contention window.
//
// Real: Postgres, the request-path ingest, check() against live capabilities, the MCP
// tool handlers, pgvector's read SQL, the token-budget packer. Doubles: the embedding
// service (one fixed vector for /embed and /embed-batch), and no graph leg.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { stubEmbedService } from "./embed-service-stub.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/services/memory/store", () => ({
  memory: {
    ingest: vi.fn().mockResolvedValue({ episodeId: "ep-hybrid" }),
    retrieve: async (input: never) => new (await import("./pgvector-store")).PgvectorMemoryStore().retrieve(input),
    entity: async () => null,
  },
  graphitiStore: { ingest: vi.fn().mockResolvedValue({ episodeId: "ep-graph" }), ingestBulk: vi.fn() },
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "excerptnotread";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.release`;
const DIMENSIONS = 384;

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Tools = Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>;

/** A version far over the team tier's 6,000-token page, whose answer sits past its opening. */
const LONG_UPDATE = [
  ...Array.from({ length: 900 }, (_, i) => `Platform note ${i} covers build caching and runner images in detail.`),
  "The release train leaves on Tuesday.",
  ...Array.from({ length: 100 }, (_, i) => `Closing note ${i} lists who signs off on each stage of the rollout.`),
].join(" ");

describe.skipIf(!QA_URL)("an excerpt served by memory_query is a sighting, not a read", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("@/mcp/tools"))["registerWillderTools"];

  async function toolsFor(agentId: string): Promise<Tools> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: agentId, capabilityToken: token },
      origin: "mcp",
    };
    const tools: Tools = new Map();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
        tools.set(name, handler),
    };
    registerWillderTools(server as never, ctx, { orgId: ORG, agentId, scopePath: SCOPE });
    return tools;
  }
  const textOf = (reply: ToolReply) => reply.content.map((block) => block.text).join("\n");
  const versionIn = (reply: ToolReply) => /Version: (\S+?)\./.exec(textOf(reply))?.[1];
  const ingest = (tools: Tools, content: string, baseVersion?: string) =>
    tools.get("memory_ingest")!({
      name: "Release train",
      content,
      scopePath: SCOPE,
      ...(baseVersion ? { baseVersion } : {}),
    });
  const query = (tools: Tools) =>
    tools.get("memory_query")!({ query: "When does the release train leave?", scopePath: SCOPE });

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    ({ registerWillderTools } = await import("@/mcp/tools"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    stubEmbedService(() => new Array(DIMENSIONS).fill(0.01));
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    // The team tier's 6,000-token page, so LONG_UPDATE (~95k characters) is served as an excerpt.
    await db.org.create({ data: { id: ORG, name: ORG, settings: { accountTier: "team" } } });
    await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "release" } });
  });

  it("refuses A's write-back after A saw B's version only as an excerpt, and accepts it once A reads it whole", async () => {
    const seed = await toolsFor("seed");
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const original = versionIn(await ingest(seed, "The release train leaves on Monday."))!;
    expect(textOf(await query(a))).toContain("The release train leaves on Monday.");

    await b.get("memory_version")!({ versionId: original });
    const fromB = versionIn(await ingest(b, LONG_UPDATE, original))!;
    expect(fromB).toBeTruthy();

    // A's only sight of B's version: memory_query, cut to an excerpt that names its version.
    // (The same reply's change notice also shows the version, cut at 200 characters: a
    // sighting by the feed's own rule.)
    const line = textOf(await query(a))
      .split("\n")
      .find((l) => l.startsWith("• "))!;
    expect(line).toContain(`[excerpt of ${LONG_UPDATE.length} chars]`);
    expect(line).toContain(`version ${fromB}`);
    expect(line).toContain("The release train leaves on Tuesday.");
    expect(line).not.toContain("Platform note 0 ");

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const back = await ingest(a, "The release train leaves on Wednesday.");
    expect(textOf(back)).toMatch(new RegExp(`^stale_version: .*${fromB}`));
    expect(back.isError).toBe(true);

    await a.get("memory_version")!({ versionId: fromB });
    const afterReading = await ingest(a, "The release train leaves on Wednesday.");
    expect(afterReading.isError).not.toBe(true);
  }, 60_000);

  // Negative control: the same race where B's version fits the page and is served whole.
  // A has then read it, so the write-back is an informed update and is stored.
  it("stores A's write-back when B's version was served whole", async () => {
    const seed = await toolsFor("seed");
    const a = await toolsFor("writer-a");
    const b = await toolsFor("writer-b");
    const original = versionIn(await ingest(seed, "The release train leaves on Monday."))!;
    await query(a);
    await b.get("memory_version")!({ versionId: original });
    versionIn(await ingest(b, "The release train leaves on Tuesday.", original));

    const served = textOf(await query(a));
    expect(served).toContain("The release train leaves on Tuesday.");
    expect(served).not.toContain("[excerpt of");

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const back = await ingest(a, "The release train leaves on Wednesday.");
    expect(back.isError).not.toBe(true);
  }, 60_000);
});
