// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The task-start block's tenant and concurrency guarantees, against a real database.
//
// task-start-notice.realdb.test.ts covers rule and recent-write containment. This file
// covers what it leaves out, against Postgres 16 with ltree:
//
// - the stale-flag read (`fact_provenance`) never serves another tenant's flag or one
//   from a sibling or unrelated scope, and does serve a descendant scope's flag;
// - two writers superseding the same rule at once: exactly one wins (the unique index,
//   not the lookup, is what decides this race), the loser's version is stored and
//   readable, and it is never served as a rule in force;
// - a retired rule stops being served without being replaced by anything;
// - a read-only token recording a rule through memory_ingest is refused, writes no
//   rule, and leaves exactly one audited deny;
// - two concurrent first calls of one session deliver once and audit that delivery
//   no more than once per caller that reached the check.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL.
// Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel, which builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-276";
const OTHER_ORG = "org-qa-276-other";
const SALES = "org_1.sales";
const SALES_SIBLING = "org_1.sales_eu";
const ENGINEERING = "org_1.engineering";

/** The Postgres application_name on every connection the code under test opens. */
const WRITER_APPLICATION = "task-start-notice-qa";

const AUTHOR = "agent-qa-author";
const RIVAL = "agent-qa-rival";
const WORKER = "agent-qa-worker";

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

