// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Derived writes: can an agent launder scope A's private content into a scope B that
// people without A read, by writing a summary of it?
//
// The agent holds one capability token whose grants allow read on A and write on B, and
// nothing else. It reads A, then writes text derived from what it read into B, in one MCP
// session, the way a summarizing agent works. A second agent whose token reads B only
// then reads B. Two shapes: A and B siblings, and A a parent with B its child (a reader of
// the child cannot read the parent).
//
// The rule, session taint plus a declared downgrade, is built in
// services/access/derived-writes.ts. The cases marked "now:" pin it:
//
// - the derived write is refused, naming the scope read and the declaration that would
//   allow it, and nothing is stored;
// - declared, it is stored with provenance: a `derivedFrom` edge to A, and a B-only reader
//   is told the fact was shared from a restricted scope, never A's name;
// - a declared share leaves its own audit row in A, naming B.
//
// Every test pins a positive control too (the content was really written, the reader
// really reads B), so none of them can pass on an error or an empty answer. The wider
// matrix (sessions, tokens, tenants, rules, declarations, cost) is
// mcp/derived-write.realdb.test.ts.
//
// Real: the hosted MCP endpoint over a socket, check() against live capabilities and
// agent grants, the write-through store into Postgres. A stand-in memory service answers
// embeddings with one fixed vector and serves each ingested episode back from /search as
// one fact, the real service's no-relation path.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const ORG = "derivedleakqa";
const ROOT = `org_${ORG}`;
/** Sibling pair: deal room (private) and all-staff (shared). */
const DEALS = `${ROOT}.deals`;
const ALL_STAFF = `${ROOT}.allstaff`;
/** Parent/child pair: the board (private) and its town hall (readable on its own). */
const BOARD = `${ROOT}.board`;
const TOWN_HALL = `${ROOT}.board.townhall`;

const DEAL_SECRET = "Project Falcon: we will acquire Heron Shipping for $41M, signing 2026-11-02, board only.";
const DEAL_SUMMARY = "Weekly summary: Falcon is on track, Heron Shipping at $41M, signing early November.";
const BOARD_SECRET = "Board minutes: Dana Reyes will be replaced as CFO in Q1, not announced.";
const BOARD_SUMMARY = "Town hall prep: expect a CFO change in Q1 (Dana Reyes).";

