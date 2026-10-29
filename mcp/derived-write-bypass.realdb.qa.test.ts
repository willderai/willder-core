// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The derived-write rule (services/access/derived-writes.ts) end to end, through the hosted
// MCP endpoint: a write into scope B after the agent's session was shown content from a
// scope outside B's subtree is refused unless the write declares it in
// `intentionalShareFrom`. mcp/derived-write-leak.realdb.qa.test.ts pins the measured leak
// this closes (siblings, parent into child, provenance and audit). This file pins the rest
// of the rule: which reads taint, which writes are checked, what a declaration may name,
// where a session starts and ends, tenants, what the source scope's readers are told, and
// what the check costs.
//
// Real: the MCP endpoint over a socket, check() against live capabilities and agent
// grants, Postgres. A fake memory service answers embeddings with one fixed vector and
// serves each ingested episode back from /search as one fact.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toGid } from "@/services/memory/graphiti-store";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { NoRelationMemoryService } from "./no-relation-memory-service.testsupport";
import { mcpSession, type ToolAnswer } from "./mcp-session.testsupport";

vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => {
          throw new Error("no llm in this test");
        },
      },
    },
  }),
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "dwbypassqa";
const OTHER_ORG = "dwbypassqa2";
const scopesOf = (org: string) => {
  const root = `org_${org}`;
  return {
    root,
    deals: `${root}.deals`,
    allStaff: `${root}.allstaff`,
    board: `${root}.board`,
    townHall: `${root}.board.townhall`,
    research: `${root}.research`,
    hr: `${root}.hr`,
  };
};
const S = scopesOf(ORG);
const S2 = scopesOf(OTHER_ORG);

const DEAL_SECRET = "Project Falcon: we will acquire Heron Shipping for $41M.";
const BOARD_SECRET = "Board minutes: the CFO will be replaced in Q1.";
const TOWN_HALL_NOTE = "Town hall agenda: Q4 roadmap and the office move.";
const RESEARCH_GRAPH_FACT = "Heron Shipping's debt covenants restrict any sale before 2027.";
const BRIEF_SECRET = "Handoff: Falcon diligence is blocked on Heron's pension liabilities.";

