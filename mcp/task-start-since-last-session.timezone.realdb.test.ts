// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The since-your-last-session line on Postgres sessions west and east of UTC. The idle
// comparison, the createdAt >= lastCallAt filter
// and the printed UTC time must not move with the session TimeZone. Module reload per zone as in
// lib/sql-utc-now.realdb.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { SINCE_LAST_SESSION_OPENING } from "./task-start-headings";

const QA_URL = process.env.QA_DATABASE_URL;
const ZONES = ["America/Los_Angeles", "Asia/Tokyo"];

const ORG = "org-qa-since-last-session-tz";
const SALES = "org_1.sales";
const RETURNER = "agent-returner";
const WRITER = "agent-writer";
const MINUTE = 60 * 1000;

function inTimeZone(url: string, zone: string): string {
  const u = new URL(url);
  u.searchParams.set("options", `-c TimeZone=${zone}`);
  return u.toString();
}

describe.skipIf(!QA_URL).each(ZONES)("the since line on a Postgres session in %s", (ZONE) => {
  let db: PrismaClient;
  let toolCallNotice: (typeof import("./change-notices"))["toolCallNotice"];
  let recordChangeEvent: (typeof import("@/services/memory/change-events"))["recordChangeEvent"];
  let token = "";

  const ctxFor = (bearer: string): AccessContext => ({
    orgId: ORG,
    actor: { type: "agent", id: RETURNER, capabilityToken: bearer },
    origin: "mcp",
  });

  async function change(minutesAgo?: number): Promise<void> {
    const { id } = await db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId: ORG,
        scopePath: SALES,
        recordType: "fact",
        recordId: `rec-${Math.random().toString(36).slice(2)}`,
        op: "create",
        actorId: WRITER,
        actorType: "agent",
        origin: "mcp",
        title: "a change",
      }),
    );
    if (minutesAgo !== undefined)
      await db.changeEvent.update({ where: { id }, data: { createdAt: new Date(Date.now() - minutesAgo * MINUTE) } });
  }

  async function earlierSession(minutesAgo: number): Promise<Date> {
    const lastCallAt = new Date(Date.now() - minutesAgo * MINUTE);
    await db.taskStartDelivery.create({
      data: {
        orgId: ORG,
        agentId: RETURNER,
        sessionKey: `mcp:earlier-${Math.random()}`,
        scopePath: SALES,
        taskKey: "",
        revision: "earlier",
        deliveredAt: lastCallAt,
        lastCallAt,
      },
    });
    return lastCallAt;
  }

  const firstCall = (session = "mcp:now") =>
    toolCallNotice(ctxFor(token), SALES, { taskStart: { sessionKey: session, taskText: "" } });
  const sinceLineOf = (text: string | null) =>
    (text ?? "").split("\n").find((line) => line.startsWith(SINCE_LAST_SESSION_OPENING));

  beforeAll(async () => {
    const url = inTimeZone(QA_URL!, ZONE);
    process.env.DATABASE_URL = url;
    const cached = globalThis as unknown as { prisma?: PrismaClient };
    await cached.prisma?.$disconnect();
    cached.prisma = undefined;
    vi.resetModules();
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    ({ toolCallNotice } = await import("./change-notices"));
    ({ recordChangeEvent } = await import("@/services/memory/change-events"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    for (const m of [
      db.taskStartItemUse,
      db.taskStartServedItem,
      db.taskStartDelivery,
      db.auditLog,
      db.changeEvent,
      db.agentCursor,
      db.capability,
    ]) {
      await (m as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: RETURNER,
        tokenHash: hashCapabilityToken(raw),
        scopePath: SALES,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * MINUTE),
      },
    });
    token = raw;
  });

  it("a return two hours later is told the change, with the last call printed in UTC", async () => {
    const lastCallAt = await earlierSession(120);
    await change(30);
    const line = sinceLineOf(await firstCall());
    expect(line).toBe(
      `${SINCE_LAST_SESSION_OPENING} (last call ${lastCallAt.toISOString().slice(0, 16).replace("T", " ")} UTC): 1 change by 1 other writer in your scope.`,
    );
  });

  it("a reconnect five minutes later is not a return", async () => {
    await earlierSession(5);
    await change(1);
    expect(sinceLineOf(await firstCall())).toBeUndefined();
  });

  it("a change from before the last call is not counted", async () => {
    await earlierSession(60);
    await change(90);
    expect(sinceLineOf(await firstCall())).toBeUndefined();
  });

  it("a change written now through the real writer (no backdating) is counted on a return", async () => {
    await earlierSession(120);
    await change();
    expect(sinceLineOf(await firstCall())).toContain(": 1 change by 1 other writer in your scope.");
  });

  it("the session's own claim ends the return: its next call, with a new change, gets no line", async () => {
    await earlierSession(120);
    await change(30);
    expect(sinceLineOf(await firstCall())).toBeDefined();
    await change();
    expect(sinceLineOf(await firstCall("mcp:second-session"))).toBeUndefined();
  });
});
