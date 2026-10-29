// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// memory_query's note on a served "never" claim that another served record mentions. Real:
// Postgres, the memory_query tool handler, check() against live capabilities, the hybrid store
// and pgvector's scoped SQL, and the answer text as served. Doubles: the embedding service (one
// fixed vector) and the graph service (finds nothing).
//
// The rules under test: the note follows the served records, quotes the claim and the mention
// as served, and comes before the read-grant note; a mention the reader's scope does not serve
// is never quoted, so the note says nothing about a record the reader cannot read.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { READ_GRANT_NOTE, checkedScopeNote, neverClaimNote } from "./read-notes";

vi.mock("@/services/memory/store", async () => {
  const { HybridMemoryStore } = await import("@/services/memory/hybrid-store");
  const { PgvectorMemoryStore } = await import("@/services/memory/pgvector-store");
  const graph = { retrieve: async () => ({ facts: [], storesRead: [{ store: "graph" }] }) };
  return { graphitiStore: graph, memory: new HybridMemoryStore(graph as never, new PgvectorMemoryStore()) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "neverclaim";
const ROOT = `org_${ORG}`;
const HOME = `${ROOT}.home`;
const OFFICE = `${ROOT}.office`;
const DIMENSIONS = 384;
const QUERY_VECTOR = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;
const QUERY = "Have I ever used Zotero?";

const NEVER = "USER: I've never used Zotero, so where do I start?";
const DOWNLOADED = "USER: I downloaded Zotero on March 2 and tagged forty sources with it.";

type ToolReply = { content: { type: "text"; text: string }[]; isError?: boolean };

describe.skipIf(!QA_URL)("the note on a served never claim, on a real memory_query read", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];

  const insertChunk = (id: string, content: string, scopePath: string, occurredAt: string) =>
    db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","occurredAt","createdAt")
       VALUES ($1, $2, $3, 'text', 'agent', 'recorder', $4, $5::vector, $6::timestamp, (NOW() AT TIME ZONE 'UTC'))`,
      id,
      ORG,
      content,
      scopePath,
      QUERY_VECTOR,
      occurredAt.replace("Z", ""),
    );

  /** memory_query's whole answer to a reader of `scopePath`. */
  async function answer(scopePath: string): Promise<string> {
    const agentId = `zotero-reader-${Math.random().toString(36).slice(2)}`;
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
    const reply = await tools.get("memory_query")!({ query: QUERY, limit: 20, scopePath });
    expect(reply.isError).not.toBe(true);
    return reply.content.map((block) => block.text).join("\n");
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
    for (const path of [ROOT, HOME, OFFICE]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    await insertChunk("c-a-never", NEVER, HOME, "2026-09-01T08:00:00.000Z");
  });

  it("follows the served records, quoting the claim and the mention, before the read-grant note", async () => {
    await insertChunk("c-b-downloaded", DOWNLOADED, HOME, "2026-09-08T08:00:00.000Z");

    const text = await answer(HOME);
    const note = neverClaimNote("I've never used Zotero, so where do I start", 1, DOWNLOADED, QUERY);
    // The revision receipt follows every answer (mcp/revision-receipt.ts).
    // The checked-scope note (mcp/read-notes.ts) sits between this note and the read-grant note.
    expect(text).toContain(
      `(agent) · version c-b-downloaded\n\n${note}\n\n${checkedScopeNote(HOME)}\n\n${READ_GRANT_NOTE}\nrevision: `,
    );
    expect(text.split("\n").filter((line) => line.startsWith("•"))).toHaveLength(2);
  });

  it("never quotes a mention the reader's scope does not serve", async () => {
    await insertChunk("c-b-downloaded", DOWNLOADED, OFFICE, "2026-09-08T08:00:00.000Z");

    const text = await answer(HOME);
    expect(text).not.toContain("possible conflict");
    expect(text).not.toContain("downloaded Zotero");
  });
});
