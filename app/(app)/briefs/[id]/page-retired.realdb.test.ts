// A retired brief must not render on the /briefs/:id page.
//
// brief-retirement.ts withdraws a brief once a source it could have drawn from
// is moved out of its scope or disconnected; every brief read adds NOT_RETIRED
// so a retired id answers like one never issued. This page is the read surface
// a member actually opens, so it gets its own test: removing NOT_RETIRED from
// page.tsx turns the "retired" case red.
//
// Real Postgres 16 with ltree; authentication is faked. Set QA_DATABASE_URL to
// an isolated test database; the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-brief-page-retired";
const SCOPE = "org_bpr.sales";
const READER = "u-bpr-reader";
const BRIEF_ID = "bpr-brief";
const SECRET = "Renewal floor is $160k";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

describe.skipIf(!QA_URL)("/briefs/:id page: a retired brief", () => {
  let db: PrismaClient;
  let BriefPage: (typeof import("./page"))["default"];

  const renderBrief = () => BriefPage({ params: Promise.resolve({ id: BRIEF_ID }) });

  async function clear() {
    for (const table of ["brief", "grant", "scope", "user"] as const) {
      await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await db.org.deleteMany({ where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ default: BriefPage } = await import("./page"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: READER },
      ctx: { orgId: ORG, actor: { type: "human", id: READER, role: "member" } },
    } as never);
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const scope = await db.scope.create({ data: { orgId: ORG, path: SCOPE, name: "sales" } });
    await db.user.create({
      data: { id: READER, orgId: ORG, email: `${READER}@qa.test`, role: "member", clerkId: `clerk-${READER}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: scope.id, granteeType: "user", granteeId: READER, permission: "read" },
    });
    await db.brief.create({
      data: {
        id: BRIEF_ID,
        orgId: ORG,
        type: "handoff",
        scopePath: SCOPE,
        title: "Acme handoff",
        summary: SECRET,
        sections: [],
      },
    });
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("renders the brief to a granted reader while it is not retired", async () => {
    const rendered = (await renderBrief()) as { props: { brief: { summary: string } } };
    expect(rendered.props.brief.summary).toBe(SECRET);
  });

  it("answers not found for the same reader once the brief is retired", async () => {
    await db.briefRetirement.create({ data: { briefId: BRIEF_ID, sourceId: "src-moved", reason: "source_moved" } });
    await expect(renderBrief()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
