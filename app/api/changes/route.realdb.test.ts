// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/changes end to end, against a real database.
//
// The route's own job is small — bearer token in, JSON out — but the ways it can
// be wrong are invisible to a mocked handler: accepting a token the access layer
// has already killed, answering 200-with-nothing where it owes a 403, or letting
// the contents of an unreadable scope show up in an error. All run for real here.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll can point DATABASE_URL
// at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-changes-route";
const SALES = "org_1.sales";
const ENGINEERING = "org_1.engineering";
const AGENT = "agent-route";

describe.skipIf(!QA_URL)("GET /api/changes against a real database", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let recordChangeEvent: (typeof import("@/services/memory/change-events"))["recordChangeEvent"];

  let token = "";

  const request = (query = "", bearer: string | null = token) =>
    new Request(`https://willder.test/api/changes${query}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });

  async function mint(opts: { agentId?: string; scopePath: string; expiresAt?: Date }): Promise<string> {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: opts.agentId ?? AGENT,
        tokenHash: hashCapabilityToken(raw),
        scopePath: opts.scopePath,
        permission: "read",
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return raw;
  }

  const writeEvent = (scopePath: string, recordId: string) =>
    db.$transaction(async (tx) =>
      recordChangeEvent(tx, {
        orgId: ORG,
        scopePath,
        recordType: "fact",
        recordId,
        op: "create",
        actorId: "writer",
        actorType: "agent",
        origin: "mcp",
        title: `change to ${recordId}`,
      }),
    );

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ recordChangeEvent } = await import("@/services/memory/change-events"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    token = await mint({ scopePath: SALES });
  });

  it("returns the caller's own scope, identified by an opaque change id", async () => {
    const mine = await writeEvent(SALES, "mine");
    await writeEvent(ENGINEERING, "not-mine");

    const res = await GET(request());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.changes.map((c: { recordId: string }) => c.recordId)).toEqual(["mine"]);
    expect(body.changes[0].id).toBe(mine.id);
    expect(body.hasMore).toBe(false);
  });

  it("puts no org-wide sequence number in the response", async () => {
    await writeEvent(SALES, "first");
    for (const n of [1, 2, 3]) await writeEvent(ENGINEERING, `hidden-${n}`);
    await writeEvent(SALES, "second");

    const body = await (await GET(request())).json();

    // Two readable changes with three unreadable writes between them: a seq on
    // either one would let the caller difference them and count those three. Pinned
    // as the whole JSON field set, so a renamed counter cannot slip back in either.
    expect(body.changes.map((c: { recordId: string }) => c.recordId)).toEqual(["first", "second"]);
    expect(Object.keys(body)).toEqual(["changes", "hasMore"]);
    for (const change of body.changes) {
      expect(Object.keys(change).sort()).toEqual([
        "actorId",
        "createdAt",
        "id",
        "op",
        "recordId",
        "recordType",
        "scopePath",
        "summary",
        "supersededById",
      ]);
    }
  });

  it("rejects a request with no bearer token", async () => {
    expect((await GET(request("", null))).status).toBe(401);
  });

  it("gives an unknown and a revoked token the same answer", async () => {
    await db.capability.updateMany({
      where: { tokenHash: hashCapabilityToken(token) },
      data: { revokedAt: new Date() },
    });

    const revoked = await GET(request());
    const unknown = await GET(request("", "wcap_never_issued"));

    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual(await unknown.json());
  });

  it("answers 403, not 200-with-nothing, for a scope the token does not cover", async () => {
    await writeEvent(ENGINEERING, "secret");

    const res = await GET(request(`?scope=${ENGINEERING}`));

    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });

  it("rejects an `after` it did not issue, without saying whether it exists", async () => {
    const hidden = await writeEvent(ENGINEERING, "not-mine");

    const foreign = await GET(request(`?after=${hidden.id}`));
    const unissued = await GET(request("?after=11111111-2222-4333-8444-555555555555"));

    expect(foreign.status).toBe(400);
    expect(unissued.status).toBe(400);
    expect(await foreign.json()).toEqual(await unissued.json());
  });

  it("rejects a limit outside the allowed range rather than silently clamping it", async () => {
    expect((await GET(request("?limit=0"))).status).toBe(400);
    expect((await GET(request("?limit=999"))).status).toBe(400);
  });

  it("resumes from the caller's own cursor across calls", async () => {
    await writeEvent(SALES, "first");
    await GET(request());
    await writeEvent(SALES, "second");

    const body = await (await GET(request())).json();

    expect(body.changes.map((c: { recordId: string }) => c.recordId)).toEqual(["second"]);
  });

  it("replays from an explicit `after`", async () => {
    const first = await writeEvent(SALES, "first");
    await writeEvent(SALES, "second");
    await GET(request());

    const body = await (await GET(request(`?after=${first.id}`))).json();

    expect(body.changes.map((c: { recordId: string }) => c.recordId)).toEqual(["second"]);
  });

  it("falls back to the token's own scope when `scope` is not a valid path", async () => {
    await writeEvent(SALES, "mine");
    await writeEvent(ENGINEERING, "not-mine");

    // resolveCallerScopePath's onInvalid: "fallback" — a malformed path must not
    // 400 and must not widen; it resolves to what the token already covers.
    const res = await GET(request("?scope=not%20an%20ltree%20path"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.changes.map((c: { recordId: string }) => c.recordId)).toEqual(["mine"]);
  });
});
