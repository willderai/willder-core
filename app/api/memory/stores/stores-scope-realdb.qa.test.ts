// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/memory/stores, real-Postgres QA.
//
// The mocked companion (stores-route.test.ts) asserts the `where` objects the
// handler builds. It cannot tell what Postgres does with them, and the
// containment filter here is a Prisma `startsWith`, which compiles to LIKE:
// whether `_` in a scope path acts as a wildcard is decided by the database,
// not by the object shape. This file drives the real handler through the real
// check() against a real Postgres 16 with ltree and asserts on counts and rows.
//
// Fixture: one member granted read on `org_stq1.dept_sales` only, plus a
// sibling scope `org_stq1.deptXsales` (and its child `.eu`) that differs from it
// at an `_` position,
// an unrelated sibling, untagged chunks, contacts, and a second org holding
// byte-identical scope paths.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's
// inherited DATABASE_URL. Skips cleanly without it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { StoresOverview } from "@/types/memory";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "stq1";
const OTHER_ORG = "stq2";
const ROOT = "org_stq1";
const SALES = `${ROOT}.dept_sales`;
const SALES_EU = `${SALES}.eu`;
// Differs from SALES only where SALES has `_`: a LIKE wildcard if unescaped.
const IMPOSTOR = `${ROOT}.deptXsales`;
// A descendant of the impostor: what `dept_sales.%` would match unescaped.
const IMPOSTOR_CHILD = `${IMPOSTOR}.eu`;
const OPS = `${ROOT}.ops`;
const ADMIN = "u-stores-admin";
const MEMBER = "u-stores-member";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("GET /api/memory/stores: scope filter, real Postgres", { timeout: 30_000 }, () => {
  // Explicit bounds sized for a loaded CI runner, not Vitest's 10 s hook and 5 s test
  // defaults: importing the route and database modules alone can take several seconds
  // when every core is busy, and a timeout there fails the suite without testing anything.
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  const as = async (userId: string, role: "admin" | "member") =>
    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: await db.user.findUnique({ where: { id: userId } }),
      ctx: { orgId: ORG, actor: { type: "human", id: userId, role } },
    });
  const read = async (scope?: string) => {
    const res = await GET(
      new Request(`http://t/api/memory/stores${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
    );
    return { status: res.status, body: (await res.json()) as StoresOverview };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    const orgs = [ORG, OTHER_ORG];
    await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER] } } });
    await db.memoryChunk.deleteMany({ where: { orgId: { in: orgs } } });
    await db.source.deleteMany({ where: { orgId: { in: orgs } } });
    await db.brief.deleteMany({ where: { orgId: { in: orgs } } });
    await db.contact.deleteMany({ where: { orgId: { in: orgs } } });
    await db.convention.deleteMany({ where: { orgId: { in: orgs } } });
    await db.workingNote.deleteMany({ where: { orgId: { in: orgs } } });
    await db.grant.deleteMany({ where: { orgId: { in: orgs } } });
    await db.scope.deleteMany({ where: { orgId: { in: orgs } } });
    await db.user.deleteMany({ where: { orgId: { in: orgs } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: orgs } } });

    for (const id of orgs) await db.org.create({ data: { id, name: `QA stores ${id}` } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@stq.test", role: "admin", clerkId: "clerk-stq-a" },
    });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: "m@stq.test", role: "member", clerkId: "clerk-stq-m" },
    });

    const scopes: Record<string, string> = {};
    for (const path of [ROOT, SALES, SALES_EU, IMPOSTOR, IMPOSTOR_CHILD, OPS]) {
      scopes[path] = (await db.scope.create({ data: { orgId: ORG, path, name: path } })).id;
    }
    await db.grant.create({
      data: { orgId: ORG, scopeId: scopes[ROOT], granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scopes[SALES], granteeType: "user", granteeId: MEMBER, permission: "read" },
    });

    // One chunk, brief, rule, working note and source per scope in each org; the other org reuses
    // the same paths so only the orgId predicate keeps them apart.
    for (const orgId of orgs) {
      for (const path of [SALES, SALES_EU, IMPOSTOR, IMPOSTOR_CHILD, OPS]) {
        await db.memoryChunk.create({ data: { orgId, content: `chunk ${orgId} ${path}`, scopePath: path } });
        await db.brief.create({
          data: {
            orgId,
            type: "handoff",
            scopePath: path,
            title: `brief ${orgId} ${path}`,
            summary: "s",
            sections: [],
          },
        });
        await db.convention.create({
          data: {
            orgId,
            scopePath: path,
            kind: "convention",
            subject: `rule ${orgId} ${path}`,
            text: "t",
            actorId: ADMIN,
          },
        });
        await db.workingNote.create({
          data: {
            orgId,
            scopePath: path,
            agentId: "agent-stq",
            task: `note ${orgId} ${path}`,
            kind: "status",
            body: "b",
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
        const source = await db.source.create({
          data: {
            orgId,
            type: "website",
            externalId: `${orgId}-${path}`,
            name: `source ${orgId} ${path}`,
            scopePath: path,
          },
        });
        await db.sourceFile.create({
          data: { sourceId: source.id, externalFileId: `file ${orgId} ${path}`, checksum: "c", chunkIds: ["x"] },
        });
      }
      await db.memoryChunk.create({ data: { orgId, content: `untagged ${orgId}`, scopePath: null } });
      await db.contact.create({ data: { orgId, name: `contact ${orgId}` } });
    }
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  const subScopeRead = async () => {
    await as(MEMBER, "member");
    const { status, body } = await read(SALES);
    expect(status).toBe(200);
    const seen = [
      ...body.chunks.map((c) => c.snippet),
      ...body.records.map((r) => r.title),
      ...body.briefs.map((b) => b.title),
      ...body.rules.map((r) => r.subject),
      ...body.notes.map((n) => n.task),
      ...body.files.map((f) => f.externalFileId),
    ];
    return { body, seen };
  };

  it("sub-scope read returns the scope and its descendants, and no sibling, untagged chunk, contact or other org", async () => {
    const { seen } = await subScopeRead();
    for (const path of [SALES, SALES_EU]) {
      expect(seen).toContain(`chunk ${ORG} ${path}`);
      expect(seen).toContain(`brief ${ORG} ${path}`);
      expect(seen).toContain(`rule ${ORG} ${path}`);
      expect(seen).toContain(`note ${ORG} ${path}`);
      expect(seen).toContain(`source ${ORG} ${path}`);
      expect(seen).toContain(`file ${ORG} ${path}`);
    }
    expect(seen.filter((s) => s.includes(OPS))).toEqual([]);
    expect(seen.filter((s) => s.includes(OTHER_ORG))).toEqual([]);
    expect(seen.filter((s) => s.startsWith("untagged") || s.startsWith("contact"))).toEqual([]);
  });

  it("sub-scope read treats `_` in the scope path literally: nothing from a sibling that differs only at an `_`, and exact counts", async () => {
    const { body, seen } = await subScopeRead();
    expect(seen.filter((s) => s.includes(IMPOSTOR))).toEqual([]);
    expect(body.counts).toEqual({ records: 2, briefs: 2, rules: 2, notes: 2, chunks: 2, files: 2 });
  });

  it("a member granted only the sub-scope is denied the org root and a sibling, with no counts in the body", async () => {
    await as(MEMBER, "member");
    for (const scope of [undefined, OPS, IMPOSTOR]) {
      const { status, body } = await read(scope);
      expect(status).toBe(403);
      expect(body).not.toHaveProperty("counts");
    }
  });

  it("the org root counts every scope in the org plus untagged chunks and contacts, never the other org", async () => {
    await as(ADMIN, "admin");
    const { status, body } = await read();
    expect(status).toBe(200);
    // 5 sources + 1 contact; 5 briefs, rules and notes; 5 tagged chunks + 1 untagged; 5 files.
    expect(body.counts).toEqual({ records: 6, briefs: 5, rules: 5, notes: 5, chunks: 6, files: 5 });
    expect(body.chunks.some((c) => c.snippet === `untagged ${ORG}`)).toBe(true);
    expect(body.records.some((r) => r.title === `contact ${ORG}`)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(OTHER_ORG);
  });
});