describe.skipIf(!QA_URL)("derived writes: other write tools in the same session", () => {
  const service = new NoRelationMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  const scopeIds = new Map<string, string>();
  const tokens: Record<string, string> = {};

  async function mint(
    org: string,
    agentId: string,
    scopePath: string,
    permission: "read" | "write",
    grantGoverned = false,
  ): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: org,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        grantGoverned,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  async function grant(org: string, agentId: string, scopePath: string, permission: "read" | "write"): Promise<void> {
    await db.grant.create({
      data: { orgId: org, scopeId: scopeIds.get(scopePath)!, granteeType: "agent", granteeId: agentId, permission },
    });
  }

  const session = (token: string, calls: [string, Record<string, unknown>][]): Promise<ToolAnswer[]> =>
    mcpSession(mcpUrl, token, calls);
  const call = async (token: string, name: string, args: Record<string, unknown>): Promise<ToolAnswer> =>
    (await session(token, [[name, args]]))[0];
  const read = (scopePath: string, query = "anything") =>
    ["memory_query", { query, scopePath }] as [string, Record<string, unknown>];
  // Each write names its own fact, so no write is ever a stale update of another test's.
  const write = (scopePath: string, content: string, extra: Record<string, unknown> = {}) =>
    ["memory_ingest", { content, name: content, scopePath, ...extra }] as [string, Record<string, unknown>];

  /** Forget every scope any agent in both orgs was shown: the taint never expires on its own. */
  async function forget(): Promise<void> {
    await db.sessionScopeRead.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  }

  async function seedOrg(org: string, s: ReturnType<typeof scopesOf>): Promise<void> {
    await db.org.deleteMany({ where: { id: org } });
    await db.org.create({ data: { id: org, name: org } });
    for (const path of [s.root, s.deals, s.allStaff, s.board, s.townHall, s.research, s.hr]) {
      const scope = await db.scope.create({ data: { orgId: org, path, name: path.split(".").at(-1)! } });
      scopeIds.set(path, scope.id);
    }
    // The summarizer: one token on the org root, narrowed by grants to read every scope
    // but hr, and to write all-staff, the board and its town hall.
    for (const path of [s.deals, s.allStaff, s.board, s.research]) await grant(org, "summarizer", path, "read");
    for (const path of [s.allStaff, s.board, s.townHall]) await grant(org, "summarizer", path, "write");
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    process.env.GRAPHITI_SERVICE_URL = await service.start();
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });

    const inngestModule = await import("@/lib/inngest");
    vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await seedOrg(ORG, S);
    await seedOrg(OTHER_ORG, S2);

    for (const [writer, scopePath, content] of [
      ["deal-desk", S.deals, DEAL_SECRET],
      ["board-clerk", S.board, BOARD_SECRET],
      ["town-hall-clerk", S.townHall, TOWN_HALL_NOTE],
    ] as const) {
      const written = await call(await mint(ORG, writer, scopePath, "write"), "memory_ingest", {
        content,
        name: "Seed",
        scopePath,
      });
      expect(written.isError, written.answer).toBe(false);
    }
    // Research holds only what graph extraction produced: a fact with no stored version behind it.
    // A Drive folder's extraction, synced into research: served while its sync record lists it.
    await db.source.create({
      data: {
        id: `${ORG}-research-drive`,
        orgId: ORG,
        type: "gdrive",
        externalId: "research-folder",
        name: "Research",
        scopePath: S.research,
      },
    });
    await db.sourceFile.create({
      data: {
        sourceId: `${ORG}-research-drive`,
        externalFileId: "covenants.pdf",
        checksum: "v1",
        episodeIds: ["ep-research-covenants"],
        episodeScopePath: S.research,
      },
    });
    service.seedGraphOnly(toGid(S.research), RESEARCH_GRAPH_FACT, {
      sourceId: `${ORG}-research-drive`,
      episodeId: "ep-research-covenants",
    });
    await db.brief.create({
      data: {
        orgId: ORG,
        type: "handoff",
        scopePath: S.deals,
        title: "Falcon handoff",
        summary: BRIEF_SECRET,
        sections: [],
      },
    });

    tokens.dealDesk = await mint(ORG, "deal-desk", S.deals, "write");
    tokens.summarizer = await mint(ORG, "summarizer", S.root, "write", true);
    tokens.summarizerSecond = await mint(ORG, "summarizer", S.root, "write", true);
    tokens.otherOrgSummarizer = await mint(OTHER_ORG, "summarizer", S2.root, "write", true);
    tokens.colleague = await mint(ORG, "colleague", S.allStaff, "write");
    tokens.rootWriter = await mint(ORG, "root-writer", S.root, "write");
    tokens.dealsReader = await mint(ORG, "deals-reader", S.deals, "read");
    tokens.allStaffReader = await mint(ORG, "allstaff-reader", S.allStaff, "read");
    tokens.rootReader = await mint(ORG, "root-reader", S.root, "read");
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  // Each test starts from agents that have been shown nothing.
  beforeEach(async () => {
    if (QA_URL !== undefined) await forget();
  });

  // `memory_note` is a write into a scope, gated on memory.write like
  // memory_ingest, and its task and body are served to the scope's other agents on their
  // next tool call. A session that read a sibling scope must not post that content there
  // undeclared, or the rule is one tool call away from a bypass.
  it("a working note carrying a sibling's content is refused like memory_ingest, and no B reader is shown it", async () => {
    const [readDeals, note] = await session(tokens.summarizer, [
      read(S.deals, "Falcon"),
      ["memory_note", { kind: "status", task: "falcon summary", body: DEAL_SECRET, scopePath: S.allStaff }],
    ]);
    expect(readDeals.answer).toContain(DEAL_SECRET);
    expect(note.isError, note.answer).toBe(true);
    expect(note.answer).toContain("derived_write");
    const [colleagueView] = await session(tokens.colleague, [read(S.allStaff, "anything")]);
    expect(colleagueView.answer).not.toContain("Heron Shipping");
  });

  it("control: the same working note from an untainted session is posted", async () => {
    const [note] = await session(tokens.summarizer, [
      [
        "memory_note",
        { kind: "status", task: "lunch summary", body: "Lunch moves to Thursday.", scopePath: S.allStaff },
      ],
    ]);
    expect(note.isError, note.answer).toBe(false);
  });
  // The eight race suites that opt out of the rule were the only
  // concurrent callers of session_scope_reads' row locks. One agent's reads and writes
  // racing on its own session must neither deadlock nor fail for any reason but the rule.
  it(
    "forty concurrent read-and-write sessions of one agent, all inside the target's subtree, all succeed",
    { timeout: 120_000 },
    async () => {
      const runs = Array.from({ length: 40 }, (_, i) =>
        session(i % 2 ? tokens.summarizer : tokens.summarizerSecond, [
          read(i % 3 ? S.townHall : S.board, "Town hall agenda"),
          write(S.board, `Board digest ${i}: the town hall covers the roadmap.`),
          read(S.board, "digest"),
        ]),
      );
      const answers = (await Promise.all(runs)).flat();
      const failed = answers.filter((a) => a.isError).map((a) => a.answer);
      expect(failed).toEqual([]);
    },
  );
});
