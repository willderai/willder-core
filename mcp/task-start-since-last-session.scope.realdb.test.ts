// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The since-your-last-session line against scope and tenant edges beyond the main suite
// (mcp/task-start-since-last-session.realdb.test.ts): a parent scope, a descendant token, another
// tenant's cursor, and the cap boundary.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { SINCE_LAST_SESSION_OPENING } from "./task-start-headings";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-since-last-session-scope";
const OTHER_ORG = "org-qa-since-scope-other";
const SALES = "org_1.sales";
const SALES_EMEA = "org_1.sales.emea";
const RETURNER = "agent-returner";
const WRITER = "agent-writer";
const MINUTE = 60 * 1000;

describe.skipIf(!QA_URL)("the since line's scope and tenant edges", () => {
  let db: PrismaClient;
  let toolCallNotice: (typeof import("./change-notices"))["toolCallNotice"];
  let recordChangeEvent: (typeof import("@/services/memory/change-events"))["recordChangeEvent"];

  async function mint(orgId: string, scopePath: string): Promise<string> {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId: RETURNER,
        tokenHash: hashCapabilityToken(raw),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      },
    });
    return raw;
  }

  const ctxFor = (bearer: string, orgId = ORG): AccessContext => ({
    orgId,
    actor: { type: "agent", id: RETURNER, capabilityToken: bearer },
    origin: "mcp",
  });

  async function change(opts: { scopePath?: string; orgId?: string; minutesAgo?: number } = {}): Promise<bigint> {
    const { id, seq } = await db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId: opts.orgId ?? ORG,
        scopePath: opts.scopePath ?? SALES,
        recordType: "fact",
        recordId: `rec-${Math.random().toString(36).slice(2)}`,
        op: "create",
        actorId: WRITER,
        actorType: "agent",
        origin: "mcp",
        title: "a change",
      }),
    );
    await db.changeEvent.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - (opts.minutesAgo ?? 30) * MINUTE) },
    });
    return seq;
  }

  async function earlierSession(minutesAgo: number, orgId = ORG): Promise<void> {
    const lastCallAt = new Date(Date.now() - minutesAgo * MINUTE);
    await db.taskStartDelivery.create({
      data: {
        orgId,
        agentId: RETURNER,
        sessionKey: `mcp:earlier-${Math.random()}`,
        scopePath: SALES,
        taskKey: "",
        revision: "earlier",
        deliveredAt: lastCallAt,
        lastCallAt,
      },
    });
  }

  const firstCall = (bearer: string, scopePath: string, orgId = ORG) =>
    toolCallNotice(ctxFor(bearer, orgId), scopePath, { taskStart: { sessionKey: "mcp:now", taskText: "" } });
  const sinceLineOf = (text: string | null) =>
    (text ?? "").split("\n").find((line) => line.startsWith(SINCE_LAST_SESSION_OPENING));

  async function clean(orgId: string): Promise<void> {
    await db.taskStartItemUse.deleteMany({ where: { orgId } });
    await db.taskStartServedItem.deleteMany({ where: { orgId } });
    await db.taskStartDelivery.deleteMany({ where: { orgId } });
    await db.auditLog.deleteMany({ where: { orgId } });
    await db.changeEvent.deleteMany({ where: { orgId } });
    await db.agentCursor.deleteMany({ where: { orgId } });
    await db.capability.deleteMany({ where: { orgId } });
    await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ toolCallNotice } = await import("./change-notices"));
    ({ recordChangeEvent } = await import("@/services/memory/change-events"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await clean(ORG);
    await clean(OTHER_ORG);
  });

  it("a token on a descendant scope counts nothing written in its parent", async () => {
    const token = await mint(ORG, SALES_EMEA);
    await earlierSession(120);
    await change({ scopePath: SALES });
    await change({ scopePath: "org_1" });
    expect(await firstCall(token, SALES_EMEA)).toBeNull();
  });

  it("another tenant's cursor, far ahead under the same agent id, hides nothing here", async () => {
    const token = await mint(ORG, SALES);
    await earlierSession(120);
    await change();
    await db.agentCursor.create({ data: { orgId: OTHER_ORG, agentId: RETURNER, lastSeq: BigInt(1_000_000) } });
    expect(sinceLineOf(await firstCall(token, SALES))).toContain(": 1 change by 1 other writer in your scope.");
  });

  it("at 999 changes it still counts the writers; at 1000 it says 1000 or more", async () => {
    const token = await mint(ORG, SALES);
    await earlierSession(120);
    const createdAt = new Date(Date.now() - 30 * MINUTE);
    const rows = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({
        orgId: ORG,
        seq: BigInt(from + i),
        scopePath: SALES,
        recordType: "fact",
        recordId: `bulk-${from + i}`,
        op: "create" as const,
        actorId: `${WRITER}-${i % 3}`,
        summary: "bulk",
        createdAt,
      }));
    await db.changeEvent.createMany({ data: rows(999, 1) });
    expect(sinceLineOf(await firstCall(token, SALES))).toContain(": 999 changes by 3 other writers in your scope.");

    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await earlierSession(120);
    await db.changeEvent.createMany({ data: rows(1, 1000) });
    expect(sinceLineOf(await firstCall(token, SALES))).toContain(": 1000 or more changes by others in your scope.");
  });
});
