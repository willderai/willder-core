// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The two halves of the note rule that mcp/derived-write.realdb.test.ts states but
// does not pin: a working note the caller wrote itself, served back in its own task-start
// block, adds nothing to its derived-write session; and a change notice records only the
// note lines it shows, so a post the notice leaves out (its note has expired) taints
// nothing. That a shown note does taint is pinned there (the feed line test).
//
// Real: the MCP endpoint over a socket, check() against live capabilities, Postgres. A
// fake memory service answers embeddings with one fixed vector.
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
const ORG = "dwnotescopeqa";
const S = {
  root: `org_${ORG}`,
  ops: `org_${ORG}.ops`,
  allStaff: `org_${ORG}.allstaff`,
  // A subtree of its own for the notice test, so no fact the first test wrote is in its block.
  site: `org_${ORG}.site`,
  dock: `org_${ORG}.site.dock`,
  yard: `org_${ORG}.site.yard`,
};

describe.skipIf(!QA_URL)("derived writes, QA: which note lines taint a session", () => {
  const service = new NoRelationMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;

  async function mint(agentId: string, scopePath: string): Promise<string> {
    const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "write",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  const session = (token: string, calls: [string, Record<string, unknown>][]): Promise<ToolAnswer[]> =>
    mcpSession(mcpUrl, token, calls);
  const write = (scopePath: string, content: string) =>
    ["memory_ingest", { content, name: content, scopePath }] as [string, Record<string, unknown>];
  const opsNote = (task: string, body: string) =>
    ["memory_note", { kind: "status", task, body, scopePath: S.ops }] as [string, Record<string, unknown>];

  /** Forget every scope any agent in the org was shown: the taint never expires on its own. */
  async function forget(): Promise<void> {
    await db.sessionScopeRead.deleteMany({ where: { orgId: ORG } });
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
    for (const path of Object.values(S))
      await db.scope.create({ data: { orgId: ORG, path, name: path.split(".").at(-1)! } });
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    if (QA_URL !== undefined) await forget();
  });

  it("the caller's own note, served back in its task-start block, does not taint its scope", async () => {
    const token = await mint("own-noter", S.root);
    const [posted] = await session(token, [opsNote("pallet count", "Ops: counting the Heron pallets.")]);
    expect(posted.isError, posted.answer).toBe(false);
    await forget();

    // A new session: its first call is served the block, which shows the live ops note.
    const [first, writeB] = await session(token, [
      write(S.allStaff, "Lunch moves to noon."),
      write(S.allStaff, "Pallets are being counted."),
    ]);
    expect(first.isError, first.answer).toBe(false);
    expect(first.answer).toContain("pallet count");
    expect(writeB.isError, writeB.answer).toBe(false);
    expect(await db.sessionScopeRead.count({ where: { orgId: ORG, agentId: "own-noter", scopePath: S.ops } })).toBe(0);
  });

  it("a change notice does not record a note post it leaves out because the note expired", async () => {
    const dockLead = await mint("dock-lead", S.dock);
    const [posted] = await session(dockLead, [
      ["memory_note", { kind: "status", task: "dock rota", body: "Dock: bay two closes Friday.", scopePath: S.dock }],
    ]);
    expect(posted.isError, posted.answer).toBe(false);

    // The note has expired: its post is still in the feed, but a notice does not show it.
    await db.workingNote.updateMany({
      where: { orgId: ORG, agentId: "dock-lead" },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const reader = await mint("site-reader", S.site);
    const [inDock, inYard] = await session(reader, [
      write(S.dock, "Dock inbox checked."),
      write(S.yard, "Yard inbox checked."),
    ]);
    expect(inDock.isError, inDock.answer).toBe(false);
    expect(inDock.answer).not.toContain("bay two");
    expect(inYard.isError, inYard.answer).toBe(false);
    expect(await db.sessionScopeRead.count({ where: { orgId: ORG, agentId: "site-reader", scopePath: S.dock } })).toBe(
      0,
    );
  });
});
