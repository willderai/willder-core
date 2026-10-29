// Database-gated (QA_DATABASE_URL). The dependency graph's timestamps on a session whose TimeZone is
// not UTC: instants read back as stored, and a change orders after a brief by instant.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";
import type { AccessContext } from "@/services/access";

const QA_URL = process.env.QA_DATABASE_URL;
/** QA_URL with the session TimeZone set, keeping whatever query it already carries (CI's has `?sslmode=disable`). */
function withLosAngelesSession(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("options", "-c TimeZone=America/Los_Angeles");
  return parsed.toString();
}
const LA_URL = QA_URL ? withLosAngelesSession(QA_URL) : undefined;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ORG = `rttz${RUN}`;
const ROOT = `org_${ORG}`;
const READER = `u-rttz-${RUN}`;
const T = (m: number) => new Date(Date.UTC(2026, 9, 16, 10, m, 0));
const ctx: AccessContext = { orgId: ORG, actor: { type: "human", id: READER, role: "member" }, origin: "app" };

describe.skipIf(!QA_URL)("the dependency graph under a Los Angeles session", () => {
  let db: PrismaClient;
  let deps: typeof import("./dependencies");
  beforeAll(async () => {
    process.env.DATABASE_URL = LA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: LA_URL! }) });
    deps = await import("./dependencies");
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await seedMember(db, { orgId: ORG, userId: READER });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: READER, permission: "read" },
    });
  });
  afterAll(async () => {
    if (!QA_URL) return;
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.user.deleteMany({ where: { id: READER } });
    await db.$disconnect();
  });

  it("returns the instants Prisma stored, and orders a change after the brief by instant", async () => {
    const tz = await db.$queryRaw<{ tz: string }[]>`SELECT current_setting('TimeZone') AS tz`;
    expect(tz[0]!.tz).toBe("America/Los_Angeles");
    await db.brief.create({
      data: {
        id: `b-${RUN}`,
        orgId: ORG,
        type: "handoff",
        scopePath: ROOT,
        title: "t",
        summary: "s",
        sections: [],
        createdAt: T(10),
      },
    });
    await db.briefCitation.create({
      data: { briefId: `b-${RUN}`, factId: "f", sectionIndex: 0, factText: "x", createdAt: T(10) },
    });
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(1),
        scopePath: ROOT,
        recordType: "fact",
        recordId: "f",
        op: "update",
        actorId: "a",
        summary: "s",
        createdAt: T(20),
      },
    });
    // and one written with no explicit createdAt, as product code does; its `from` end is
    // stored in the scope, as every edge's end must be to be read
    await db.memoryChunk.create({
      data: { id: `r-${RUN}`, orgId: ORG, content: "r", scopePath: ROOT, createdAt: T(5), factVersion: true },
    });
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: `r-${RUN}`,
        toId: "f",
        kind: "dependsOn",
        scopePath: ROOT,
        actorType: "agent",
        actorId: "a",
      },
    });
    const before = Date.now();
    const edges = await deps.edgesOf(ctx, "f", ROOT);
    const cites = edges.incoming.find((e) => e.kind === "cites")!;
    expect(cites.createdAt.toISOString()).toBe(T(10).toISOString());
    const dep = edges.incoming.find((e) => e.kind === "dependsOn")!;
    expect(Math.abs(dep.createdAt.getTime() - before)).toBeLessThan(60_000);
    const report = await deps.staleReport(ctx, ROOT);
    expect(report.stale.find((s) => s.recordId === `b-${RUN}`)?.reason).toEqual({
      kind: "changed",
      at: T(20),
      op: "update",
    });
  });
});
