// GET /api/contacts, /api/accounts and /api/agents with `?limit=N&q=text`: the server half of
// the type-to-search pickers (lib/pick-query.ts). Each answers at most N rows of the caller's
// org, by name, matched literally on the documented fields, and says whether more match; a
// contact pick still goes through the contacts read gate, and an agent pick carries no config.
//
// Runs the shipping routes against a real Postgres with ltree and the real access evaluator.
// Authentication is mocked. Set QA_DATABASE_URL to an isolated test database (never the
// inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "pickroutes";
const OTHER_ORG = "pickroutesother";
const ROOT = `org_${ORG}`;
const ADMIN = "u-pick-admin";
const MEMBER = "u-pick-member";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;

describe.skipIf(!QA_URL)("picker queries on the contacts, accounts and agents routes", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let contactsGET: Handler;
  let accountsGET: Handler;
  let agentsGET: Handler;

  async function pick<T>(handler: Handler, path: string, query: string): Promise<T> {
    const res = await handler(new Request(`http://t${path}?${query}`));
    expect(res.status, `${path}?${query}`).toBe(200);
    return (await res.json()) as T;
  }
  const names = (rows: { name: string }[]) => rows.map((r) => r.name);

  function actAs(id: string, role: "admin" | "member") {
    requireAccessContext.mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id, role },
      ctx: { orgId: ORG, actor: { type: "human", id, role } },
    } as never);
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      for (const t of ["contact", "account", "agent", "grant", "scope", "user"] as const) {
        await (db[t] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId: org } });
      }
      await deleteOrgsWithRetry(db, { where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    contactsGET = (await import("@/app/api/contacts/route")).GET;
    accountsGET = (await import("@/app/api/accounts/route")).GET;
    agentsGET = (await import("@/app/api/agents/route")).GET;
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@pick.test`, role: "admin", clerkId: `c-${ADMIN}` },
    });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${MEMBER}@pick.test`, role: "member", clerkId: `c-${MEMBER}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    actAs(ADMIN, "admin");
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("answers the first N contacts by name, reports more, and stays inside the org", async () => {
    for (const name of ["Dana", "Ada", "Cy", "Bea"]) await db.contact.create({ data: { orgId: ORG, name } });
    await db.contact.create({ data: { orgId: OTHER_ORG, name: "Aaron elsewhere" } });

    const first = await pick<{ contacts: { name: string }[]; more: boolean }>(contactsGET, "/api/contacts", "limit=3");
    expect(names(first.contacts)).toEqual(["Ada", "Bea", "Cy"]);
    expect(first.more).toBe(true);

    const all = await pick<{ contacts: { name: string }[]; more: boolean }>(contactsGET, "/api/contacts", "limit=4");
    expect(names(all.contacts)).toEqual(["Ada", "Bea", "Cy", "Dana"]);
    expect(all.more).toBe(false);
  });

  it("matches contacts by name, email or title, case-insensitively and literally", async () => {
    await db.contact.create({ data: { orgId: ORG, name: "Grace Hopper" } });
    await db.contact.create({ data: { orgId: ORG, name: "Mail Match", email: "lin@ACME.test" } });
    await db.contact.create({ data: { orgId: ORG, name: "Title Match", title: "Head of acme_ops" } });
    await db.contact.create({ data: { orgId: ORG, name: "Wildcard bait", title: "acmeXops" } });

    const byText = async (q: string) =>
      names(
        (
          await pick<{ contacts: { name: string }[] }>(
            contactsGET,
            "/api/contacts",
            `limit=10&q=${encodeURIComponent(q)}`,
          )
        ).contacts,
      );
    expect(await byText("hopper")).toEqual(["Grace Hopper"]);
    expect(await byText("acme.test")).toEqual(["Mail Match"]);
    // `_` is a literal underscore, not LIKE's any-one-character.
    expect(await byText("acme_ops")).toEqual(["Title Match"]);
    expect(await byText("%")).toEqual([]);
  });

  it("returns only the fields a picker shows", async () => {
    await db.contact.create({
      data: { orgId: ORG, name: "Ada", email: "ada@x.test", title: "CTO", description: "private notes" },
    });
    const { contacts } = await pick<{ contacts: Record<string, unknown>[] }>(contactsGET, "/api/contacts", "limit=5");
    expect(Object.keys(contacts[0]).sort()).toEqual(["email", "id", "name", "title"]);
  });

  it("keeps the contacts read gate on a pick, and refuses a malformed pick before it", async () => {
    await db.contact.create({ data: { orgId: ORG, name: "Ada" } });
    actAs(MEMBER, "member");
    expect((await contactsGET(new Request("http://t/api/contacts?limit=5"))).status).toBe(403);
    const auditBefore = await db.auditLog.count({ where: { orgId: ORG } });
    expect((await contactsGET(new Request("http://t/api/contacts?limit=0"))).status).toBe(400);
    expect(await db.auditLog.count({ where: { orgId: ORG } })).toBe(auditBefore);
  });

  it("answers accounts by name or domain, first N by name, inside the org", async () => {
    await db.account.create({ data: { orgId: ORG, name: "Zeta", domain: "globex.test" } });
    await db.account.create({ data: { orgId: ORG, name: "Acme" } });
    await db.account.create({ data: { orgId: ORG, name: "Beta" } });
    await db.account.create({ data: { orgId: OTHER_ORG, name: "Aardvark elsewhere" } });

    const first = await pick<{ accounts: { name: string }[]; more: boolean }>(accountsGET, "/api/accounts", "limit=2");
    expect(names(first.accounts)).toEqual(["Acme", "Beta"]);
    expect(first.more).toBe(true);
    const byDomain = await pick<{ accounts: { name: string }[]; more: boolean }>(
      accountsGET,
      "/api/accounts",
      "limit=5&q=GLOBEX",
    );
    expect(names(byDomain.accounts)).toEqual(["Zeta"]);
    expect(byDomain.more).toBe(false);
  });

  it("answers agents, built-in and custom, by name or key, with no config", async () => {
    await db.agent.create({
      data: {
        orgId: ORG,
        agentKey: "research-agent",
        name: "Research",
        role: "research",
        systemPrompt: "secret prompt",
      },
    });
    await db.agent.create({ data: { orgId: ORG, agentKey: "deal-desk", name: "Deal desk", role: "custom" } });
    await db.agent.create({
      data: { orgId: OTHER_ORG, agentKey: "elsewhere", name: "Alpha elsewhere", role: "custom" },
    });

    const all = await pick<{ agents: Record<string, unknown>[]; more: boolean }>(agentsGET, "/api/agents", "limit=5");
    expect(all.agents.map((a) => a.name)).toEqual(["Deal desk", "Research"]);
    expect(Object.keys(all.agents[0]).sort()).toEqual(["agentKey", "id", "name", "role"]);
    const byKey = await pick<{ agents: { name: string }[] }>(agentsGET, "/api/agents", "limit=5&q=deal-");
    expect(names(byKey.agents)).toEqual(["Deal desk"]);
  });

  it("breaks an agent name tie by id, whatever order the keys or the table hold them in", async () => {
    // Key order and storage order both put b first; only the id tie-break puts a first.
    await db.agent.create({
      data: { id: "tie-agent-b", orgId: ORG, agentKey: "same-1", name: "Same", role: "custom" },
    });
    await db.agent.create({
      data: { id: "tie-agent-a", orgId: ORG, agentKey: "same-2", name: "Same", role: "custom" },
    });
    const first = await pick<{ agents: { id: string }[]; more: boolean }>(agentsGET, "/api/agents", "limit=1&q=same");
    expect(first).toEqual({ agents: [expect.objectContaining({ id: "tie-agent-a" })], more: true });
  });

  it("refuses a pick combined with kind, and a bad limit, on agents", async () => {
    expect((await agentsGET(new Request("http://t/api/agents?limit=5&kind=builtin"))).status).toBe(400);
    expect((await agentsGET(new Request("http://t/api/agents?limit=51"))).status).toBe(400);
  });

  it("keeps the whole-list answers for callers that send no limit", async () => {
    for (const name of ["A", "B", "C"]) await db.account.create({ data: { orgId: ORG, name } });
    const res = await accountsGET(new Request("http://t/api/accounts"));
    const body = (await res.json()) as { accounts: unknown[]; more?: boolean };
    expect(body.accounts).toHaveLength(3);
    expect(body.more).toBeUndefined();
  });
});
