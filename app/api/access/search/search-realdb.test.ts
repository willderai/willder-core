// GET /api/access/search against a real Postgres 16: two orgs hold rows with
// identical names, keys and targets, and every kind of search from one org must
// return only that org's rows. Also covers the per-kind access checks, the
// token short id, and the audit visibility rule.
//
// Set QA_DATABASE_URL to an isolated test database. Skips cleanly without it.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG_A = "3201";
const ORG_B = "3202";
const ADMIN_A = "u-admin-3201";
const MEMBER_A = "u-member-3201";
const ADMIN_B = "u-admin-3202";
// Agent keys are unique per org only, so both orgs have this one.
const SHARED_AGENT_KEY = "research-agent";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

type KindBody<T> = { denied: true } | { denied: false; items: T[]; hasMore: boolean };
type SearchBody = {
  scopes?: KindBody<{ id: string; name: string; path: string }>;
  agents?: KindBody<{ id: string; name: string }>;
  tokens?: KindBody<{ id: string; agentId: string }>;
  sources?: KindBody<{ id: string; name: string }>;
  audit?: KindBody<{
    id: string;
    target: string | null;
    decision: "allow" | "deny";
    capabilityId?: string;
    actorName: string;
  }>;
};

function items<T>(kind: KindBody<T> | undefined): T[] {
  if (!kind || kind.denied) throw new Error(`expected results, got ${JSON.stringify(kind)}`);
  return kind.items;
}

