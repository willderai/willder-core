// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The derived-write rule (services/access/derived-writes.ts) end to end, through the hosted
// MCP endpoint: a write into scope B after the agent's session was shown content from a
// scope outside B's subtree is refused unless the write declares it in
// `intentionalShareFrom`. mcp/derived-write-leak.realdb.qa.test.ts pins the measured leak
// this closes (siblings, parent into child, provenance and audit). This file pins the rest
// of the rule: which reads taint, which writes are checked, what a declaration may name,
// that a session never ends, tenants, what the source scope's readers are told, and
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
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

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
const ORG = "derivedwrites";
const OTHER_ORG = "derivedwrites2";
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
    ops: `${root}.ops`,
    legal: `${root}.legal`,
  };
};
const S = scopesOf(ORG);
const S2 = scopesOf(OTHER_ORG);

const DEAL_SECRET = "Project Falcon: we will acquire Heron Shipping for $41M.";
const BOARD_SECRET = "Board minutes: the CFO will be replaced in Q1.";
const TOWN_HALL_NOTE = "Town hall agenda: Q4 roadmap and the office move.";
const RESEARCH_GRAPH_FACT = "Heron Shipping's debt covenants restrict any sale before 2027.";
const BRIEF_SECRET = "Handoff: Falcon diligence is blocked on Heron's pension liabilities.";

