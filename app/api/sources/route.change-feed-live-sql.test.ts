// Real-Postgres tests for the source routes' change-feed events.
//
// The claim: connecting or disconnecting a source writes the Source row and its
// `change_events` row in one transaction, with the event's scope read off the stored
// row. A transaction double has no rollback to fail, so this runs the real routes
// against a real database, replacing only the auth context. To prove the two writes
// share a transaction, the event helper can be told to throw after its insert; the
// assertion is that the Source write it followed does not survive.
//
// Set QA_DATABASE_URL to an ISOLATED test database. It is assigned to DATABASE_URL
// below because lib/db.ts reads that at import time -- never point this at the
// sandbox's inherited DATABASE_URL, which is live Neon (item
// routine-sandbox-prod-db-url). Skips cleanly when unset.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMember } from "@/services/access/member.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
if (QA_URL) process.env.DATABASE_URL = QA_URL;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
// The only remote a disconnect calls. Nothing under test lives behind it.
vi.mock("@/services/memory/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/store")>()),
  graphitiStore: { removeGroupFacts: vi.fn(async () => ({ removedCount: 0 })) },
}));

/** When set, the event helper throws right after its own insert has run. */
const failAfterEvent = { on: false };
vi.mock("@/services/memory/source-change-event", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory/source-change-event")>();
  return {
    ...actual,
    recordSourceChange: async (...args: Parameters<typeof actual.recordSourceChange>) => {
      const event = await actual.recordSourceChange(...args);
      if (failAfterEvent.on) throw new Error("injected failure after the change event insert");
      return event;
    },
  };
});

const ORG = "orgSourceChangeFeed";
const ROOT = `org_${ORG}`;
const SCOPE_A = `${ROOT}.team_a`;
const USER = "user_source_feed_admin";
const DOMAIN = "feed-test.example.com";

describe.skipIf(!QA_URL)("source routes append change events: real Postgres", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let db: any, POST: any, DELETE: any, requireAccessContext: any;

  beforeAll(async () => {
    ({ db } = await import("@/lib/db"));
    ({ POST } = await import("./route"));
    ({ DELETE } = await import("./[id]/route"));
    ({ requireAccessContext } = await import("@/lib/access-context"));
    await db.$executeRawUnsafe(
      `INSERT INTO "orgs" ("id","name","updatedAt") VALUES ($1,$1,NOW()) ON CONFLICT ("id") DO NOTHING`,
      ORG,
    );
  });

  beforeEach(async () => {
    failAfterEvent.on = false;
    for (const table of ["change_events", "sources", "audit_log", "grants", "scopes"]) {
      await db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "orgId" = $1`, ORG);
    }
    await db.$executeRawUnsafe(
      `INSERT INTO "scopes" ("id","orgId","path","name") VALUES ('sc_feed_root',$1,$2,'root'),
         ('sc_feed_a',$1,$3,'a')`,
      ORG,
      ROOT,
      SCOPE_A,
    );
    await seedMember(db, { orgId: ORG, userId: USER });
    await db.$executeRawUnsafe(
      `INSERT INTO "grants" ("id","orgId","scopeId","granteeType","granteeId","permission")
       VALUES ('g_feed_admin',$1,'sc_feed_a','user',$2,'admin')`,
      ORG,
      USER,
    );
    vi.mocked(requireAccessContext).mockResolvedValue({
      org: { id: ORG },
      user: { id: USER },
      ctx: { orgId: ORG, actor: { type: "human", id: USER, role: "member" } },
    } as never);
  });

  afterAll(async () => {
    await db?.$disconnect?.();
  });

  const connect = () =>
    POST(
      new Request("http://test/api/sources", {
        method: "POST",
        body: JSON.stringify({ type: "website", domain: DOMAIN, scopePath: SCOPE_A }),
      }),
    );

  const disconnect = (id: string) =>
    DELETE(new Request(`http://test/api/sources/${id}`, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });

  const events = () => db.changeEvent.findMany({ where: { orgId: ORG }, orderBy: { seq: "asc" } });

  it("a first connect commits the source and one create event in its stored scope", async () => {
    const res = await connect();
    expect(res.status).toBe(201);
    const { source } = await res.json();

    const written = await events();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      recordType: "source",
      recordId: source.id,
      op: "create",
      scopePath: SCOPE_A,
      actorId: USER,
      summary: DOMAIN,
    });
  });

  it("a reconnect of the same source is an update of the same record", async () => {
    await connect();
    await connect();

    const written = await events();
    expect(written.map((e: { op: string }) => e.op)).toEqual(["create", "update"]);
    expect(written[1].recordId).toBe(written[0].recordId);
  });

  it("a disconnect is an update of the kept row, in the scope the source was in", async () => {
    const { source } = await (await connect()).json();

    expect((await disconnect(source.id)).status).toBe(200);

    const written = await events();
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({ recordId: source.id, op: "update", scopePath: SCOPE_A });
  });

  // Guard-removal check: moving either route's Source write out of the transaction
  // turns these red, because the write would commit before the injected failure.
  it("a connect whose event transaction fails leaves no source and no event", async () => {
    failAfterEvent.on = true;

    await expect(connect()).rejects.toThrow("injected failure");

    expect(await db.source.count({ where: { orgId: ORG } })).toBe(0);
    expect(await events()).toHaveLength(0);
  });

  it("a disconnect whose event transaction fails leaves the source connected", async () => {
    const { source } = await (await connect()).json();
    failAfterEvent.on = true;

    await expect(disconnect(source.id)).rejects.toThrow("injected failure");

    const stored = await db.source.findUnique({ where: { id: source.id } });
    expect(stored.status).toBe("active");
    expect(await events()).toHaveLength(1);
  });
});
