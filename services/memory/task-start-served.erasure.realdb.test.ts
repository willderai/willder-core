// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The served-vs-used log under person erasure (services/memory/task-start-served.ts): when a
// person is erased, every served and used row about a fact version the erasure removed goes,
// in that org only, and the rows about everything else stay. A row is also never written for
// a version that is gone by the time the block is claimed.
//
// Real: Postgres, erasePerson with its suppression list, chunk removal and summary blanking,
// the task-start block and its delivery claim, and the use recorder. Stood in: the graph store,
// whose erasure is proven against Neo4j in memory-service/tests; here it erases nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
    removeEpisode: async () => ({ removed: true }),
  },
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_served_erasure";
const OTHER_ORG = "qa_served_erasure_other";
const ROOT = `org_${ORG}`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const ADMIN = "qa_served_erasure_admin";
const AGENT = "served-erasure-agent";
const TASK = "SUP-9";
const NAME = "Orla Vennick";
const SESSION = "s-erasure";

describe.skipIf(!QA_URL)("the served-vs-used log under person erasure", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let taskStartNotice: (typeof import("@/mcp/task-start-notice"))["taskStartNotice"];
  let recordItemUses: (typeof import("./task-start-served"))["recordItemUses"];
  let claimTaskStartDelivery: (typeof import("./task-start"))["claimTaskStartDelivery"];
  const tokens: Record<string, string> = {};
  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const agent = (orgId: string): AccessContext => ({
    orgId,
    actor: { type: "agent", id: AGENT, capabilityToken: tokens[orgId]! },
    origin: "mcp",
  });

  async function wipe(): Promise<void> {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.taskStartItemUse.deleteMany({ where: { orgId } });
      await db.taskStartServedItem.deleteMany({ where: { orgId } });
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.contact.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
  }

  let seq = 0;
  /** A fact version this task wrote: its chunk and its create event. */
  async function taskFact(orgId: string, scopePath: string, id: string, content: string): Promise<void> {
    await db.memoryChunk.create({
      data: { id, orgId, scopePath, entityName: id, content, actorId: "writer", actorType: "agent" },
    });
    await db.changeEvent.create({
      data: {
        id: randomUUID(),
        orgId,
        seq: BigInt(++seq),
        scopePath,
        recordType: "fact",
        recordId: id,
        op: "create",
        actorId: "writer",
        summary: id,
        task: TASK,
      },
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ taskStartNotice } = await import("@/mcp/task-start-notice"));
    ({ recordItemUses } = await import("./task-start-served"));
    ({ claimTaskStartDelivery } = await import("./task-start"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await wipe();
    for (const [orgId, root] of [
      [ORG, ROOT],
      [OTHER_ORG, OTHER_ROOT],
    ] as const) {
      await db.org.create({ data: { id: orgId, name: orgId } });
      await db.scope.create({ data: { orgId, path: root, name: root } });
      await db.contact.create({ data: { id: `${orgId}-orla`, orgId, name: NAME, email: `orla@${orgId}.example` } });
      tokens[orgId] = `wcap_test_${orgId}_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId,
          agentId: AGENT,
          tokenHash: hashCapabilityToken(tokens[orgId]!),
          scopePath: root,
          permission: "read",
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    }
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ROOT } });
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@served-erasure.test",
        role: "admin",
        clerkId: "clerk-served-erasure-admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    await db.convention.create({
      data: {
        id: "qaseraserule1",
        orgId: ORG,
        scopePath: ROOT,
        kind: "convention",
        subject: "Refund desk",
        text: "Refunds over 500 need a second approver.",
        actorId: "author",
      },
    });
    await taskFact(ORG, ROOT, "qaserasefactnamed", `${NAME} asked for the refund twice.`);
    await taskFact(ORG, ROOT, "qaserasefactbystander", "The refund desk closes at five.");
    await taskFact(OTHER_ORG, OTHER_ROOT, "qaserasefactother", `${NAME} is a customer here too.`);
  });

  /** Serves `orgId`'s block to SESSION, then has a later call of the session name `ids`. */
  async function serveAndUse(orgId: string, ids: string[]): Promise<void> {
    expect(
      await taskStartNotice(agent(orgId), {
        scopePath: orgId === ORG ? ROOT : OTHER_ROOT,
        sessionKey: SESSION,
        taskText: TASK,
        taskKey: TASK,
      }),
    ).toContain("Before you start");
    await db.$executeRaw`UPDATE "task_start_served" SET "servedAt" = "servedAt" - interval '1 minute' WHERE "orgId" = ${orgId}`;
    const written = await recordItemUses(
      { orgId, agentId: AGENT, sessionKey: SESSION },
      {
        args: { content: `Following up on ${ids.join(" and ")}.` },
        result: { content: [{ type: "text", text: "Stored." }] },
        startedAt: performance.now(),
      },
    );
    expect(written).toBe(ids.length);
  }

  const named = async (orgId: string, namedId: string) => ({
    served: await db.taskStartServedItem.count({ where: { orgId, namedId } }),
    uses: await db.taskStartItemUse.count({ where: { orgId, namedId } }),
  });

  it("removes every row about a version the erasure removed, in that org only, and keeps the rest", async () => {
    await serveAndUse(ORG, ["qaserasefactnamed", "qaserasefactbystander", "qaseraserule1"]);
    await serveAndUse(OTHER_ORG, ["qaserasefactother"]);
    expect(await named(ORG, "qaserasefactnamed")).toEqual({ served: 1, uses: 1 });

    await erasePerson(admin, { contactId: `${ORG}-orla` });

    expect(await named(ORG, "qaserasefactnamed")).toEqual({ served: 0, uses: 0 });
    expect(await named(ORG, "qaserasefactbystander")).toEqual({ served: 1, uses: 1 });
    expect(await named(ORG, "qaseraserule1")).toEqual({ served: 1, uses: 1 });
    expect(await named(OTHER_ORG, "qaserasefactother")).toEqual({ served: 1, uses: 1 });
  });

  it("removes a row that only named an erased version, as a change line does, without showing it", async () => {
    // A line naming the version as its record, with no version of its own: only the erasure's id list reaches it.
    await db.taskStartServedItem.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        sessionKey: SESSION,
        scopePath: ROOT,
        taskKey: TASK,
        servingId: "serving-1",
        position: 1,
        lineCount: 1,
        itemType: "change",
        itemId: randomUUID(),
        namedId: "qaserasefactnamed",
      },
    });
    await db.taskStartServedItem.create({
      data: {
        orgId: OTHER_ORG,
        agentId: AGENT,
        sessionKey: SESSION,
        scopePath: OTHER_ROOT,
        taskKey: TASK,
        servingId: "serving-2",
        position: 1,
        lineCount: 1,
        itemType: "change",
        itemId: randomUUID(),
        namedId: "qaserasefactnamed",
      },
    });
    await erasePerson(admin, { contactId: `${ORG}-orla` });
    expect((await named(ORG, "qaserasefactnamed")).served).toBe(0);
    expect((await named(OTHER_ORG, "qaserasefactnamed")).served).toBe(1);
  });

  it("logs no line whose fact version is gone by the time the block is claimed, and still claims the rest", async () => {
    const lines = [["convention:qaseraserule1@1"], ["fact:qaserasefactgone@1"], ["fact:qaserasefactbystander@1"]];
    expect(
      await claimTaskStartDelivery(agent(ORG), { sessionKey: "s-gone", scopePath: ROOT, taskKey: TASK }, "rev", lines),
    ).toBe(true);
    const rows = await db.taskStartServedItem.findMany({
      where: { orgId: ORG, sessionKey: "s-gone" },
      orderBy: { position: "asc" },
    });
    expect(rows.map((r) => [r.position, r.namedId, r.versionId])).toEqual([
      [1, "qaseraserule1", null],
      [3, "qaserasefactbystander", "qaserasefactbystander"],
    ]);
  });
});
