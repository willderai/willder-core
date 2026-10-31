// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// POST /api/memory/ingest with an Idempotency-Key header, against a real database: unit
// tests, a few rows each.
//
// The REST ingest is the human-facing twin of memory_ingest. Its content is rewritten by
// entity resolution before it is stored, so it never takes the request path's
// content-keyed store write: before the header existed, every retry queued another job and
// stored the note again. The claim here: one key, one queued write; the same key with a
// different body is refused with 422; calls arriving together queue once.
//
// Real: the route handler, check() and Postgres. Doubles: the session (an org admin) and
// ingestMemory, which counts the writes the route hands on.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the inherited DATABASE_URL.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => ({ readableNow: false })) }));

const QA_URL = process.env.QA_DATABASE_URL;

// Letters only: the org id becomes an ltree label in its root scope path.
const ORG = "restIngestKey";
const ROOT = `org_${ORG}`;
const ADMIN = "u-rest-ingest-admin";
const OTHER_ADMIN = "u-rest-ingest-other-admin";

describe.skipIf(!QA_URL)("POST /api/memory/ingest with an Idempotency-Key, real Postgres", () => {
  let db: PrismaClient;
  let POST: (typeof import("./route"))["POST"];
  let requireAccessContext: ReturnType<typeof vi.fn>;
  let ingestMemory: ReturnType<typeof vi.fn>;

  const as = (userId: string) =>
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: userId, name: userId },
      ctx: { orgId: ORG, actor: { type: "human", id: userId, role: "admin" }, origin: "app" },
    });

  const post = (body: Record<string, unknown>, key?: string) =>
    POST(
      new Request("http://t/api/memory/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key === undefined ? {} : { "idempotency-key": key }) },
        body: JSON.stringify(body),
      }),
    );

  const note = { content: "Acme renewed its contract for 2027.", name: "Acme Corp" };

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ requireAccessContext } = (await import("@/lib/access-context")) as unknown as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    });
    ({ ingestMemory } = (await import("@/lib/inngest")) as unknown as { ingestMemory: ReturnType<typeof vi.fn> });
    ({ POST } = await import("./route"));
  });

  async function removeOrg(): Promise<void> {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  afterAll(async () => {
    await removeOrg();
    await db.$disconnect();
  });

  beforeEach(async () => {
    ingestMemory.mockClear();
    await removeOrg();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    for (const id of [ADMIN, OTHER_ADMIN]) {
      await db.user.create({
        data: { id, orgId: ORG, email: `${id}@ingest-key.test`, role: "admin", clerkId: `clerk-${id}` },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: id, permission: "admin" },
      });
    }
    as(ADMIN);
  });

  it("a request retried three times with one key queues one write and answers each retry alike", async () => {
    const responses = [];
    for (let i = 0; i < 3; i++) responses.push(await post(note, "rest-renewal-1"));

    expect(responses.map((r) => r.status)).toEqual([202, 202, 202]);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(ingestMemory).toHaveBeenCalledTimes(1);
  });

  it("refuses the key reused with a different body: 422, naming the fix, nothing queued", async () => {
    await post(note, "rest-renewal-2");
    const reused = await post({ ...note, content: "Acme cancelled its contract." }, "rest-renewal-2");

    expect(reused.status).toBe(422);
    expect((await reused.json()).error).toMatch(/Idempotency-Key .*different write.*new Idempotency-Key/i);
    expect(ingestMemory).toHaveBeenCalledTimes(1);
  });

  it("queues once when requests with one key arrive together", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    ingestMemory.mockImplementation(async () => {
      await held;
      return { readableNow: false };
    });
    const requests = Array.from({ length: 5 }, () => post(note, "rest-renewal-burst"));
    await vi.waitFor(() => expect(ingestMemory).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const responses = await Promise.all(requests);

    expect(ingestMemory).toHaveBeenCalledTimes(1);
    for (const response of responses) expect([202, 409]).toContain(response.status);
    ingestMemory.mockImplementation(async () => ({ readableNow: false }));
  });

  it("keeps each person's keys to themselves", async () => {
    await post(note, "rest-shared-key");
    as(OTHER_ADMIN);
    const other = await post({ ...note, content: "Acme moved its renewal to Q3." }, "rest-shared-key");

    expect(other.status).toBe(202);
    expect(ingestMemory).toHaveBeenCalledTimes(2);
  });

  it("refuses an empty or oversized key with 400 before anything is queued", async () => {
    expect((await post(note, " ")).status).toBe(400);
    expect((await post(note, "k".repeat(256))).status).toBe(400);
    expect(ingestMemory).not.toHaveBeenCalled();
  });
});