// Vitest's 5 s test and 10 s hook defaults are not claims about this code. Setup starts an MCP
// server and mints a dozen tokens through it, and a test can run many calls, so on a busy shared
// runner either can pass the default. Each still fails if it hangs, at the limits below.
describe.skipIf(!QA_URL)("derived writes: the rule, its declarations and its sessions", { timeout: 30_000 }, () => {
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

  /**
   * Forget every scope any agent in both orgs was shown. The taint never expires, so the
   * product has no way back to an untainted agent; the tests reset the record directly, as
   * if each test's agents were fresh agent ids.
   */
  async function forget(): Promise<void> {
    await db.sessionScopeRead.deleteMany({ where: { orgId: { in: [ORG, OTHER_ORG] } } });
  }

  /** Move every record in both orgs back by `minutes`, as that long without a call would. */
  async function idle(minutes: number): Promise<void> {
    await db.$executeRaw`
      UPDATE "session_scope_reads" SET "lastReadAt" = "lastReadAt" - make_interval(mins => ${minutes})
      WHERE "orgId" IN (${ORG}, ${OTHER_ORG})
    `;
  }

  const stored = (org: string, content: string) => db.memoryChunk.count({ where: { orgId: org, content } });

  async function seedOrg(org: string, s: ReturnType<typeof scopesOf>): Promise<void> {
    await deleteOrgsWithRetry(db, { where: { id: org } });
    await db.org.create({ data: { id: org, name: org } });
    for (const path of [s.root, s.deals, s.allStaff, s.board, s.townHall, s.research, s.hr, s.ops, s.legal]) {
      const scope = await db.scope.create({ data: { orgId: org, path, name: path.split(".").at(-1)! } });
      scopeIds.set(path, scope.id);
    }
    // The summarizer: one token on the org root, narrowed by grants to read every scope
    // but hr and legal, and to write all-staff, the board and its town hall.
    for (const path of [s.deals, s.allStaff, s.board, s.research, s.ops]) await grant(org, "summarizer", path, "read");
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
  }, 120_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  }, 60_000);

  // Each test starts from agents that have been shown nothing.
  beforeEach(async () => {
    if (QA_URL !== undefined) await forget();
  });

  describe("which writes need no declaration", () => {
    it("a read of the target's own subtree: a child's content written into its parent", async () => {
      const content = "Board summary: the town hall covers the roadmap and the move.";
      const [readChild, writeParent] = await session(tokens.summarizer, [
        read(S.townHall, "Town hall agenda"),
        write(S.board, content),
      ]);
      expect(readChild.answer).toContain(TOWN_HALL_NOTE);
      expect(writeParent.isError, writeParent.answer).toBe(false);
      expect(await stored(ORG, content)).toBe(1);
    });

    it("the reply to the agent's own write: writing B, then a sibling of B", async () => {
      const first = "All-staff: the lunch moves to Thursday.";
      const second = "Town hall: the lunch moves to Thursday too.";
      const [writeB, writeSibling] = await session(tokens.summarizer, [
        write(S.allStaff, first),
        write(S.townHall, second),
      ]);
      expect(writeB.isError, writeB.answer).toBe(false);
      expect(writeSibling.isError, writeSibling.answer).toBe(false);
    });

    it("but reading the agent's own earlier write back does taint: it is content of that scope now", async () => {
      const [, writeSibling] = await session(tokens.summarizer, [
        read(S.allStaff, "lunch"),
        write(S.townHall, "Town hall: lunch details from all-staff."),
      ]);
      expect(writeSibling.isError, writeSibling.answer).toBe(true);
      expect(writeSibling.answer).toContain(`"${S.allStaff}"`);
    });
  });

  describe("which reads taint", () => {
    it("a fact with no stored version behind it taints the scope it was read under", async () => {
      const [readA, writeB] = await session(tokens.summarizer, [
        read(S.research, "covenants"),
        write(S.allStaff, "Heron cannot be sold before 2027."),
      ]);
      expect(readA.answer).toContain(RESEARCH_GRAPH_FACT);
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`intentionalShareFrom: ["${S.research}"]`);
    });

    it("a read at the org root records the scope each served fact is stored in, and the root only for a fact with no version", async () => {
      const [readRoot, writeB] = await session(tokens.rootWriter, [
        read(S.root, "Project Falcon"),
        write(S.allStaff, "Root read summary."),
      ]);
      expect(readRoot.answer).toContain(DEAL_SECRET);
      expect(readRoot.answer).toContain(RESEARCH_GRAPH_FACT);
      const recorded = await db.sessionScopeRead.findMany({
        where: { orgId: ORG, agentId: "root-writer" },
        select: { scopePath: true },
      });
      // Deals and the board are where the stored facts live; the root stands in for the
      // research graph fact, which has no stored version to say where it lives.
      expect(recorded.map((row) => row.scopePath)).toEqual(expect.arrayContaining([S.deals, S.board, S.root]));
      expect(recorded.map((row) => row.scopePath)).not.toContain(S.research);
      // Declaring the root, which the session read, covers everything it read below it.
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`intentionalShareFrom: ["${S.root}"]`);
    });

    it("a fact seen only as a change-feed line taints its scope like a whole read", async () => {
      const line = "Falcon: the data room opens Monday.";
      const written = await call(tokens.dealDesk, "memory_ingest", { content: line, name: line, scopePath: S.deals });
      expect(written.isError, written.answer).toBe(false);
      // GET /api/changes serves the feed with no task-start block in front of it.
      const { GET } = await import("@/app/api/changes/route");
      const feed = await GET(
        new Request(`http://localhost/api/changes?scope=${S.deals}`, {
          headers: { authorization: `Bearer ${tokens.summarizer}` },
        }),
      );
      expect(feed.status).toBe(200);
      expect(JSON.stringify(await feed.json())).toContain("data room opens Monday");
      const [writeB] = await session(tokens.summarizer, [write(S.allStaff, "The data room opens soon.")]);
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`"${S.deals}"`);
    });

    it("a brief taints its own scope", async () => {
      const [brief, writeB] = await session(tokens.summarizer, [
        ["get_my_brief", { scopePath: S.deals }],
        write(S.allStaff, "Falcon is blocked on pensions."),
      ]);
      expect(brief.answer).toContain(BRIEF_SECRET);
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`"${S.deals}"`);
    });

    it("content is never compared: a paraphrase sharing no words with what was read is refused the same", async () => {
      const [, writeB] = await session(tokens.summarizer, [
        read(S.deals, "Project Falcon"),
        write(S.allStaff, "A buyer is lined up for a logistics firm."),
      ]);
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(await stored(ORG, "A buyer is lined up for a logistics firm.")).toBe(0);
    });
  });

  describe("rules", () => {
    it("a decision carrying a sibling's content is refused and no rule is recorded; declared, it is recorded and its fact is marked", async () => {
      const text = "Decision: no all-staff mention of Heron until signing.";
      const [, refused] = await session(tokens.summarizer, [
        read(S.deals, "Project Falcon"),
        write(S.allStaff, text, { kind: "decision" }),
      ]);
      expect(refused.isError, refused.answer).toBe(true);
      expect(await db.convention.count({ where: { orgId: ORG, text } })).toBe(0);

      const [declared] = await session(tokens.summarizer, [
        write(S.allStaff, text, { kind: "decision", intentionalShareFrom: [S.deals] }),
      ]);
      expect(declared.isError, declared.answer).toBe(false);
      expect(await db.convention.count({ where: { orgId: ORG, text } })).toBe(1);
      const version = await db.memoryChunk.findFirstOrThrow({
        where: { orgId: ORG, content: text },
        select: { id: true },
      });
      expect(
        await db.factEdge.count({
          where: { orgId: ORG, fromId: version.id, kind: "derivedFrom", toId: scopeIds.get(S.deals) },
        }),
      ).toBe(1);
    });
  });

  describe("what a declaration may name", () => {
    it("only a scope the session read: never-read, absent and hidden scopes get one identical refusal", async () => {
      const answers: string[] = [];
      for (const named of [S.board, `${S.root}.nosuch`, S.hr]) {
        const [, , writeB] = await session(tokens.summarizer, [
          read(S.deals, "Project Falcon"),
          read(S.allStaff, "lunch"),
          write(S.allStaff, `Shared from ${named}?`, { intentionalShareFrom: [S.deals, named] }),
        ]);
        expect(writeB.isError, writeB.answer).toBe(true);
        expect(await stored(ORG, `Shared from ${named}?`)).toBe(0);
        answers.push(writeB.answer.replaceAll(named, "<scope>").replace(/\(reference \w+\)/, ""));
      }
      expect(answers[0]).toContain("which this agent id has not read");
      expect(answers[1]).toBe(answers[0]);
      expect(answers[2]).toBe(answers[0]);
    });

    it("not a scope inside the target, which needs no declaration", async () => {
      const [, writeB] = await session(tokens.summarizer, [
        read(S.townHall, "agenda"),
        write(S.board, "Board: agenda noted.", { intentionalShareFrom: [S.townHall] }),
      ]);
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`"${S.townHall}", which is inside ${S.board}`);
    });

    it("every tainting scope: declaring one of two still refuses, naming only the other", async () => {
      const [, , writeB] = await session(tokens.summarizer, [
        read(S.deals, "Project Falcon"),
        read(S.board, "Board minutes"),
        write(S.allStaff, "Summary of deals and board.", { intentionalShareFrom: [S.deals] }),
      ]);
      expect(writeB.isError, writeB.answer).toBe(true);
      // The board read also served its town hall's content; declaring the board covers both.
      expect(writeB.answer).toContain(`intentionalShareFrom: ["${S.board}"]`);
      expect(writeB.answer).not.toContain(`"${S.deals}"`);
    });

    it("a declared scope covers what the session read inside it", async () => {
      const content = "Board and town hall summary for all staff.";
      const [, , writeB] = await session(tokens.summarizer, [
        read(S.board, "Board minutes"),
        read(S.townHall, "agenda"),
        write(S.allStaff, content, { intentionalShareFrom: [S.board] }),
      ]);
      expect(writeB.isError, writeB.answer).toBe(false);
      const version = await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content }, select: { id: true } });
      const edges = await db.factEdge.findMany({ where: { orgId: ORG, fromId: version.id }, select: { toId: true } });
      expect(edges).toEqual([{ toId: scopeIds.get(S.board) }]);
    });
  });

  describe("working notes", () => {
    const note = (scopePath: string, body: string, extra: Record<string, unknown> = {}) =>
      ["memory_note", { kind: "status", task: "falcon summary", body, scopePath, ...extra }] as [
        string,
        Record<string, unknown>,
      ];

    it("a post after a sibling read is refused, offers no declaration a note cannot make, and leaves a deny row naming only the target", async () => {
      const denyWhere = {
        orgId: ORG,
        actorId: "summarizer",
        decision: "deny" as const,
        reason: { startsWith: "derived write refused" },
      };
      const before = (await db.auditLog.findMany({ where: denyWhere, select: { id: true } })).map((row) => row.id);
      const [, posted] = await session(tokens.summarizer, [
        read(S.deals, "Falcon"),
        note(S.allStaff, "Falcon status for all staff."),
      ]);
      expect(posted.isError, posted.answer).toBe(true);
      expect(posted.answer).toContain(`derived_write: this agent id was shown content stored in "${S.deals}"`);
      expect(posted.answer).toContain("A working note cannot declare a share");
      expect(posted.answer).not.toContain("send the write again");
      expect(
        await db.workingNote.count({
          where: { orgId: ORG, scopePath: S.allStaff, body: "Falcon status for all staff." },
        }),
      ).toBe(0);
      const denies = await db.auditLog.findMany({
        where: { ...denyWhere, id: { notIn: before } },
        select: { target: true, reason: true },
      });
      expect(denies.map((row) => row.target)).toEqual([S.allStaff]);
      expect(denies[0].reason).not.toContain("deals");
    });

    it("a post inside the read's own subtree is allowed: a child's content noted in its parent", async () => {
      const [, posted] = await session(tokens.summarizer, [
        read(S.townHall, "agenda"),
        note(S.board, "Town hall agenda is set."),
      ]);
      expect(posted.isError, posted.answer).toBe(false);
    });

    it("releasing the agent's own note after a sibling read is not checked: it carries no content", async () => {
      const [posted] = await session(tokens.summarizer, [
        note(S.allStaff, "Starting the lunch summary.", { task: "lunch summary" }),
      ]);
      expect(posted.isError, posted.answer).toBe(false);
      const [, released] = await session(tokens.summarizer, [
        read(S.deals, "Falcon"),
        ["memory_note", { kind: "status", task: "lunch summary", action: "release", scopePath: S.allStaff }],
      ]);
      expect(released.isError, released.answer).toBe(false);
      expect(released.answer).toContain("Released status");
    });
  });

  // Ops holds only working notes, and legal only a source link: no stored version behind
  // either, so a refusal naming one of them was tainted by the note or the link alone.
  describe("working notes read from another scope", () => {
    const opsNote = (body: string, extra: Record<string, unknown> = {}) =>
      ["memory_note", { kind: "status", task: "ops rota", body, scopePath: S.ops, ...extra }] as [
        string,
        Record<string, unknown>,
      ];

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      tokens.opsLead = await mint(ORG, "ops-lead", S.ops, "write");
    }, 60_000);

    it("a note seen as a change-feed line taints its scope, though the note has since been released", async () => {
      const body = "Ops: the on-call rota moves to the Lisbon team.";
      const [posted, released] = await session(tokens.opsLead, [opsNote(body), opsNote(body, { action: "release" })]);
      expect(posted.isError, posted.answer).toBe(false);
      expect(released.isError, released.answer).toBe(false);
      // GET /api/changes serves the feed with no task-start block in front of it, and the
      // released note is in no block either: the feed is the only path that showed it.
      const { GET } = await import("@/app/api/changes/route");
      const feed = await GET(
        new Request(`http://localhost/api/changes?scope=${S.ops}`, {
          headers: { authorization: `Bearer ${tokens.summarizer}` },
        }),
      );
      expect(feed.status).toBe(200);
      expect(JSON.stringify(await feed.json())).toContain("Lisbon team");
      const [writeB] = await session(tokens.summarizer, [write(S.allStaff, "On-call moves to Lisbon.")]);
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`"${S.ops}"`);
    });

    it("a note the agent posted itself is its own text, not a read", async () => {
      const [posted] = await session(tokens.opsLead, [opsNote("Ops: checking the rota.", { task: "own rota" })]);
      expect(posted.isError, posted.answer).toBe(false);
      const { GET } = await import("@/app/api/changes/route");
      const feed = await GET(
        new Request(`http://localhost/api/changes?scope=${S.ops}`, {
          headers: { authorization: `Bearer ${tokens.opsLead}` },
        }),
      );
      expect(feed.status).toBe(200);
      expect(
        await db.sessionScopeRead.count({
          where: { orgId: ORG, agentId: "ops-lead", lastReadAt: { gt: new Date(Date.now() - 60_000) } },
        }),
      ).toBe(0);
    });

    it("another agent's earlier claim named in a claim's reply taints the claim's scope", async () => {
      const task = "q4 vendor audit";
      const [opsClaim] = await session(tokens.opsLead, [
        opsNote("Ops: auditing the Heron vendor contract.", { kind: "claim", task }),
      ]);
      expect(opsClaim.isError, opsClaim.answer).toBe(false);
      const [claim, writeB] = await session(tokens.summarizer, [
        ["memory_note", { kind: "claim", task, body: "Board: starting the vendor audit.", scopePath: S.board }],
        write(S.allStaff, "The vendor audit is under way."),
      ]);
      expect(claim.isError, claim.answer).toBe(false);
      expect(claim.answer).toContain("Heron vendor contract");
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`"${S.ops}"`);
    });

    it("a note served in the task-start block taints its scope", async () => {
      const body = "Ops: the Heron warehouse lease is up for renewal.";
      const [posted] = await session(tokens.opsLead, [opsNote(body, { task: "lease renewal" })]);
      expect(posted.isError, posted.answer).toBe(false);
      // The feed is read past the post first, and that read's taint is then forgotten, so the
      // post is in no change notice of the next call: only its block shows the live note.
      await call(tokens.rootWriter, "memory_changes", {});
      await forget();
      const [readB, writeB] = await session(tokens.rootWriter, [
        read(S.allStaff, "lunch"),
        write(S.allStaff, "The warehouse lease renews soon."),
      ]);
      expect(readB.answer).toContain("lease renewal");
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`"${S.ops}"`);
    });
  });

  describe("source links", () => {
    const link = (scopePath: string) =>
      [
        "fact_link_source",
        { graphitiFactUuid: "no-such-fact", sourceType: "pr", sourceRef: "https://example.test/pr/1", scopePath },
      ] as [string, Record<string, unknown>];

    it("recording a link after a sibling read is refused before the fact is looked up, and leaves a deny row naming only the target", async () => {
      const denyWhere = {
        orgId: ORG,
        actorId: "summarizer",
        decision: "deny" as const,
        reason: { startsWith: "derived write refused" },
      };
      const before = (await db.auditLog.findMany({ where: denyWhere, select: { id: true } })).map((row) => row.id);
      const [, linked] = await session(tokens.summarizer, [read(S.deals, "Falcon"), link(S.allStaff)]);
      expect(linked.isError, linked.answer).toBe(true);
      expect(linked.answer).toContain(`derived_write: this agent id was shown content stored in "${S.deals}"`);
      expect(linked.answer).toContain("A source link cannot declare a share");
      const denies = await db.auditLog.findMany({
        where: { ...denyWhere, id: { notIn: before } },
        select: { target: true },
      });
      expect(denies.map((row) => row.target)).toEqual([S.allStaff]);

      // From an untainted agent the same call reaches the fact lookup, which finds nothing.
      await forget();
      const [untainted] = await session(tokens.summarizer, [link(S.allStaff)]);
      expect(untainted.isError, untainted.answer).toBe(true);
      expect(untainted.answer).not.toContain("derived_write");
    });

    it("a stale link served in the task-start block taints its scope", async () => {
      const sourceRef = "https://example.test/legal/heron-nda";
      await db.factProvenance.create({
        data: {
          orgId: ORG,
          scopePath: S.legal,
          graphitiFactUuid: "legal-fact",
          sourceType: "file",
          sourceRef,
          ownerId: "legal-clerk",
          status: "potentially_stale",
          flaggedAt: new Date(),
        },
      });
      const [readB, writeB] = await session(tokens.rootWriter, [
        read(S.allStaff, "lunch"),
        write(S.allStaff, "The NDA source moved."),
      ]);
      expect(readB.answer).toContain(sourceRef);
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`"${S.legal}"`);
    });
  });

  describe("sessions", () => {
    it("a second MCP connection of the same agent is the same session", async () => {
      await session(tokens.summarizer, [read(S.deals, "Project Falcon")]);
      const writeB = (await session(tokens.summarizer, [write(S.allStaff, "Second connection summary.")]))[0];
      expect(writeB.isError, writeB.answer).toBe(true);
    });

    it("a second token of the same agent is the same session", async () => {
      await session(tokens.summarizer, [read(S.deals, "Project Falcon")]);
      const writeB = (await session(tokens.summarizerSecond, [write(S.allStaff, "Second token summary.")]))[0];
      expect(writeB.isError, writeB.answer).toBe(true);
    });

    // Found in review: the taint was a 30-minute lease
    // that expired toward danger. The agent's context window outlives any idle gap, so
    // content read from deals landed in all-staff 31 minutes later with no declaration, no
    // `memory.write.declassified` row and no derivedFrom marker. The taint now never expires.
    it("31 minutes after reading deals, writing the deal secret into all-staff is still refused or declared", async () => {
      const [shown] = await session(tokens.summarizer, [read(S.deals, "Project Falcon")]);
      expect(shown.answer).toContain(DEAL_SECRET);
      await idle(31);
      const leaked = `All-staff digest: ${DEAL_SECRET}`;
      const writeB = (await session(tokens.summarizer, [write(S.allStaff, leaked)]))[0];
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(await stored(ORG, leaked)).toBe(0);
    });

    // A read records the scopes it showed and leaves the rest of the record alone: reading only
    // all-staff, many times over, after one read of deals must not wash deals out of the record.
    // Both ways a read records a scope: by the stored version it served, and by the scope it was
    // authorized on for a graph fact with no stored version behind it.
    it.each(["a stored version", "a graph fact with no stored version"] as const)(
      "after one read of deals, many reads of all-staff alone (%s) still leave a write into all-staff refused for deals",
      async (shape) => {
        const canteen =
          shape === "a stored version"
            ? "All-staff: the canteen reopens on Monday."
            : "All-staff: the canteen menu now lists allergens.";
        const sourceId = `${ORG}-allstaff-drive`;
        try {
          if (shape === "a stored version") {
            const [posted] = await session(tokens.colleague, [write(S.allStaff, canteen)]);
            expect(posted.isError, posted.answer).toBe(false);
          } else {
            await db.source.create({
              data: {
                id: sourceId,
                orgId: ORG,
                type: "gdrive",
                externalId: "allstaff-folder",
                name: "All staff",
                scopePath: S.allStaff,
              },
            });
            await db.sourceFile.create({
              data: {
                sourceId,
                externalFileId: "canteen.pdf",
                checksum: "v1",
                episodeIds: ["ep-allstaff-canteen"],
                episodeScopePath: S.allStaff,
              },
            });
            service.seedGraphOnly(toGid(S.allStaff), canteen, { sourceId, episodeId: "ep-allstaff-canteen" });
          }
          const [shown] = await session(tokens.summarizer, [read(S.deals, "Project Falcon")]);
          expect(shown.answer).toContain(DEAL_SECRET);
          for (let i = 0; i < 5; i++) {
            const [readB] = await session(tokens.summarizer, [read(S.allStaff, "canteen")]);
            expect(readB.answer).toContain(canteen);
          }
          const recorded = await db.sessionScopeRead.findMany({
            where: { orgId: ORG, agentId: "summarizer" },
            select: { scopePath: true },
          });
          expect(recorded.map((row) => row.scopePath)).toEqual(expect.arrayContaining([S.deals, S.allStaff]));
          const leaked = `All-staff digest: ${DEAL_SECRET}`;
          const writeB = (await session(tokens.summarizer, [write(S.allStaff, leaked)]))[0];
          expect(writeB.isError, writeB.answer).toBe(true);
          expect(writeB.answer).toContain(`"${S.deals}"`);
          expect(await stored(ORG, leaked)).toBe(0);
        } finally {
          await db.sourceFile.deleteMany({ where: { sourceId } });
          await db.source.deleteMany({ where: { id: sourceId } });
        }
      },
    );

    it("every memory call keeps the session alive: 40 minutes after the read, with a call between, it still holds", async () => {
      await session(tokens.summarizer, [read(S.deals, "Project Falcon")]);
      await idle(20);
      await session(tokens.summarizer, [read(S.allStaff, "lunch")]);
      await idle(20);
      const writeB = (await session(tokens.summarizer, [write(S.townHall, "Kept-alive summary.")]))[0];
      expect(writeB.isError, writeB.answer).toBe(true);
      expect(writeB.answer).toContain(`"${S.deals}"`);
    });

    it("another agent's session is its own: the rule cannot see content passed between agents outside Willder", async () => {
      await session(tokens.summarizer, [read(S.deals, "Project Falcon")]);
      const writeB = (await session(tokens.colleague, [write(S.allStaff, "Colleague note.")]))[0];
      expect(writeB.isError, writeB.answer).toBe(false);
    });
  });

  describe("tenants", () => {
    it("an agent id in another org has its own session, and cannot declare this org's scopes", async () => {
      await session(tokens.summarizer, [read(S.deals, "Project Falcon")]);
      const untainted = (await session(tokens.otherOrgSummarizer, [write(S2.allStaff, "Other org note.")]))[0];
      expect(untainted.isError, untainted.answer).toBe(false);

      const [, declaring] = await session(tokens.otherOrgSummarizer, [
        read(S2.allStaff, "note"),
        write(S2.allStaff, "Other org declaring.", { intentionalShareFrom: [S.deals] }),
      ]);
      expect(declaring.isError, declaring.answer).toBe(true);
      expect(declaring.answer).toContain("which this agent id has not read");
    });
  });

  describe("a declared share, as each reader sees it", () => {
    const shared = "Falcon update for all staff: a signing is expected in November.";
    let versionId = "";

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      await forget();
      await call(tokens.dealsReader, "memory_changes", {});
      const [, writeB] = await session(tokens.summarizer, [
        read(S.deals, "Project Falcon"),
        write(S.allStaff, shared, { intentionalShareFrom: [S.deals] }),
      ]);
      expect(writeB.isError, writeB.answer).toBe(false);
      versionId = (
        await db.memoryChunk.findFirstOrThrow({ where: { orgId: ORG, content: shared }, select: { id: true } })
      ).id;
    }, 60_000);

    it("a reader of the source scope is told where its content went, through the change feed", async () => {
      const changes = await call(tokens.dealsReader, "memory_changes", {});
      expect(changes.answer).toContain(`Shared into ${S.allStaff}`);
    });

    it("a reader of the target only sees no change in the source scope", async () => {
      const changes = await call(tokens.allStaffReader, "memory_changes", {});
      expect(changes.answer).not.toContain(S.deals);
    });

    it("a reader of both scopes is told the source by name", async () => {
      const version = await call(tokens.rootReader, "memory_version", { versionId });
      expect(version.answer).toContain(`shared from ${S.deals}`);
    });

    it("a reader of the target only is told it came from a restricted scope", async () => {
      const version = await call(tokens.allStaffReader, "memory_version", { versionId });
      expect(version.answer).toContain("shared from a restricted scope");
      expect(version.answer).not.toContain(S.deals);
    });
  });

  describe("the store", () => {
    it("writes a declared share's edges in the statement that stores the version, so a queued write is marked when its job stores it", async () => {
      const { pgvectorStore } = await import("@/services/memory/pgvector-store");
      const input = {
        groupId: ORG,
        content: "Queued share: Falcon signing moved to December.",
        name: "Queued share",
        actorType: "agent" as const,
        actorId: "summarizer",
        origin: "mcp" as const,
        scopePath: S.allStaff,
        derivedFromTargets: [scopeIds.get(S.deals)!],
      };
      const { episodeId, inserted } = await pgvectorStore.ingestOnce(input);
      expect(inserted).toBe(true);
      const edges = await db.factEdge.findMany({
        where: { orgId: ORG, fromId: episodeId },
        select: { kind: true, toId: true, scopePath: true },
      });
      expect(edges).toEqual([{ kind: "derivedFrom", toId: scopeIds.get(S.deals), scopePath: S.allStaff }]);

      // The same content again stores nothing, and no second edge.
      const again = await pgvectorStore.ingestOnce(input);
      expect(again).toMatchObject({ episodeId, inserted: false });
      expect(await db.factEdge.count({ where: { orgId: ORG, fromId: episodeId } })).toBe(1);
    });
  });

  describe("cost", () => {
    // What the check costs, said without a clock: one database statement however many scopes the
    // session holds, so its cost does not grow with the session. The latency budget for the same
    // decision is in derived-write.perf.realdb.test.ts, which CI does not run.
    it.each([1, 50, 200])(
      "deciding a write against a session of %i scopes takes one database statement",
      async (scopes) => {
        const { decideDerivedWrite } = await import("@/services/access/derived-writes");
        const { db: appDb } = await import("@/lib/db");
        const agentId = `cost-probe-${scopes}`;
        await db.$executeRaw`
        INSERT INTO "session_scope_reads" ("orgId", "agentId", "scopePath", "lastReadAt")
        SELECT ${ORG}, ${agentId}, ${S.root} || '.team' || n, (now() AT TIME ZONE 'UTC') FROM generate_series(1, ${scopes}::int) AS n
      `;
        let statements = 0;
        const counted = new Proxy(appDb, {
          get(target, property) {
            const value = Reflect.get(target, property);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (property === "$queryRaw" || property === "$executeRaw") statements++;
              return value.apply(target, args);
            };
          },
        });
        // The decision refuses (the session holds scopes outside the target), so it ran to its end.
        await expect(decideDerivedWrite(counted, { orgId: ORG, agentId, target: S.allStaff })).rejects.toThrow(
          "derived_write",
        );
        expect(statements).toBe(1);
      },
    );
  });
});