describe.skipIf(!QA_URL)("GET /api/access/search, real Postgres, two orgs", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let signInAs: (userId: string) => Promise<void>;
  const ids: Record<string, string[]> = { [ORG_A]: [], [ORG_B]: [] };
  let tokenA = "";
  let tokenB = "";

  async function search(query: string): Promise<SearchBody> {
    const res = await GET(new Request(`http://t/api/access/search?${query}`));
    expect(res.status).toBe(200);
    return res.json() as Promise<SearchBody>;
  }

  /** Every id a search returned, across every kind. */
  function allIds(body: SearchBody): string[] {
    return [body.scopes, body.agents, body.tokens, body.sources, body.audit].flatMap((k) =>
      k && !k.denied ? (k.items as { id: string }[]).map((i) => i.id) : [],
    );
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    const { hashCapabilityToken } = await import("@/services/access/capabilities");

    for (const orgId of [ORG_A, ORG_B]) {
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.source.deleteMany({ where: { orgId } });
      await db.agent.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }

    const at = new Date("2026-09-01T00:00:00Z");
    for (const [orgId, adminId] of [
      [ORG_A, ADMIN_A],
      [ORG_B, ADMIN_B],
    ] as const) {
      const root = `org_${orgId}`;
      const sales = `${root}.dept_sales`;
      await db.org.create({ data: { id: orgId, name: `QA${orgId}` } });
      await db.user.create({
        data: { id: adminId, orgId, email: `admin@qa${orgId}.test`, role: "admin", clerkId: `clerk-${adminId}` },
      });
      const rootScope = await db.scope.create({ data: { orgId, path: root, name: "Organization" } });
      await db.grant.create({
        data: { orgId, scopeId: rootScope.id, granteeType: "user", granteeId: adminId, permission: "admin" },
      });
      // Identical in both orgs: the same names, keys and targets.
      const scope = await db.scope.create({ data: { orgId, path: sales, name: "Sales" } });
      const agent = await db.agent.create({
        data: { orgId, agentKey: SHARED_AGENT_KEY, name: "Researcher", role: "research" },
      });
      const source = await db.source.create({
        data: { orgId, type: "website", externalId: "roadmap.example.com", name: "Roadmap", scopePath: sales },
      });
      const cap = await db.capability.create({
        data: {
          orgId,
          agentId: SHARED_AGENT_KEY,
          tokenHash: hashCapabilityToken(`qa-search-${orgId}`),
          scopePath: sales,
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const read = await db.auditLog.create({
        data: {
          orgId,
          actorType: "agent",
          actorId: SHARED_AGENT_KEY,
          action: "memory.read",
          target: `${sales}/roadmap`,
          decision: "allow",
          at,
        },
      });
      const refused = await db.auditLog.create({
        data: {
          orgId,
          actorType: "agent",
          actorId: SHARED_AGENT_KEY,
          action: "memory.read",
          target: sales,
          decision: "deny",
          reason: "capability revoked",
          metadata: { capabilityId: cap.id },
          at,
        },
      });
      ids[orgId].push(scope.id, agent.id, source.id, cap.id, read.id, refused.id);
      if (orgId === ORG_A) tokenA = cap.id;
      else tokenB = cap.id;
    }

    // Rows only org B has. Org A searching for them must find nothing at all.
    await db.scope.create({ data: { orgId: ORG_B, path: `org_${ORG_B}.blackbird`, name: "Blackbird" } });
    await db.agent.create({ data: { orgId: ORG_B, agentKey: "blackbird-agent", name: "Blackbird", role: "research" } });
    await db.source.create({
      data: {
        orgId: ORG_B,
        type: "website",
        externalId: "blackbird.example.com",
        name: "Blackbird",
        scopePath: `org_${ORG_B}`,
      },
    });
    await db.capability.create({
      data: {
        orgId: ORG_B,
        agentId: "blackbird-agent",
        tokenHash: hashCapabilityToken("qa-search-blackbird"),
        scopePath: `org_${ORG_B}.blackbird`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await db.auditLog.create({
      data: {
        orgId: ORG_B,
        actorType: "agent",
        actorId: "blackbird-agent",
        action: "memory.read",
        target: `org_${ORG_B}.blackbird`,
        decision: "allow",
        at,
      },
    });
    // Org B renamed its copy of the shared agent key. Org A's rows written by
    // that key must not match org B's name for it.
    await db.agent.update({
      where: { orgId_agentKey: { orgId: ORG_B, agentKey: SHARED_AGENT_KEY } },
      data: { name: "Mallory" },
    });

    // A person who left org A for org B: ensureTenant() moves their User row,
    // so org A keeps audit rows whose actorId is now an org B user. Org A's
    // search must not look up org B's users to match them.
    await db.user.create({
      data: { id: "u-moved-3202", orgId: ORG_B, name: "Wren Moved", email: "wren@moved.test", clerkId: "clerk-moved" },
    });
    await db.auditLog.create({
      data: {
        orgId: ORG_A,
        actorType: "human",
        actorId: "u-moved-3202",
        action: "memory.read",
        target: `org_${ORG_A}`,
        decision: "allow",
        at,
      },
    });

    // A member of org A with read access only: no access.manage, no memory.write.
    await db.user.create({
      data: { id: MEMBER_A, orgId: ORG_A, email: "member@case3201.test", role: "member", clerkId: `clerk-${MEMBER_A}` },
    });
    const rootA = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: ORG_A, path: `org_${ORG_A}` } } });
    await db.grant.create({
      data: { orgId: ORG_A, scopeId: rootA.id, granteeType: "user", granteeId: MEMBER_A, permission: "read" },
    });
    // A literal-match probe: `_` in a query must not act as a LIKE wildcard.
    const probe = await db.scope.create({
      data: { orgId: ORG_A, path: `org_${ORG_A}.salesxteam`, name: "salesXteam" },
    });
    ids[ORG_A].push(probe.id);

    signInAs = async (userId: string) => {
      const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
      requireAccessContext.mockResolvedValue({
        org: await db.org.findUnique({ where: { id: user.orgId } }),
        user,
        ctx: { orgId: user.orgId, actor: { type: "human", id: user.id, role: user.role } },
      });
    };
    await signInAs(ADMIN_A);
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("a query both orgs match returns only the caller's org, in every kind", async () => {
    for (const q of ["sales", "Researcher", "roadmap", SHARED_AGENT_KEY]) {
      const body = await search(`q=${encodeURIComponent(q)}&limit=50`);
      const returned = allIds(body);
      expect(returned.length, `"${q}" should match org A rows`).toBeGreaterThan(0);
      expect(
        returned.filter((id) => !ids[ORG_A].includes(id)),
        `"${q}" leaked`,
      ).toEqual([]);
    }
    const body = await search("q=sales&limit=50");
    expect(items(body.scopes).map((s) => s.name)).toEqual(["Sales", "salesXteam"]);
    expect(items(body.tokens).map((t) => t.id)).toEqual([tokenA]);
    expect(items(body.audit)).toHaveLength(2);
    expect(items((await search("q=roadmap&kinds=sources")).sources).map((s) => s.name)).toEqual(["Roadmap"]);
  });

  it("a query only the other org matches finds nothing in any kind", async () => {
    const body = await search("q=blackbird");
    for (const kind of [body.scopes, body.agents, body.tokens, body.sources, body.audit]) {
      expect(items(kind as KindBody<unknown>)).toEqual([]);
    }
    // And from org B's side the same query does find them.
    await signInAs(ADMIN_B);
    try {
      const own = await search("q=blackbird");
      expect(items(own.scopes)).toHaveLength(1);
      expect(items(own.agents)).toHaveLength(1);
      expect(items(own.tokens)).toHaveLength(1);
      expect(items(own.sources)).toHaveLength(1);
      expect(items(own.audit)).toHaveLength(1);
    } finally {
      await signInAs(ADMIN_A);
    }
  });

  it("an actor name resolves within the caller's org only, though agent keys repeat across orgs", async () => {
    const body = await search("q=Mallory&kinds=audit,agents");
    expect(items(body.agents)).toEqual([]);
    expect(items(body.audit)).toEqual([]);
    // Nor is a user who now belongs to org B looked up by name from org A.
    expect(items((await search("q=Wren&kinds=audit")).audit)).toEqual([]);
    // Org A's own name for the key does find its rows.
    const own = await search("q=Researcher&kinds=audit");
    expect(
      items(own.audit)
        .map((r) => r.id)
        .sort(),
    ).toEqual(ids[ORG_A].slice(4, 6).sort());
    expect(items(own.audit).every((r) => r.actorName === "Researcher Agent")).toBe(true);
  });

  it("a token's short id finds the token and its refused audit row, and never another org's", async () => {
    const shortA = tokenA.slice(-8);
    const body = await search(`q=${shortA}&kinds=tokens,audit`);
    expect(items(body.tokens).map((t) => t.id)).toEqual([tokenA]);
    expect(items(body.audit).map((r) => r.capabilityId)).toEqual([tokenA]);

    const other = await search(`q=${tokenB.slice(-8)}&kinds=tokens,audit`);
    expect(items(other.tokens)).toEqual([]);
    expect(items(other.audit)).toEqual([]);
  });

  it("a member without access.manage or memory.write is told so per kind, not given an empty list", async () => {
    await signInAs(MEMBER_A);
    try {
      const body = await search("q=sales");
      expect(body.scopes).toEqual({ denied: true });
      expect(body.tokens).toEqual({ denied: true });
      expect(body.audit).toEqual({ denied: true });
      expect(body.sources).toEqual({ denied: true });
      // Agents follow GET /api/agents, which any signed-in member may list.
      expect(items((await search("q=Researcher")).agents)).toHaveLength(1);
    } finally {
      await signInAs(ADMIN_A);
    }
  });

  it("matches literally: `_` is not a wildcard", async () => {
    const body = await search("q=sales_team&kinds=scopes");
    expect(items(body.scopes)).toEqual([]);
    const exact = await search("q=salesXteam&kinds=scopes");
    expect(items(exact.scopes).map((s) => s.name)).toEqual(["salesXteam"]);
    // A real `_` still matches itself.
    const underscored = await search("q=dept_sales&kinds=scopes");
    expect(items(underscored.scopes).map((s) => s.name)).toEqual(["Sales"]);
  });

  // The search's own allowed check rows are admin probe noise and never show.
  // A refusal at the same gate (the member's, earlier in this suite) always shows.
  it("audit results keep the visibility rule: the search's own allowed check rows never show, refusals do", async () => {
    await search("q=sales&kinds=audit");
    const where = { orgId: ORG_A, target: { contains: "access:search" } };
    const allowed = await db.auditLog.count({ where: { ...where, decision: "allow" } });
    const denied = await db.auditLog.count({ where: { ...where, decision: "deny" } });
    expect(allowed).toBeGreaterThan(0);
    expect(denied).toBeGreaterThan(0);
    const shown = items((await search("q=access:search&kinds=audit")).audit);
    expect(shown.filter((row) => row.decision === "allow")).toEqual([]);
    expect(shown.filter((row) => row.decision === "deny")).toHaveLength(denied);
  });

  it("rejects a query that is too short or names an unknown kind", async () => {
    expect((await GET(new Request("http://t/api/access/search?q=s"))).status).toBe(400);
    expect((await GET(new Request("http://t/api/access/search?q=sales&kinds=users"))).status).toBe(400);
  });
});
