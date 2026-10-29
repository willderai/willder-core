// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A retired source's events leave the change feed on a narrowing reconnect, against a real database.
//
// Drives the two real HTTP entry points against a real Postgres: a reconnect
// (POST /api/sources) that narrows a Slack source from OLD_SCOPE to NEW_SCOPE,
// then the change feed (GET /api/changes) read with a capability token on the
// scope the source was pulled out of. Only the session lookup, the human-side
// check(), the sync dispatch and the graph store are mocked; the feed's own
// capability resolution and check() run for real.
//
// Set QA_DATABASE_URL to an isolated test database; the suite skips without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The connect's widening gate has its own tests (app/api/sources/route.widening.realdb.test.ts).
// Here the source reports anyone can read it, so connects widen nothing and these
// tests stay on what they cover; the scope's readers are still counted for real.
vi.mock("@/services/connectors/source-readers", () => ({
  readersAtSource: vi.fn(async () => ({ kind: "known", readers: [{ kind: "everyone" }] })),
}));

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3600 } }));
vi.mock("@/lib/inngest", () => ({
  SOURCE_SYNC_EVENT: "source/sync.requested",
  inngest: { send: vi.fn().mockResolvedValue({ ids: ["job_1"] }) },
}));
// The human connecting the source is allowed (session/role lookup is not under
// test); every agent-side decision, including the feed's, goes to the real check().
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return {
    ...actual,
    check: vi.fn((ctx: { actor: { type: string } }, req: unknown) =>
      ctx.actor.type === "human" ? Promise.resolve({ allowed: true }) : actual.check(ctx as never, req as never),
    ),
  };
});
vi.mock("@/services/memory/store", () => ({
  graphitiStore: { removeGroupFacts: vi.fn(async () => ({ removedCount: 0 })) },
}));

const ORG = "org-case315";
const OTHER_ORG = "org-case315-b";
const OLD_SCOPE = "org_qa315.sales";
const NEW_SCOPE = "org_qa315.sales.leads";
const SECRET = "Acme renewal floor is 41 dollars a seat";
const OTHER_SECRET = "Beta corp churn risk list";

describe.skipIf(!QA_URL)("narrowing reconnect: old-scope feed over HTTP", () => {
  let db: (typeof import("@/lib/db"))["db"];
  let hash: (typeof import("@/services/access/capabilities"))["hashCapabilityToken"];
  let POSTSources: (typeof import("@/app/api/sources/route"))["POST"];
  let GETChanges: (typeof import("./route"))["GET"];
  let recordChangeEvent: (typeof import("@/services/memory/change-events"))["recordChangeEvent"];
  let sourceId = "";

  async function clear() {
    for (const orgId of [ORG, OTHER_ORG]) {
      for (const t of [
        "auditLog",
        "changeEvent",
        "agentCursor",
        "capability",
        "sourceFile",
        "source",
        "grant",
        "scope",
      ] as const) {
        const m = db[t] as unknown as { deleteMany: (a: unknown) => Promise<unknown> };
        if (t === "sourceFile") await m.deleteMany({ where: { source: { orgId } } });
        else await m.deleteMany({ where: { orgId } });
      }
    }
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  async function tokenOn(orgId: string, scopePath: string, agentId: string) {
    const token = `wcap_qa_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hash(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    return token;
  }

  async function feed(token: string, scope?: string) {
    const url = `http://test/api/changes${scope ? `?scope=${scope}` : ""}`;
    const res = await GETChanges(new Request(url, { headers: { authorization: `Bearer ${token}` } }));
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ hashCapabilityToken: hash } = await import("@/services/access/capabilities"));
    ({ POST: POSTSources } = await import("@/app/api/sources/route"));
    ({ GET: GETChanges } = await import("./route"));
    ({ recordChangeEvent } = await import("@/services/memory/change-events"));
    const { requireAccessContext } = await import("@/lib/access-context");
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: "user_qa" },
      ctx: { orgId: ORG, actor: { type: "human", id: "user_qa", role: "owner" } },
    } as never);
  });

  beforeEach(async () => {
    await clear();
    for (const id of [ORG, OTHER_ORG]) await db.org.create({ data: { id, name: id } });
    for (const path of [OLD_SCOPE, NEW_SCOPE]) await db.scope.create({ data: { orgId: ORG, path, name: path } });
    const s = await db.source.create({
      data: { orgId: ORG, type: "slack", externalId: "C-sales", name: "#sales", scopePath: OLD_SCOPE },
    });
    sourceId = s.id;
    // What a slack sync writes for one ingested item (lib/inngest.ts syncOneTextItem).
    await db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId: ORG,
        scopePath: OLD_SCOPE,
        recordType: "fact",
        recordId: "ep-1",
        op: "create",
        actorId: `slack-sync:${sourceId}`,
        title: SECRET,
        actorType: "extraction",
        origin: "connector-sync",
      }),
    );
    // Same actor string in another org must survive.
    await db.$transaction((tx) =>
      recordChangeEvent(tx, {
        orgId: OTHER_ORG,
        scopePath: "org_qa315b.sales",
        recordType: "fact",
        recordId: "ep-b",
        op: "create",
        actorId: `slack-sync:${sourceId}`,
        title: OTHER_SECRET,
        actorType: "extraction",
        origin: "connector-sync",
      }),
    );
  });

  afterAll(async () => {
    await clear();
  });

  it("old-scope reader sees the item text before the move (leak is observable)", async () => {
    const r = await feed(await tokenOn(ORG, OLD_SCOPE, "agent-old"));
    expect(r.status).toBe(200);
    expect(r.text).toContain("Acme renewal");
  });

  it("after a narrowing reconnect, the old-scope feed no longer carries the text", async () => {
    const res = await POSTSources(
      new Request("http://test/api/sources", {
        method: "POST",
        body: JSON.stringify({ type: "slack", channelId: "C-sales", channelName: "#sales", scopePath: NEW_SCOPE }),
      }),
    );
    expect(res.status).toBe(201);
    expect((await db.source.findUniqueOrThrow({ where: { id: sourceId } })).scopePath).toBe(NEW_SCOPE);

    // A reader granted the old scope after the move, and one held from before.
    for (const agent of ["agent-old-after", "agent-old-before"]) {
      const r = await feed(await tokenOn(ORG, OLD_SCOPE, agent));
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("Acme");
      expect(r.text).toContain("ep-1"); // event kept so cursors still resolve
    }
    // Other org's identical actor string untouched.
    const other = await db.changeEvent.findFirstOrThrow({ where: { orgId: OTHER_ORG } });
    expect(other.summary).toBe(OTHER_SECRET);
  });

  it("a reconnect that does not move the scope leaves summaries alone", async () => {
    const res = await POSTSources(
      new Request("http://test/api/sources", {
        method: "POST",
        body: JSON.stringify({ type: "slack", channelId: "C-sales", channelName: "#sales", scopePath: OLD_SCOPE }),
      }),
    );
    expect(res.status).toBe(201);
    const ev = await db.changeEvent.findFirstOrThrow({ where: { orgId: ORG, recordId: "ep-1" } });
    expect(ev.summary).toBe(SECRET);
  });
});