describe.skipIf(!QA_URL)("task-start block against a real database", () => {
  let db: PrismaClient;
  let registerWillderTools: (typeof import("./tools"))["registerWillderTools"];
  let recordConvention: (typeof import("@/services/memory/conventions"))["recordConvention"];
  let retireConvention: (typeof import("@/services/memory/conventions"))["retireConvention"];
  const openClients: Client[] = [];

  async function mintCapability(
    agentId: string,
    scopePath: string,
    permission: "read" | "write" = "read",
    orgId = ORG,
  ): Promise<string> {
    const token = `wcap_qa_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return token;
  }

  const ctxFor = (agentId: string, token: string, orgId = ORG): AccessContext => ({
    orgId,
    actor: { type: "agent", id: agentId, capabilityToken: token },
    origin: "mcp",
  });

  async function connectAs(agentId: string, token: string, scopePath: string): Promise<Client> {
    const server = new McpServer({ name: "willder-qa", version: "0.0.0" });
    registerWillderTools(server, ctxFor(agentId, token), { orgId: ORG, agentId, scopePath });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "qa-client", version: "0.0.0" });
    await client.connect(clientTransport);
    openClients.push(client);
    return client;
  }

  async function firstCall(client: Client, session: string): Promise<ToolResult> {
    return (await client.callTool({
      name: "get_my_brief",
      arguments: { briefId: "no-such-brief" },
      _meta: { "willder/session": session },
    })) as ToolResult;
  }

  const blockOf = (result: ToolResult): string | undefined =>
    result.content
      .map((c) => c.text)
      .find((text) => text.startsWith("Before you start"))
      ?.split("\n\nChanged in your scope")[0];

  async function staleFlag(orgId: string, scopePath: string, uuid: string): Promise<void> {
    await db.factProvenance.create({
      data: {
        orgId,
        scopePath,
        graphitiFactUuid: uuid,
        sourceType: "file",
        sourceRef: `src/${uuid}.ts`,
        ownerId: AUTHOR,
        status: "potentially_stale",
        flaggedAt: new Date(),
      },
    });
  }

  /**
   * Wait until `count` of this file's writers are blocked waiting to insert into
   * `conventions`. Other suites write rules to the same QA database at the same time,
   * so a session is counted only when it carries WRITER_APPLICATION: one of theirs
   * queued on the lock would otherwise release it before both of ours had arrived.
   */
  async function waitForQueuedInserts(count: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const [{ waiting }] = await db.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS "waiting"
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.relation = '"conventions"'::regclass
          AND l.mode = 'RowExclusiveLock'
          AND NOT l.granted
          AND a.application_name = ${WRITER_APPLICATION}`;
      if (waiting >= count) return;
      if (Date.now() > deadline) throw new Error(`only ${waiting} of ${count} inserts queued on conventions`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  beforeAll(async () => {
    // The code under test connects through DATABASE_URL; naming those connections lets
    // waitForQueuedInserts tell this file's writers apart from every other suite's.
    const writerUrl = new URL(QA_URL!);
    writerUrl.searchParams.set("application_name", WRITER_APPLICATION);
    process.env.DATABASE_URL = writerUrl.toString();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ registerWillderTools } = await import("./tools"));
    ({ recordConvention, retireConvention } = await import("@/services/memory/conventions"));
  });

  afterAll(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    await db.$disconnect();
  });

  beforeEach(async () => {
    await Promise.all(openClients.splice(0).map((client) => client.close()));
    // Unlink first: a failed cross-tenant case can leave one org's rule superseding
    // the other's, which would block either org's delete.
    await db.convention.updateMany({ where: { orgId: { in: [ORG, OTHER_ORG] } }, data: { supersedesId: null } });
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.factProvenance.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.factEdge.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
  });

  it("serves stale flags from the caller's scope and below, never a sibling, another scope or another org", async () => {
    await staleFlag(ORG, SALES, "fact-own");
    await staleFlag(ORG, `${SALES}.eu`, "fact-descendant");
    await staleFlag(ORG, SALES_SIBLING, "fact-sibling");
    await staleFlag(ORG, ENGINEERING, "fact-engineering");
    await staleFlag(OTHER_ORG, SALES, "fact-other-tenant");
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);

    const block = blockOf(await firstCall(worker, "run-1"));

    expect(block).toContain("Related to this task:");
    expect(block).toContain("fact-own");
    expect(block).toContain("fact-descendant");
    expect(block).not.toContain("fact-sibling");
    expect(block).not.toContain("fact-engineering");
    expect(block).not.toContain("fact-other-tenant");
  });

  it("lets exactly one of two concurrent supersedes of the same rule win", async () => {
    const authorToken = await mintCapability(AUTHOR, SALES, "write");
    const rivalToken = await mintCapability(RIVAL, SALES, "write");
    const old = await recordConvention(ctxFor(AUTHOR, authorToken), {
      kind: "convention",
      subject: "Account dedupe",
      text: "By company name.",
      scopePath: SALES,
    });

    // The race under test needs both writers to find the old rule replaceable before
    // either commits. Left to the scheduler, one writer sometimes commits first and the
    // other is refused at its lookup instead, which is the sequential case, not this one.
    // A SHARE lock on the table lets both lookups read but holds both inserts until each
    // writer is queued behind it; committing it sends both inserts at the unique index
    // together. The pending writes are wrapped so the lock commits without awaiting them.
    const { writes } = await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE "conventions" IN SHARE MODE`;
        const writes = Promise.allSettled(
          [
            [AUTHOR, authorToken, "By domain."],
            [RIVAL, rivalToken, "By phone."],
          ].map(([agent, token, text]) =>
            recordConvention(ctxFor(agent!, token!), {
              kind: "convention",
              subject: "Account dedupe",
              text: text!,
              scopePath: SALES,
              supersedes: old,
            }),
          ),
        );
        await waitForQueuedInserts(2);
        return { writes };
      },
      { timeout: 30_000 },
    );
    const outcomes = await writes;

    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ name: "ConventionNotReplaceableError" });
    expect(await db.convention.count({ where: { orgId: ORG, supersedesId: old } })).toBe(1);

    // The loser's version is stored rather than rolled back, so the refusal it was given
    // names a version a reader can open. It carries the winner's id, and its own
    // `supersedesId` stayed null: the unique index, not the lookup, is what refused it.
    const refusal = lost[0]!.reason as { storedVersionId?: string; supersededById?: string };
    const winnerId = (won[0] as PromiseFulfilledResult<string>).value;
    expect(refusal.supersededById).toBe(winnerId);
    expect(await db.convention.findUnique({ where: { id: refusal.storedVersionId! } })).toMatchObject({
      supersedesId: null,
      supersededById: winnerId,
    });

    // Four events, not three: one create for the original, one create and one supersede
    // for the winner, and one supersede on the stored loser. That last one is attributed
    // to the winner's writer, because an agent's own writes are filtered out of its change
    // notices and the losing writer is the one reader who needs to hear it.
    expect(await db.changeEvent.count({ where: { orgId: ORG, recordType: "convention" } })).toBe(4);

    // The point of storing the loser: it must never be served as a rule in force. Nothing
    // supersedes it -- its `supersedesId` is null -- so only `supersededById` keeps it out,
    // and without that the scope would serve two contradictory rules for one subject.
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);
    const block = blockOf(await firstCall(worker, "run-1"));
    expect(block).toContain(winnerId);
    expect(block).not.toContain(refusal.storedVersionId!);
    expect(block).not.toContain(old);
  });

  it("stops serving a retired rule, and still serves the rest of the scope", async () => {
    const author = await mintCapability(AUTHOR, SALES, "write");
    const retired = await recordConvention(ctxFor(AUTHOR, author), {
      kind: "convention",
      subject: "Account dedupe",
      text: "By company name.",
      scopePath: SALES,
    });
    const kept = await recordConvention(ctxFor(AUTHOR, author), {
      kind: "convention",
      subject: "Refund window",
      text: "Thirty days.",
      scopePath: SALES,
    });

    expect(await retireConvention(ctxFor(AUTHOR, author), retired)).toBe(true);

    // A retired rule leaves service without a successor, so no row supersedes it and
    // `retiredAt` is the only thing that can drop it from the block.
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);
    const block = blockOf(await firstCall(worker, "run-1"));
    expect(block).toContain(kept);
    expect(block).not.toContain(retired);
  });

  it("never lets another tenant supersede a rule, even with write on the same scope string", async () => {
    const own = await recordConvention(ctxFor(AUTHOR, await mintCapability(AUTHOR, SALES, "write")), {
      kind: "convention",
      subject: "Account dedupe",
      text: "By domain.",
      scopePath: SALES,
    });
    const foreignWriter = await mintCapability(RIVAL, SALES, "write", OTHER_ORG);

    await expect(
      recordConvention(ctxFor(RIVAL, foreignWriter, OTHER_ORG), {
        kind: "convention",
        subject: "Account dedupe",
        text: "Hijacked.",
        scopePath: SALES,
        supersedes: own,
      }),
    ).rejects.toMatchObject({ name: "ConventionNotReplaceableError" });

    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);
    expect(blockOf(await firstCall(worker, "run-1"))).toContain(own);
  });

  it("refuses a rule from a read-only token, writes nothing and audits one deny", async () => {
    const reader = await connectAs(WORKER, await mintCapability(WORKER, SALES, "read"), SALES);
    await reader.callTool({
      name: "get_my_brief",
      arguments: { briefId: "warm-up" },
      _meta: { "willder/session": "s" },
    });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });

    const refused = (await reader.callTool({
      name: "memory_ingest",
      arguments: { name: "Refund policy", content: "Anything goes.", kind: "decision" },
      _meta: { "willder/session": "s" },
    })) as ToolResult;

    expect(refused.isError).toBe(true);
    expect(await db.convention.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.changeEvent.count({ where: { orgId: ORG } })).toBe(0);
    const writes = await db.auditLog.findMany({ where: { orgId: ORG, action: "memory.write" } });
    expect(writes.map((w) => w.decision)).toEqual(["deny"]);
  });

  it("delivers once to racing first calls and audits at most one read per racer", async () => {
    const author = await mintCapability(AUTHOR, SALES, "write");
    await recordConvention(ctxFor(AUTHOR, author), {
      kind: "convention",
      subject: "Account dedupe",
      text: "By domain.",
      scopePath: SALES,
    });
    const worker = await connectAs(WORKER, await mintCapability(WORKER, SALES), SALES);
    // Feed caught up, so change notices add no audited reads of their own.
    const latest = await db.changeEvent.aggregate({ where: { orgId: ORG }, _max: { seq: true } });
    await db.agentCursor.create({ data: { orgId: ORG, agentId: WORKER, lastSeq: latest._max.seq ?? BigInt(0) } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });

    const racers = 5;
    const results = await Promise.all(Array.from({ length: racers }, () => firstCall(worker, "racing")));

    expect(results.filter((r) => blockOf(r) !== undefined)).toHaveLength(1);
    const reads = await db.auditLog.count({ where: { orgId: ORG, action: "memory.read" } });
    // get_my_brief audits its own miss on every call; the block adds between one
    // (no racer reached check() before another claimed) and one per racer.
    expect(reads).toBeGreaterThanOrEqual(racers + 1);
    expect(reads).toBeLessThanOrEqual(racers * 2);
  });
});
