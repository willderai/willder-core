// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Two rules the module states that no test held
// through the real memory_query handler. A later record is linked only within one scope (a
// record in a child scope the reader also reads is another scope), and only within one
// provenance tier, as memory_query's own provenanceRank ranks it. Before the fix a mutant that
// links a child scope's record, and one that hands serveLaterUpdatesFirst a flat tier from
// memory_query, both left every test green.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const graph = { retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }) };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "updatelinkqa3";
const ROOT = `org_${ORG}`;
const HOME = `${ROOT}.home`;
const KIDS = `${HOME}.kids`;
const DIMENSIONS = 384;
const QUERY_VECTOR = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
const QUERY = "What is the monthly grocery budget Alexis and I agreed on?";

const AGREED = "USER: I've agreed with Alexis on a $500 monthly budget for groceries.";
const RAISED = "USER: Our grocery budget was increased to $550 monthly starting September 15.";
const AGREED_AT = "2026-09-01T08:00:00.000Z";
const RAISED_AT = "2026-09-08T08:00:00.000Z";

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };

describe.skipIf(!QA_URL)("update link round 3: one scope and one tier, on a real memory_query read", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];

  // Every row has the same embedding, so pgvector ranks by id within a tier.
  const insertChunk = (id: string, content: string, scopePath: string, occurredAt: string, actorType = "agent") =>
    db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","occurredAt","createdAt")
       VALUES ($1, $2, $3, 'text', $7, 'recorder', $4, $5::vector, $6::timestamp, (NOW() AT TIME ZONE 'UTC'))`,
      id,
      ORG,
      content,
      scopePath,
      QUERY_VECTOR,
      occurredAt.replace("Z", ""),
      actorType,
    );
  /** The bullets memory_query answers a reader of `scopePath` with. */
  async function servedLines(scopePath: string, query = QUERY): Promise<string[]> {
    const agentId = `budget-reader-${Math.random().toString(36).slice(2)}`;
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: agentId, capabilityToken: token },
      origin: "mcp",
    };
    const tools = new Map<string, (args: Record<string, unknown>) => Promise<ToolReply>>();
    const server = {
      registerTool: (name: string, _c: unknown, handler: (args: Record<string, unknown>) => Promise<ToolReply>) =>
        tools.set(name, handler),
    };
    registerWillderTools(server as never, ctx, { orgId: ORG, agentId, scopePath });
    const reply = await tools.get("memory_query")!({ query, limit: 20, scopePath });
    expect(reply.isError).not.toBe(true);
    return reply.content
      .map((block) => block.text)
      .join("\n")
      .split("\n")
      .filter((line) => line.startsWith("•"));
  }

  async function clear() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("./tools"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await clear();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ embedding: [1, ...Array(DIMENSIONS - 1).fill(0)] }), { status: 200 }),
      ),
    );
    await clear();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    for (const path of [ROOT, HOME, KIDS]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
  });

  it("links the later record of the same scope (control)", async () => {
    await insertChunk("c-a-agreed", AGREED, HOME, AGREED_AT);
    await insertChunk("c-b-raised", RAISED, HOME, RAISED_AT);

    const lines = await servedLines(HOME);
    expect(lines[0]).toContain("version c-b-raised");
    expect(lines[1]).toContain("a later record on this is shown above");
  });

  it("never links a record in a child scope, even for a reader of both", async () => {
    await insertChunk("c-a-agreed", AGREED, HOME, AGREED_AT);
    await insertChunk("c-b-raised", RAISED, KIDS, RAISED_AT);

    const lines = await servedLines(HOME);
    expect(
      lines.some((line) => line.includes("version c-b-raised")),
      "the reader of home is served the child's record",
    ).toBe(true);
    expect(lines[0]).toContain("version c-a-agreed");
    expect(lines.join("\n")).not.toContain("later record");
  });

  it("never links an agent's later record to a person's first line", async () => {
    await insertChunk("c-a-agreed", AGREED, HOME, AGREED_AT, "human");
    await insertChunk("c-b-raised", RAISED, HOME, RAISED_AT, "agent");

    const lines = await servedLines(HOME);
    expect(lines[0]).toContain("version c-a-agreed");
    expect(lines.join("\n")).not.toContain("later record");
  });
});
