// @vitest-environment jsdom
// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The overview page against a real Postgres, with the shipping pagePermissions()
// probe and can() evaluator; only the Clerk session and fetch are stubbed. The page
// unit test mocks pagePermissions, so it cannot show that the real probe answers
// the same as the route's audited check(), or that probing writes nothing. These do:
// an org-wide writer who cannot manage access renders the suggested path, sends no request and leaves no audit
// row at all; an access manager gets the checklist and exactly one request.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "frp1";
const ROOT = `org_${ORG}`;
const ENG = `${ROOT}.eng`;
const ADMIN = "u-admin-first-run-page";
const MEMBER = "u-member-first-run-page";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("overview page first-run gate, real Postgres", () => {
  let db: PrismaClient;
  let DashboardPage: (typeof import("./page"))["default"];
  let signIn: (who: "admin" | "member") => void;

  async function wipe() {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, MEMBER] } } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  function stubFetch() {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ fact: null, openedFact: false, subScopeToken: null, denied: false }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ default: DashboardPage } = await import("./page"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    const org = await db.org.create({ data: { id: ORG, name: "First run page QA" } });
    const admin = await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "a@first-run-page.test",
        role: "admin",
        clerkId: "clerk-frp-admin",
        name: "Ada Admin",
      },
    });
    const member = await db.user.create({
      data: {
        id: MEMBER,
        orgId: ORG,
        email: "m@first-run-page.test",
        role: "member",
        clerkId: "clerk-frp-member",
        name: "Mo Member",
      },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: ENG, name: "Engineering" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    // Org-wide write but not admin: may read and write every scope, may not manage access,
    // so a probe of any other action than access.manage would wrongly show the checklist.
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: MEMBER, permission: "write" },
    });

    signIn = (who) => {
      const user = who === "admin" ? admin : member;
      requireAccessContext.mockResolvedValue({
        org,
        user,
        ctx: { orgId: ORG, actor: { type: "human", id: user.id, role: user.role } },
      });
    };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("an org-wide writer who cannot manage access renders the suggested path, sends no request and writes no audit row", async () => {
    signIn("member");
    const fetchMock = stubFetch();
    const before = await db.auditLog.count({ where: { orgId: ORG } });

    render(await DashboardPage());

    expect(screen.getByRole("heading", { name: "Start with one source." })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "See your memory work." })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(before);
  });

  it("an access manager gets the checklist from one request, and the probe writes no audit row", async () => {
    signIn("admin");
    const fetchMock = stubFetch();
    const before = await db.auditLog.count({ where: { orgId: ORG } });

    render(await DashboardPage());

    expect(screen.getByRole("heading", { name: "See your memory work." })).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/onboarding/first-run", expect.anything());
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(before);
  });
});
