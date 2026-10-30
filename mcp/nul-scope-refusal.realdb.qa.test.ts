// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A NUL in `scopePath` on an MCP write tool is refused with a reply that names the NUL
// and the fix, writes nothing, and leaves exactly one deny row in the caller's own org,
// whose target records the NUL as the six characters \u0000. Every MCP write tool that
// takes a scopePath reaches resolveCallerScopePath's refuse branch, whose audit insert
// used to fail on the NUL itself; the route tests cover the REST callers, this file the
// MCP ones, over the real transport.
//
// Real: the hosted MCP endpoint over a socket, check() against a live capability,
// resolveCallerScopePath and its audit write, Postgres. A second org with its own
// capability shows the deny row lands only in the caller's org. Faked: the memory
// service (a fake on a socket) and the ingest queue (a spy).
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";

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
const ORG = "qa_nul_scope_a";
const OTHER = "qa_nul_scope_b";
const ROOT = `org_${ORG}`;
const NUL = "\u0000";

const NUL_REFUSAL =
  "Access denied: scopePath contains a NUL (\\u0000) character, which is not accepted. Remove it and retry.";

/** Each MCP write tool that takes a scopePath, with valid arguments apart from it. */
const WRITES: Record<string, Record<string, unknown>> = {
  memory_ingest: { name: "Refund owner", content: "Refunds are owned by payments." },
  memory_note: { kind: "claim", task: "refunds", body: "taking the refund owner fix" },
  fact_link_source: { graphitiFactUuid: "fact-1", sourceType: "pr", sourceRef: "owner/repo#1" },
};

const SCOPES: [string, string, string][] = [
  ["the whole scope", NUL, "\\u0000"],
  ["a NUL before the root", `${NUL}${ROOT}`, `\\u0000${ROOT}`],
  ["two NULs and a backslash", `${ROOT}.a\\${NUL}b${NUL}`, `${ROOT}.a\\\\\\u0000b\\u0000`],
];

function replyText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
}

describe.skipIf(!QA_URL)("MCP write tools refuse a NUL in scopePath with one deny row (QA, real Postgres)", () => {
  let db: PrismaClient;
  let client: Client;
  let closeMcp: () => Promise<void>;
  let memoryService: Server;
  let send: ReturnType<typeof vi.fn>;

  const auditRows = (orgId: string) =>
    db.auditLog.findMany({ where: { orgId }, select: { action: true, target: true, decision: true, reason: true } });
  const stored = async (orgId: string) =>
    (await db.memoryChunk.count({ where: { orgId } })) +
    (await db.workingNote.count({ where: { orgId } })) +
    (await db.factProvenance.count({ where: { orgId } }));

  async function wipe(orgId: string) {
    await db.workingNote.deleteMany({ where: { orgId } });
    await db.factProvenance.deleteMany({ where: { orgId } });
    await db.memoryChunk.deleteMany({ where: { orgId } });
    await db.changeEvent.deleteMany({ where: { orgId } });
    await db.auditLog.deleteMany({ where: { orgId } });
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    memoryService = createServer((req, res) => {
      req.resume();
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ embedding: new Array(384).fill(0.01), facts: [] }));
    });
    await new Promise<void>((resolve) => memoryService.listen(0, "127.0.0.1", resolve));
    const address = memoryService.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    process.env.GRAPHITI_SERVICE_URL = `http://127.0.0.1:${address.port}`;
    process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    const inngestModule = await import("@/lib/inngest");
    send = vi
      .spyOn(inngestModule.inngest, "send")
      .mockImplementation((async () => ({ ids: ["job"] })) as never) as never;
    const { Client: ClientClass } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport: Transport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    closeMcp = mcp.close;

    for (const orgId of [ORG, OTHER]) {
      await wipe(orgId);
      await db.capability.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
      await db.org.create({ data: { id: orgId, name: orgId } });
      await db.scope.create({ data: { orgId, path: `org_${orgId}`, name: `org_${orgId}` } });
    }
    const token = `wcap_test_nulscope_${Math.random().toString(36).slice(2)}`;
    for (const [orgId, hash] of [
      [ORG, hashCapabilityToken(token)],
      [OTHER, hashCapabilityToken(`${token}_other`)],
    ] as const) {
      await db.capability.create({
        data: {
          orgId,
          agentId: "agent-nulscope",
          tokenHash: hash,
          scopePath: `org_${orgId}`,
          permission: "write",
          grantGoverned: false,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    }
    client = new ClientClass({ name: "agent-nulscope", version: "0.0.0" });
    await client.connect(
      new Transport(new URL(mcp.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await closeMcp?.();
    await new Promise((resolve) => memoryService?.close(resolve));
    for (const orgId of [ORG, OTHER]) {
      await wipe(orgId);
      await db.capability.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
    await db.$disconnect();
  });

  beforeEach(async () => {
    send.mockClear();
    await wipe(ORG);
    await wipe(OTHER);
  });

  for (const [tool, args] of Object.entries(WRITES)) {
    it.each(SCOPES)(
      `${tool}: a NUL in %s is refused naming the fix, stores nothing, one deny row in the caller's org`,
      async (_where, scopePath, recorded) => {
        const result = await client.callTool({ name: tool, arguments: { ...args, scopePath } });

        expect(result.isError).toBe(true);
        // memory_ingest's refusal also says how to write without a scopePath (mcp/tools/memory-ingest.ts);
        // the deny row's reason is the refusal alone.
        expect(replyText(result)).toBe(
          tool === "memory_ingest"
            ? `${NUL_REFUSAL} If no one gave you that scope, omit scopePath to write to your own scope, the one your token defaults to.`
            : NUL_REFUSAL,
        );
        expect(send).not.toHaveBeenCalled();
        expect(await stored(ORG)).toBe(0);
        expect(await auditRows(ORG)).toEqual([
          {
            action: "memory.write",
            target: recorded,
            decision: "deny",
            reason: NUL_REFUSAL.replace("Access denied: ", ""),
          },
        ]);
        expect(await auditRows(OTHER)).toEqual([]);
      },
    );

    it(`${tool}: the same call with the caller's own valid scope is not refused (control)`, async () => {
      const result = await client.callTool({ name: tool, arguments: { ...args, scopePath: ROOT } });

      expect(replyText(result)).not.toMatch(/NUL|not a valid scope path/);
      expect((await auditRows(ORG)).some((row) => row.decision === "allow")).toBe(true);
      expect(await auditRows(OTHER)).toEqual([]);
    });
  }
});