describe.skipIf(!QA_URL)("derived writes: an agent that reads scope A and writes scope B", () => {
  const service = new NoRelationMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  const scopeIds = new Map<string, string>();
  /** Read A, write B, nothing else: the summarizing agent's one token. */
  let summarizer = "";
  let allStaffReader = "";
  /** Writes B only, having read nothing: the control for an unmarked fact. */
  let allStaffWriter = "";
  let townHallReader = "";

  async function mint(
    agentId: string,
    scopePath: string,
    permission: "read" | "write",
    grantGoverned = false,
  ): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
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

  async function grant(agentId: string, scopePath: string, permission: "read" | "write"): Promise<void> {
    await db.grant.create({
      data: { orgId: ORG, scopeId: scopeIds.get(scopePath)!, granteeType: "agent", granteeId: agentId, permission },
    });
  }

  /** Several tool calls in one MCP session, the way one agent works through a task. */
  async function session(token: string, calls: [string, Record<string, unknown>][]): Promise<ToolAnswer[]> {
    return mcpSession(mcpUrl, token, calls);
  }

  async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const [answer] = await session(token, [[name, args]]);
    return answer;
  }

  async function versionOf(content: string): Promise<{ id: string; scopePath: string | null }> {
    const rows = await db.memoryChunk.findMany({
      where: { orgId: ORG, content },
      select: { id: true, scopePath: true },
    });
    expect(rows, `stored versions of: ${content}`).toHaveLength(1);
    return rows[0];
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

    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: ORG } });
    for (const path of [ROOT, DEALS, ALL_STAFF, BOARD, TOWN_HALL]) {
      const scope = await db.scope.create({ data: { orgId: ORG, path, name: path.split(".").at(-1)! } });
      scopeIds.set(path, scope.id);
    }

    // The private content, each written by an agent that may write only there.
    for (const [writer, scopePath, content, name] of [
      ["deal-desk", DEALS, DEAL_SECRET, "Project Falcon"],
      ["board-clerk", BOARD, BOARD_SECRET, "Board minutes"],
    ] as const) {
      const written = await call(await mint(writer, scopePath, "write"), "memory_ingest", { content, name, scopePath });
      expect(written.isError, written.answer).toBe(false);
    }

    // The summarizer's token is minted on the org root, and its grants narrow it to read
    // on each A and write on each B (services/access/check.ts, agent grant re-derivation).
    await grant("summarizer", DEALS, "read");
    await grant("summarizer", ALL_STAFF, "write");
    await grant("summarizer", BOARD, "read");
    await grant("summarizer", TOWN_HALL, "write");
    summarizer = await mint("summarizer", ROOT, "write", true);

    allStaffReader = await mint("allstaff-reader", ALL_STAFF, "read");
    allStaffWriter = await mint("allstaff-writer", ALL_STAFF, "write");
    townHallReader = await mint("townhall-reader", TOWN_HALL, "read");
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it("control: each B reader is refused A, and the summarizer may read A but not write it", async () => {
    const siblingRead = await call(allStaffReader, "memory_query", { query: "Project Falcon", scopePath: DEALS });
    expect(siblingRead.isError, siblingRead.answer).toBe(true);
    expect(siblingRead.answer).not.toContain("$41M");

    const parentRead = await call(townHallReader, "memory_query", { query: "Board minutes", scopePath: BOARD });
    expect(parentRead.isError, parentRead.answer).toBe(true);
    expect(parentRead.answer).not.toContain("Dana Reyes");

    const [readA, writeA] = await session(summarizer, [
      ["memory_query", { query: "Project Falcon", scopePath: DEALS }],
      [
        "memory_ingest",
        { content: "Falcon note the summarizer may not store.", name: "Project Falcon", scopePath: DEALS },
      ],
    ]);
    expect(readA.isError, readA.answer).toBe(false);
    expect(readA.answer).toContain(DEAL_SECRET);
    expect(writeA.isError, writeA.answer).toBe(true);
  });

  /** Forget what the summarizer was shown (the taint never expires on its own): each test starts untainted. */
  beforeEach(async () => {
    if (QA_URL === undefined) return;
    await db.sessionScopeRead.deleteMany({ where: { orgId: ORG } });
  });

  it("now: a summary of a sibling scope is refused, naming the scope read and the fix, and nothing is stored", async () => {
    const [readA, writeB] = await session(summarizer, [
      ["memory_query", { query: "Project Falcon", scopePath: DEALS }],
      ["memory_ingest", { content: DEAL_SUMMARY, name: "Weekly summary", scopePath: ALL_STAFF }],
    ]);
    expect(readA.answer).toContain(DEAL_SECRET);
    expect(writeB.isError, writeB.answer).toBe(true);
    expect(writeB.answer).toContain(`intentionalShareFrom: ["${DEALS}"]`);
    expect(await db.memoryChunk.count({ where: { orgId: ORG, content: DEAL_SUMMARY } })).toBe(0);

    const served = await call(allStaffReader, "memory_query", { query: "Falcon summary", scopePath: ALL_STAFF });
    expect(served.isError, served.answer).toBe(false);
    expect(served.answer).not.toContain("$41M");
  });

  it("now: a summary of a parent scope written into its child is refused the same way", async () => {
    const [readA, writeB] = await session(summarizer, [
      ["memory_query", { query: "Board minutes", scopePath: BOARD }],
      ["memory_ingest", { content: BOARD_SUMMARY, name: "Town hall prep", scopePath: TOWN_HALL }],
    ]);
    expect(readA.answer).toContain(BOARD_SECRET);
    expect(writeB.isError, writeB.answer).toBe(true);
    expect(writeB.answer).toContain(`intentionalShareFrom: ["${BOARD}"]`);

    const served = await call(townHallReader, "memory_query", { query: "CFO change", scopePath: TOWN_HALL });
    expect(served.isError, served.answer).toBe(false);
    expect(served.answer).not.toContain("Dana Reyes");
  });

  it("now: a declared share is stored with provenance, and a reader of B only is told it came from a restricted scope", async () => {
    const [, writeB] = await session(summarizer, [
      ["memory_query", { query: "Project Falcon", scopePath: DEALS }],
      [
        "memory_ingest",
        { content: DEAL_SUMMARY, name: "Weekly summary", scopePath: ALL_STAFF, intentionalShareFrom: [DEALS] },
      ],
    ]);
    expect(writeB.isError, writeB.answer).toBe(false);
    expect(writeB.answer).toContain(`Shared from ${DEALS} as declared`);
    const derived = await versionOf(DEAL_SUMMARY);
    expect(derived.scopePath).toBe(ALL_STAFF);

    // One derivedFrom edge from the stored version to A's scope row.
    const edges = await db.factEdge.findMany({
      where: { orgId: ORG, fromId: derived.id },
      select: { kind: true, toId: true },
    });
    expect(edges).toEqual([{ kind: "derivedFrom", toId: scopeIds.get(DEALS) }]);

    // The B reader sees the content and the marker, never A's name.
    const served = await call(allStaffReader, "memory_query", { query: "Falcon summary", scopePath: ALL_STAFF });
    expect(served.answer).toContain("Heron Shipping at $41M");
    const bullet = served.answer.split("\n").find((line) => line.includes(DEAL_SUMMARY));
    expect(bullet).toContain("shared from a restricted scope");
    expect(served.answer).not.toContain(DEALS);
    const version = await call(allStaffReader, "memory_version", { versionId: derived.id });
    expect(version.answer).toContain(`scope: ${ALL_STAFF}`);
    expect(version.answer).toContain("shared from a restricted scope");
    expect(version.answer).not.toContain(DEALS);

    // A fact written in B from nothing carries no marker.
    const original = "Weekly summary: the all-staff lunch moves to Thursday.";
    const written = await call(allStaffWriter, "memory_ingest", {
      content: original,
      name: "Weekly summary",
      scopePath: ALL_STAFF,
    });
    expect(written.isError, written.answer).toBe(false);
    const plain = (await call(allStaffReader, "memory_query", { query: "Weekly summary", scopePath: ALL_STAFF })).answer
      .split("\n")
      .find((line) => line.includes(original));
    expect(plain).toBeDefined();
    expect(plain).not.toContain("shared from");
  });

  it("now: a declared share leaves its own audit row in A, naming B, beside the read and the write", async () => {
    const rows = await db.auditLog.findMany({
      where: { orgId: ORG, actorId: "summarizer", decision: "allow" },
      select: { action: true, target: true, metadata: true },
    });
    const declassified = rows.filter((row) => row.action === "memory.write.declassified");
    expect(declassified, JSON.stringify(rows)).toHaveLength(1);
    expect(declassified[0].target).toBe(DEALS);
    expect(declassified[0].metadata).toMatchObject({ sharedInto: ALL_STAFF });
    expect(rows.some((row) => row.action === "memory.read" && row.target?.includes(DEALS))).toBe(true);
    expect(rows.some((row) => row.action === "memory.write" && row.target?.includes(ALL_STAFF))).toBe(true);

    // The two refused derived writes above left deny rows that name only their target.
    const denies = await db.auditLog.findMany({
      where: {
        orgId: ORG,
        actorId: "summarizer",
        decision: "deny",
        action: "memory.write",
        reason: { startsWith: "derived write refused" },
      },
      select: { target: true, reason: true },
    });
    expect(denies.map((row) => row.target).sort()).toEqual([ALL_STAFF, TOWN_HALL]);
    for (const row of denies) expect(row.reason).not.toMatch(/deals|board/);
  });
});
