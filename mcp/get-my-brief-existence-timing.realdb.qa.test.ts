// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Existence probes, the MCP half of the timing check. refusal-label.realdb.qa.test.ts proves get_my_brief answers a brief outside the
// token's scope in the same text as an id never issued. This file proves the two also
// take the same time: before both answers ran the same live read probe, the absent id
// skipped one decision and could be timed to find real brief ids, exactly as the HTTP
// routes could (app/api/existence-timing.realdb.test.ts, whose method and bound this
// copies). Only the transport is in memory; the tool, check(), can() and the audit
// writes run against Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";

const QA_URL = process.env.QA_DATABASE_URL;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `org-brief-timing-${RUN}`;
const ROOT = `org_${RUN}`;
/** The scope the token reads. */
const OWN = `${ROOT}.sales`;
/** The scope the hidden brief lives at, which the token cannot read. */
const SECRET = `${ROOT}.secret`;
const AGENT = "agent-brief-timing";
const ABSENT_ID = `brief-never-issued-${RUN}`;

const WARMUP = 20;
const SAMPLES = 150;

/** A tenth of the median call, never under 0.2 ms: the bound the HTTP timing tests use. */
function allowedGapMs(medianCallMs: number): number {
  return Math.max(0.2, medianCallMs / 10);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("get_my_brief takes as long to refuse a hidden brief as an absent id", () => {
  let db: PrismaClient;
  let client: Client;
  let hiddenId: string;

  async function timeCall(briefId: string): Promise<number> {
    const started = performance.now();
    const result = (await client.callTool({ name: "get_my_brief", arguments: { briefId } })) as ToolResult;
    const elapsed = performance.now() - started;
    expect(result.content.map((c) => c.text).join("\n"), briefId).toBe(`Brief ${briefId} not found.`);
    return elapsed;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    await db.org.create({ data: { id: ORG, name: "Brief existence timing" } });
    hiddenId = (
      await db.brief.create({
        data: { orgId: ORG, type: "handoff", scopePath: SECRET, title: "Hidden", summary: "s", sections: [] },
      })
    ).id;

    const token = `wcap_qa_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath: OWN,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const { registerWillderTools } = await import("./tools");
    const server = new McpServer({ name: "qa", version: "0.0.0" });
    registerWillderTools(
      server,
      { orgId: ORG, actor: { type: "agent", id: AGENT, capabilityToken: token }, origin: "mcp" },
      { orgId: ORG, agentId: AGENT, scopePath: OWN },
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: "qa-client", version: "0.0.0" });
    await client.connect(clientSide);
  });

  afterAll(async () => {
    await client?.close();
    for (const table of [db.auditLog, db.changeEvent, db.agentCursor, db.capability, db.brief] as unknown as {
      deleteMany: (args: unknown) => Promise<unknown>;
    }[]) {
      await table.deleteMany({ where: { orgId: ORG } });
    }
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  it("the median refusal time does not depend on whether the brief exists", async () => {
    for (let i = 0; i < WARMUP; i++) {
      await timeCall(hiddenId);
      await timeCall(ABSENT_ID);
    }
    const differences: number[] = [];
    const all: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      let hiddenMs: number;
      let absentMs: number;
      if (i % 2) {
        hiddenMs = await timeCall(hiddenId);
        absentMs = await timeCall(ABSENT_ID);
      } else {
        absentMs = await timeCall(ABSENT_ID);
        hiddenMs = await timeCall(hiddenId);
      }
      differences.push(hiddenMs - absentMs);
      all.push(hiddenMs, absentMs);
    }
    const gap = median(differences);
    const bound = allowedGapMs(median(all));
    console.info(
      `get_my_brief: hidden minus absent ${gap.toFixed(2)} ms, median call ${median(all).toFixed(2)} ms, bound ${bound.toFixed(2)} ms`,
    );
    expect(Math.abs(gap), `hidden minus absent, median per pair: ${gap.toFixed(2)} ms`).toBeLessThanOrEqual(bound);
  }, 60_000);
});
