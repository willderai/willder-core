// QA for the agents dashboard roster at scale, against a real Postgres: 1,050 agents
// (600 of the org's own, 450 known only by capability tokens). Every page of the
// roster, read the way a deep link reads it, must hold exactly the rows the caller
// may see, with no repeat and no gap, and the total must match for a member and an
// access manager alike. Authentication is mocked. Set QA_DATABASE_URL to an isolated
// test database (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "agentdashqa";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.dept_sales`;
const MEMBER = "u-adqa-member";
const ADMIN = "u-adqa-admin";
const OWN = 600;
const CONNECTED = 450;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

interface RosterBody {
  rows: { kind: string; key: string; name: string }[];
  total: number;
  page: number;
  pageSize: number;
}

describe.skipIf(!QA_URL)("QA: the agents roster at 1,050 agents", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let roster: (req: Request) => Promise<Response>;
  let dashboard: () => Promise<Response>;

  function actAs(userId: string, role: string) {
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: userId },
      ctx: { orgId: ORG, actor: { type: "human", id: userId, role } },
    } as never);
  }

  async function page(query: string): Promise<RosterBody> {
    const res = await roster(new Request(`http://t/api/agents/roster?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as RosterBody;
  }

  /** Every page of one roster view, read one deep link at a time. */
  async function everyPage(query: string): Promise<{ keys: string[]; totals: Set<number>; pages: number }> {
    const first = await page(`${query}&page=1`);
    const pages = Math.ceil(first.total / first.pageSize);
    const keys = first.rows.map((row) => `${row.kind}:${row.key}`);
    const totals = new Set([first.total]);
    for (let n = 2; n <= pages; n += 1) {
      const body = await page(`${query}&page=${n}`);
      totals.add(body.total);
      expect(body.rows.length).toBe(n < pages ? body.pageSize : first.total - (pages - 1) * body.pageSize);
      keys.push(...body.rows.map((row) => `${row.kind}:${row.key}`));
    }
    return { keys, totals, pages };
  }

  async function clear() {
    await db.agentRunEvent.deleteMany({ where: { run: { orgId: ORG } } });
    await db.agentRun.deleteMany({ where: { orgId: ORG } });
    for (const t of ["capability", "agent", "grant", "scope", "user"] as const) {
      await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: ORG } });
    }
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    roster = (await import("@/app/api/agents/roster/route")).GET;
    dashboard = (await import("@/app/api/agents/dashboard/route")).GET;

    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    const sales = await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: "m@adqa.test", role: "member", clerkId: "c-adqa-m" },
    });
    await db.user.create({ data: { id: ADMIN, orgId: ORG, email: "a@adqa.test", role: "admin", clerkId: "c-adqa-a" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: sales.id, granteeType: "user", granteeId: MEMBER, permission: "read" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    // Many share a name, so the name sort leans on its id tie-break at every page edge.
    await db.agent.createMany({
      data: Array.from({ length: OWN }, (_, i) => ({
        orgId: ORG,
        agentKey: `own-${String(i).padStart(4, "0")}`,
        name: `Agent ${String(i % 37).padStart(2, "0")}`,
        role: "custom" as const,
      })),
    });
    const expires = new Date(Date.now() + 86_400_000);
    await db.capability.createMany({
      data: Array.from({ length: CONNECTED }, (_, i) => ({
        orgId: ORG,
        agentId: `client-${String(i).padStart(4, "0")}`,
        tokenHash: `hash-adqa-${i}`,
        scopePath: SALES,
        permission: "read" as const,
        expiresAt: expires,
      })),
    });
  }, 120_000);

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("pages an access manager through every agent by deep link, no repeat and no gap", async () => {
    actAs(ADMIN, "admin");
    const { keys, totals, pages } = await everyPage("sort=name&order=asc");
    expect([...totals]).toEqual([OWN + CONNECTED]);
    expect(pages).toBe(Math.ceil((OWN + CONNECTED) / 12));
    expect(new Set(keys).size).toBe(OWN + CONNECTED);
    expect(keys.filter((key) => key.startsWith("connected:"))).toHaveLength(CONNECTED);

    const past = await page(`sort=name&page=${pages + 1}`);
    expect(past).toMatchObject({ rows: [], total: OWN + CONNECTED });

    const dash = (await (await dashboard()).json()) as {
      agents: { own: { total: number }; connected: { total: number; live: number } };
    };
    expect(dash.agents.own.total).toBe(OWN);
    expect(dash.agents.connected).toEqual({ total: CONNECTED, live: CONNECTED });
  }, 120_000);

  it("gives a member every own agent and no connected one, on every page", async () => {
    actAs(MEMBER, "member");
    const { keys, totals } = await everyPage("sort=name&order=desc");
    expect([...totals]).toEqual([OWN]);
    expect(new Set(keys).size).toBe(OWN);
    expect(keys.some((key) => key.startsWith("connected:"))).toBe(false);
    expect(await page("kind=connected")).toMatchObject({ rows: [], total: 0 });
    // Deep into a search: a connected agent's key never matches for a member.
    expect(await page("q=client-04")).toMatchObject({ rows: [], total: 0 });

    const dash = (await (await dashboard()).json()) as { agents: { connected: unknown }; decisions: unknown };
    expect(dash.agents.connected).toBeNull();
    expect(dash.decisions).toBeNull();
  }, 120_000);

  it("filters and searches deep pages for a manager with the same totals", async () => {
    actAs(ADMIN, "admin");
    const connected = await everyPage("kind=connected&sort=lastActive");
    expect([...connected.totals]).toEqual([CONNECTED]);
    expect(new Set(connected.keys).size).toBe(CONNECTED);
    // `Agent 05` names 17 of the 600 (i % 37 === 5).
    const named = await everyPage("q=Agent%2005&sort=runs");
    expect([...named.totals]).toEqual([Array.from({ length: OWN }, (_, i) => i).filter((i) => i % 37 === 5).length]);
  }, 120_000);
});
