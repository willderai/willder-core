// Database-gated QA: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/sources/:id/records across two tenants. An admin of one org asks for a source
// of another org by its id. The answer must match an id never issued: the same 404, no
// count read from any store, and nothing on either org's audit log, since no decision was
// made about a record the caller's org does not hold. A dashed scope and its dotted
// look-alike each count at their own scope, and a graph group no scope names is decided at
// the org root, so a reader of other scopes, but not the root, is refused. The graph is a double that records
// whether it was asked and answers what a case leaves; Postgres, check() and the audit log
// are real.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { seedMember } from "@/services/access/member.testsupport";
import { toGid } from "@/services/memory/graphiti-store";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const graph = vi.hoisted(() => ({
  asked: [] as string[],
  left: [] as { groupId: string; episodes: number }[],
  store: {
    sourceRecords: async ({ sourceId }: { sourceId: string }) => {
      graph.asked.push(sourceId);
      return graph.left.map((l) => ({
        groupId: l.groupId,
        episodes: l.episodes,
        facts: 0,
        factEmbeddings: 0,
        verbatimNodes: 0,
        orphans: 0,
        danglingFacts: 0,
      }));
    },
  },
}));

vi.mock("@/services/memory/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/store")>()),
  graphitiStore: graph.store,
}));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "qarecordsorga";
const ORG_B = "qarecordsorgb";
const ADMIN_A = "user-qa-records-admin-a";
const SOURCE_B = "src-qa-records-org-b";
const SOURCE_A = "src-qa-records-org-a";
const READER_A = "user-qa-records-reader-a";

describe.skipIf(!QA_URL)("GET /api/sources/:id/records across tenants", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let requireAccessContext: (typeof import("@/lib/access-context"))["requireAccessContext"];

  const recordsAsAdminA = (id: string) => recordsAs(ADMIN_A, id);
  const recordsAs = async (userId: string, id: string) => {
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG_A },
      user: { id: userId },
      ctx: { orgId: ORG_A, actor: { type: "human", id: userId, role: "member" } },
    } as never);
    const res = await GET(new Request(`http://test/api/sources/${id}/records`), { params: Promise.resolve({ id }) });
    return { status: res.status, body: await res.json() };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
  });

  afterAll(async () => {
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG_A, ORG_B] } } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    graph.asked.length = 0;
    graph.left.length = 0;
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG_A, ORG_B] } } });
    for (const org of [ORG_A, ORG_B]) {
      await db.org.create({ data: { id: org, name: org } });
      await db.scope.create({ data: { id: `sc-${org}-root`, orgId: org, path: `org_${org}`, name: "root" } });
      await db.scope.create({ data: { id: `sc-${org}-eng`, orgId: org, path: `org_${org}.eng`, name: "eng" } });
    }
    for (const userId of [ADMIN_A, READER_A]) await seedMember(db, { orgId: ORG_A, userId });
    await db.grant.create({
      data: { orgId: ORG_A, scopeId: `sc-${ORG_A}-root`, granteeType: "user", granteeId: ADMIN_A, permission: "admin" },
    });
    // A dashed label and the dotted path it would have collided with before toGid escaped dashes.
    const lookAlikes = [
      ["sc-qa-a-dashed", `org_${ORG_A}.field-ops`],
      ["sc-qa-a-field", `org_${ORG_A}.field`],
      ["sc-qa-a-dotted", `org_${ORG_A}.field.ops`],
    ] as const;
    for (const [id, path] of lookAlikes) await db.scope.create({ data: { id, orgId: ORG_A, path, name: id } });
    for (const scopeId of [`sc-${ORG_A}-eng`, "sc-qa-a-dashed", "sc-qa-a-dotted"]) {
      await db.grant.create({
        data: { orgId: ORG_A, scopeId, granteeType: "user", granteeId: READER_A, permission: "read" },
      });
    }
    await db.source.create({
      data: {
        id: SOURCE_A,
        orgId: ORG_A,
        type: "gdrive",
        externalId: "folder-qa-org-a",
        name: "A Drive",
        scopePath: `org_${ORG_A}.eng`,
      },
    });
    await db.source.create({
      data: {
        id: SOURCE_B,
        orgId: ORG_B,
        type: "gdrive",
        externalId: "folder-qa-org-b",
        name: "B Drive",
        scopePath: `org_${ORG_B}.eng`,
      },
    });
  });

  it("answers another org's source as an id never issued, counts nothing, and records both alike in the caller's org", async () => {
    const otherOrgs = await recordsAsAdminA(SOURCE_B);
    const neverIssued = await recordsAsAdminA("src-qa-records-never-issued");

    expect(otherOrgs).toEqual({ status: 404, body: { error: "source not found" } });
    expect(neverIssued).toEqual(otherOrgs);
    expect(graph.asked).toEqual([]);
    // Both are decided at the caller's own org root, so they cost the same and
    // leave the same row; nothing is written to the other org.
    const rows = await db.auditLog.findMany({
      where: { orgId: { in: [ORG_A, ORG_B] } },
      orderBy: { at: "asc" },
      select: { orgId: true, target: true, decision: true },
    });
    expect(rows).toEqual([
      { orgId: ORG_A, target: `org_${ORG_A}/sources:records:${SOURCE_B}`, decision: "allow" },
      { orgId: ORG_A, target: `org_${ORG_A}/sources:records:src-qa-records-never-issued`, decision: "allow" },
    ]);
  });

  it("counts a dashed scope and its dotted look-alike each at its own scope", async () => {
    graph.left.push(
      { groupId: toGid(`org_${ORG_A}.field-ops`), episodes: 2 },
      { groupId: toGid(`org_${ORG_A}.field.ops`), episodes: 3 },
    );

    const reader = await recordsAs(READER_A, SOURCE_A);

    expect(reader.status).toBe(200);
    expect(reader.body.scopes.map((s: { scopePath: string; episodes: number }) => [s.scopePath, s.episodes])).toEqual([
      [`org_${ORG_A}.eng`, 0],
      [`org_${ORG_A}.field-ops`, 2],
      [`org_${ORG_A}.field.ops`, 3],
    ]);
  });

  it("decides records in a graph group no scope names at the org root", async () => {
    graph.left.push({ groupId: toGid(`org_${ORG_A}.gone`), episodes: 2 });

    const reader = await recordsAs(READER_A, SOURCE_A);
    const admin = await recordsAsAdminA(SOURCE_A);

    expect(reader.status).toBe(403);
    expect(admin.status).toBe(200);
    expect(admin.body.scopes.map((s: { scopePath: string; episodes: number }) => [s.scopePath, s.episodes])).toEqual([
      [`org_${ORG_A}.eng`, 0],
      [`org_${ORG_A}`, 2],
    ]);
  });
});
