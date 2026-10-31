// The picker queries on /api/contacts, /api/accounts and /api/agents (lib/pick-query.ts).
// The route suite proves literal matching on contacts only; each
// route builds its own predicate, so each route gets its own wildcard and backslash
// probe here, plus the accounts field allowlist and the id tie-break that decides which
// of two same-named rows makes the first N.
//
// Real Postgres, real routes, authentication mocked. Set QA_DATABASE_URL to an isolated
// test database (never the inherited DATABASE_URL); the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "pickqa";
const OTHER_ORG = "pickqaother";
const ADMIN = "u-pickqa-admin";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;

describe.skipIf(!QA_URL)("picker queries match literally on every route", () => {
  let db: PrismaClient;
  let contactsGET: Handler;
  let accountsGET: Handler;
  let agentsGET: Handler;

  async function pickNames(handler: Handler, path: string, key: string, q: string, limit = 10): Promise<string[]> {
    const res = await handler(new Request(`http://t${path}?limit=${limit}&q=${encodeURIComponent(q)}`));
    expect(res.status, `${path} q=${q}`).toBe(200);
    const body = (await res.json()) as Record<string, { name: string }[]>;
    return body[key].map((r) => r.name);
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
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: ADMIN, role: "admin" },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    } as never);
    contactsGET = (await import("@/app/api/contacts/route")).GET;
    accountsGET = (await import("@/app/api/accounts/route")).GET;
    agentsGET = (await import("@/app/api/agents/route")).GET;
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: `org_${ORG}`, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@pick.test`, role: "admin", clerkId: `c-${ADMIN}` },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("treats _, % and \\ in an account search as the characters themselves", async () => {
    for (const name of ["north_star", "northXstar", "50% off", "500 off", "back\\slash", "backslash"]) {
      await db.account.create({ data: { orgId: ORG, name } });
    }
    expect(await pickNames(accountsGET, "/api/accounts", "accounts", "north_star")).toEqual(["north_star"]);
    expect(await pickNames(accountsGET, "/api/accounts", "accounts", "50%")).toEqual(["50% off"]);
    expect(await pickNames(accountsGET, "/api/accounts", "accounts", "back\\slash")).toEqual(["back\\slash"]);
  });

  it("treats _, % and \\ in an agent search as the characters themselves", async () => {
    await db.agent.create({ data: { orgId: ORG, agentKey: "deal_desk", name: "Deal desk", role: "custom" } });
    await db.agent.create({ data: { orgId: ORG, agentKey: "dealXdesk", name: "Wildcard bait", role: "custom" } });
    await db.agent.create({ data: { orgId: ORG, agentKey: "pct", name: "100% sure", role: "custom" } });
    await db.agent.create({ data: { orgId: ORG, agentKey: "bs", name: "a\\b", role: "custom" } });
    await db.agent.create({ data: { orgId: ORG, agentKey: "ab", name: "ab", role: "custom" } });
    expect(await pickNames(agentsGET, "/api/agents", "agents", "deal_")).toEqual(["Deal desk"]);
    expect(await pickNames(agentsGET, "/api/agents", "agents", "%")).toEqual(["100% sure"]);
    expect(await pickNames(agentsGET, "/api/agents", "agents", "a\\b")).toEqual(["a\\b"]);
  });

  it("treats \\ in a contact search as the character itself", async () => {
    await db.contact.create({ data: { orgId: ORG, name: "x\\y" } });
    await db.contact.create({ data: { orgId: ORG, name: "xy" } });
    expect(await pickNames(contactsGET, "/api/contacts", "contacts", "x\\y")).toEqual(["x\\y"]);
  });

  it("returns only the fields an account picker shows", async () => {
    await db.account.create({ data: { orgId: ORG, name: "Acme", domain: "acme.test", description: "private notes" } });
    const res = await accountsGET(new Request("http://t/api/accounts?limit=5"));
    const { accounts } = (await res.json()) as { accounts: Record<string, unknown>[] };
    expect(Object.keys(accounts[0]).sort()).toEqual(["domain", "id", "name"]);
  });

  it("breaks a name tie by id on every route, so the first N is the same on every call", async () => {
    await db.contact.create({ data: { id: "qa-contact-b", orgId: ORG, name: "Same" } });
    await db.contact.create({ data: { id: "qa-contact-a", orgId: ORG, name: "Same" } });
    await db.account.create({ data: { id: "qa-account-b", orgId: ORG, name: "Same" } });
    await db.account.create({ data: { id: "qa-account-a", orgId: ORG, name: "Same" } });
    await db.agent.create({ data: { id: "qa-agent-b", orgId: ORG, agentKey: "same-b", name: "Same", role: "custom" } });
    await db.agent.create({ data: { id: "qa-agent-a", orgId: ORG, agentKey: "same-a", name: "Same", role: "custom" } });

    for (const [handler, path, key, id] of [
      [contactsGET, "/api/contacts", "contacts", "qa-contact-a"],
      [accountsGET, "/api/accounts", "accounts", "qa-account-a"],
      [agentsGET, "/api/agents", "agents", "qa-agent-a"],
    ] as const) {
      const res = await handler(new Request(`http://t${path}?limit=1`));
      const body = (await res.json()) as Record<string, unknown>;
      const rows = body[key] as { id: string }[];
      expect(
        rows.map((r) => r.id),
        path,
      ).toEqual([id]);
      expect(body.more, path).toBe(true);
    }
  });
});
