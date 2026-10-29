// GET /api/integrations?provider=&page=: one provider's connected accounts on the
// Integrations page, paged, searched and ordered in the query, with its newest attempt
// in each other state. Every connected account appears on exactly one page, a search
// is literal, another provider's or org's rows are never listed or counted, and no
// token leaves the route.
//
// Runs the shipping route against a real Postgres. Authentication is mocked. Set
// QA_DATABASE_URL to an isolated test database (never the inherited DATABASE_URL);
// the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { ACCOUNT_PAGE_SIZE } from "@/lib/integration-lists";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "integrationaccountspage";
const OTHER_ORG = "integrationaccountspageother";
const MEMBER = "u-iap-member";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type Handler = (req: Request) => Promise<Response>;
type Row = {
  id: string;
  provider: string;
  status: string;
  externalAccountId: string | null;
  meta: Record<string, unknown>;
} & Record<string, unknown>;
type AccountPage = {
  integrations: Row[];
  total: number;
  count: number;
  page: number;
  pageSize: number;
  attempts: Record<"pending" | "error" | "disconnected", Row | null>;
};

describe.skipIf(!QA_URL)("the Integrations account lists are paged and narrowed on the server", () => {
  let db: PrismaClient;
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let GET: Handler;

  async function list(query: string): Promise<AccountPage> {
    const res = await GET(new Request(`http://t/api/integrations?${query}`));
    expect(res.status).toBe(200);
    return (await res.json()) as AccountPage;
  }
  const accounts = (page: AccountPage) =>
    page.integrations.map((r) => (r.meta.email ?? r.meta.teamName ?? r.externalAccountId) as string);

  let seq = 0;
  /** An integration row in `org`, created `minutesAgo` before now so the default order is known. */
  async function integration(
    provider: string,
    status: string,
    {
      email,
      teamName,
      org = ORG,
      minutesAgo = 0,
      meta = {},
    }: { email?: string; teamName?: string; org?: string; minutesAgo?: number; meta?: Record<string, unknown> } = {},
  ) {
    seq += 1;
    return db.integration.create({
      data: {
        orgId: org,
        provider: provider as never,
        status: status as never,
        externalAccountId: status === "connected" ? `acct-${seq}` : null,
        encryptedTokens: "sealed-tokens",
        meta: { ...(email ? { email } : {}), ...(teamName ? { teamName } : {}), ...meta },
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      },
    });
  }

  async function clear() {
    for (const org of [ORG, OTHER_ORG]) {
      await db.integration.deleteMany({ where: { orgId: org } });
      await db.user.deleteMany({ where: { orgId: org } });
      await db.org.deleteMany({ where: { id: org } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    requireAccessContext = vi.mocked((await import("@/lib/access-context")).requireAccessContext);
    GET = (await import("@/app/api/integrations/route")).GET;
  });

  beforeEach(async () => {
    await clear();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.user.create({
      data: { id: MEMBER, orgId: ORG, email: `${MEMBER}@iap.test`, role: "member", clerkId: `c-${MEMBER}` },
    });
    requireAccessContext.mockResolvedValue({
      org: { id: ORG, name: ORG },
      user: { id: MEMBER, role: "member" },
      ctx: { orgId: ORG, actor: { type: "human", id: MEMBER, role: "member" } },
    } as never);

    // Another tenant's mailboxes, matching every search below: never listed or counted here.
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
    await integration("gmail", "connected", { org: OTHER_ORG, email: "100%@foreign.test" });
    await integration("gmail", "error", { org: OTHER_ORG, meta: { error: "access_denied" } });
  });

  afterAll(async () => {
    await clear();
    await db.$disconnect();
  });

  it("pages every connected account of the provider once, newest first", async () => {
    const created: string[] = [];
    for (let i = 0; i < ACCOUNT_PAGE_SIZE + 2; i += 1) {
      const email = `box${String(i).padStart(2, "0")}@acme.test`;
      await integration("gmail", "connected", { email, minutesAgo: i });
      created.push(email);
    }
    await integration("outlook", "connected", { email: "other@acme.test" });
    await integration("gmail", "pending");

    const first = await list("provider=gmail&page=1");
    const second = await list("provider=gmail&page=2");
    expect(first).toMatchObject({ total: 12, count: 12, page: 1, pageSize: ACCOUNT_PAGE_SIZE });
    expect(first.integrations).toHaveLength(ACCOUNT_PAGE_SIZE);
    expect([...accounts(first), ...accounts(second)]).toEqual(created);
    expect(first.integrations.every((r) => r.status === "connected" && r.provider === "gmail")).toBe(true);
  });

  it("never returns stored tokens, on a page or in an attempt", async () => {
    await integration("slack", "connected", { teamName: "Acme" });
    await integration("slack", "error", { meta: { error: "access_denied" } });
    const page = await list("provider=slack&page=1");
    const keys = ["createdAt", "externalAccountId", "id", "meta", "provider", "status", "updatedAt"];
    expect(Object.keys(page.integrations[0]).sort()).toEqual(keys);
    expect(Object.keys(page.attempts.error!).sort()).toEqual(keys);
    expect(JSON.stringify(page)).not.toContain("sealed-tokens");
  });

  it("searches the address, the workspace name and the account id literally, and orders by name regardless of case", async () => {
    await integration("gmail", "connected", { email: "100%@acme.test" });
    await integration("gmail", "connected", { email: "1000@acme.test" });
    await integration("gmail", "connected", { email: "ops_desk@acme.test" });
    await integration("gmail", "connected", { email: "OpsXdesk@acme.test" });
    await integration("slack", "connected", { teamName: "Zeta Team" });
    await integration("slack", "connected", { teamName: "alpha team" });

    expect(accounts(await list("provider=gmail&page=1&q=100%25"))).toEqual(["100%@acme.test"]);
    expect(accounts(await list("provider=gmail&page=1&q=ops_"))).toEqual(["ops_desk@acme.test"]);
    const team = await list("provider=slack&page=1&q=TEAM&sort=account&order=asc");
    expect(accounts(team)).toEqual(["alpha team", "Zeta Team"]);
    expect(team).toMatchObject({ total: 2, count: 2 });
    const byId = await list(`provider=slack&page=1&q=${team.integrations[0].externalAccountId}`);
    expect(accounts(byId)).toEqual(["alpha team"]);
  });

  it("answers the newest attempt in each other state, for this provider and org only", async () => {
    await integration("gmail", "error", { meta: { error: "access_denied" }, minutesAgo: 10 });
    const newestError = await integration("gmail", "error", { meta: { error: "invalid_code" }, minutesAgo: 1 });
    const pending = await integration("gmail", "pending", { minutesAgo: 5 });
    await integration("outlook", "disconnected");

    const page = await list("provider=gmail&page=1");
    expect(page).toMatchObject({ total: 0, count: 0 });
    expect(page.attempts.error?.id).toBe(newestError.id);
    expect(page.attempts.pending?.id).toBe(pending.id);
    expect(page.attempts.disconnected).toBeNull();
  });

  it("refuses a request without a provider or page, or with a value the list does not offer", async () => {
    for (const query of [
      "",
      "page=1",
      "provider=gmail",
      "provider=dropbox&page=1",
      "provider=gmail&page=1&sort=status",
      "provider=gmail&page=1&q=a%00b",
    ]) {
      const res = await GET(new Request(`http://t/api/integrations?${query}`));
      expect(res.status, query).toBe(400);
    }
  });
});
