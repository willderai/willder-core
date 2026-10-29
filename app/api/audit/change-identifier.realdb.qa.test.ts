// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// QA for "a change names the visible audit row that authorized it", end to end against
// real Postgres. The companion change-identifier.test.ts mocks the database, so it cannot
// show that the write paths actually stamp the row id onto the stored change event, nor
// that the tenant filter on the lookup holds in real SQL.
//
// Real: check()/can(), GET /api/audit, GET /api/audit/timeline/:changeId, POST
// /api/memory/facts, PATCH /api/memory/facts/:id, GuardedMemoryStore.removeFact,
// recordIngestApplied, recordFactRemoved. Faked: the Clerk session, the memory backend's
// removeFact, and the Inngest send (which here lands the write synchronously through the
// real recordIngestApplied, the step the worker runs once the store write resolved).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { MemoryStore } from "@/services/memory/memory-store";
import type { IngestInput, RemoveFactInput } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "case413a";
const OTHER_ORG = "case413b";
const ROOT = `org_${ORG}`;
const DEAL_A = `${ROOT}.deal_a`;
const DEAL_B = `${ROOT}.deal_b`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const WRITER = "u-case413-writer";
const ADMIN = "u-case413-admin";
const OTHER_ADMIN = "u-case413b-admin";
const FACT = "fact-case413";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

const landed = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/inngest", () => ({
  ingestMemory: vi.fn(async (input: IngestInput) => {
    const { recordIngestApplied } = await import("@/services/memory/fact-change-event");
    await recordIngestApplied(input, `ep-case413-${++landed.n}`);
  }),
}));

const stored = vi.hoisted(() => ({ facts: new Set<string>() }));
const removeFact = vi.hoisted(() =>
  vi.fn(async (input: RemoveFactInput) => ({
    removed: stored.facts.delete(`${input.tenantId}|${input.groupId}|${input.factId}`),
  })),
);
vi.mock("@/services/memory", async () => {
  const { GuardedMemoryStore } = await import("@/services/memory/guarded-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  return { guardedMemory: new GuardedMemoryStore({ removeFact } as unknown as MemoryStore), MemoryServiceError };
});

describe.skipIf(!QA_URL)("change identifier on the visible audit row, real Postgres", () => {
  let db: PrismaClient;
  let AUDIT: (typeof import("./route"))["GET"];
  let CHANGE: (typeof import("./timeline/[changeId]/route"))["GET"];
  let POST_FACT: (typeof import("../memory/facts/route"))["POST"];
  let PATCH_FACT: (typeof import("../memory/facts/[id]/route"))["PATCH"];
  let POST_INGEST: (typeof import("../memory/ingest/route"))["POST"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  const as = (orgId: string, userId: string, role: "admin" | "member") =>
    requireAccessContext.mockResolvedValue({
      org: { id: orgId },
      user: { id: userId, name: userId },
      ctx: { orgId, actor: { type: "human", id: userId, role } },
    });

  const auditEntries = async () => {
    const res = await AUDIT(new Request("http://t/api/audit"));
    expect(res.status).toBe(200);
    return ((await res.json()) as { entries: { id: string; action: string; changeIds: string[] }[] }).entries;
  };
  const change = (changeId: string, scope: string) =>
    CHANGE(new Request(`http://t/api/audit/timeline/x?scope=${scope}`), { params: Promise.resolve({ changeId }) });

  const orgs = [ORG, OTHER_ORG];
  async function wipe() {
    await db.changeEvent.deleteMany({ where: { orgId: { in: orgs } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    await db.grant.deleteMany({ where: { orgId: { in: orgs } } });
    await db.scope.deleteMany({ where: { orgId: { in: orgs } } });
    await db.user.deleteMany({ where: { orgId: { in: orgs } } });
    await db.org.deleteMany({ where: { id: { in: orgs } } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET: AUDIT } = await import("./route"));
    ({ GET: CHANGE } = await import("./timeline/[changeId]/route"));
    ({ POST: POST_FACT } = await import("../memory/facts/route"));
    ({ PATCH: PATCH_FACT } = await import("../memory/facts/[id]/route"));
    ({ POST: POST_INGEST } = await import("../memory/ingest/route"));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await wipe();
    for (const id of orgs) await db.org.create({ data: { id, name: `QA 413 ${id}` } });
    for (const [id, orgId, role] of [
      [WRITER, ORG, "member"],
      [ADMIN, ORG, "admin"],
      [OTHER_ADMIN, OTHER_ORG, "admin"],
    ] as const) {
      await db.user.create({ data: { id, orgId, email: `${id}@case413.test`, role, clerkId: `clerk-${id}` } });
    }
    const scope = async (orgId: string, path: string) =>
      (await db.scope.create({ data: { orgId, path, name: path } })).id;
    const root = await scope(ORG, ROOT);
    const dealA = await scope(ORG, DEAL_A);
    await scope(ORG, DEAL_B);
    const otherRoot = await scope(OTHER_ORG, OTHER_ROOT);
    await db.grant.create({
      data: { orgId: ORG, scopeId: dealA, granteeType: "user", granteeId: WRITER, permission: "write" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.grant.create({
      data: { orgId: OTHER_ORG, scopeId: otherRoot, granteeType: "user", granteeId: OTHER_ADMIN, permission: "admin" },
    });
  });

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: { in: orgs } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: orgs } } });
    stored.facts = new Set([`${ORG}|${DEAL_A}|${FACT}`]);
  });

  async function writeFactAsWriter(): Promise<{ rowId: string; changeId: string }> {
    as(ORG, WRITER, "member");
    const res = await POST_FACT(
      new Request("http://t/api/memory/facts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact: "Renewal is due in March.", scope: DEAL_A }),
      }),
    );
    expect(res.status).toBe(202);
    const [row] = await db.auditLog.findMany({ where: { orgId: ORG, action: "memory.write", decision: "allow" } });
    const [event] = await db.changeEvent.findMany({ where: { orgId: ORG } });
    return { rowId: row!.id, changeId: event!.id };
  }

  it("a fact written through POST /api/memory/facts stores its allow row on the change event, and the audit row names it", async () => {
    const { rowId, changeId } = await writeFactAsWriter();
    expect((await db.changeEvent.findUniqueOrThrow({ where: { id: changeId } })).authorizedById).toBe(rowId);

    as(ORG, ADMIN, "admin");
    const entries = await auditEntries();
    expect(entries.find((e) => e.id === rowId)?.changeIds).toEqual([changeId]);
    // The confirmed-applied row is not shown, and no other visible row claims the change.
    expect(entries.filter((e) => e.changeIds.includes(changeId)).map((e) => e.id)).toEqual([rowId]);
  });

  it("the change's detail names its row inside its scope, and 404s in a sibling scope exactly as an absent change does", async () => {
    const { rowId, changeId } = await writeFactAsWriter();
    as(ORG, ADMIN, "admin");

    const ok = await change(changeId, DEAL_A);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ authorizedById: rowId });

    const sibling = await change(changeId, DEAL_B);
    const absent = await change("00000000-0000-4000-8000-0000000004130", DEAL_B);
    expect(sibling.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(await sibling.json()).toEqual(await absent.json());
  });

  it("another tenant's admin can neither read the change nor see its id on any audit row", async () => {
    const { changeId } = await writeFactAsWriter();
    as(OTHER_ORG, OTHER_ADMIN, "admin");

    const foreign = await change(changeId, OTHER_ROOT);
    const absent = await change("00000000-0000-4000-8000-0000000004131", OTHER_ROOT);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await absent.json());
    const entries = await auditEntries();
    expect(entries.flatMap((e) => e.changeIds)).not.toContain(changeId);
  });

  it("never attaches another tenant's change event to this tenant's row, even when it names the row's id", async () => {
    const { rowId, changeId } = await writeFactAsWriter();
    const forged = await db.changeEvent.create({
      data: {
        orgId: OTHER_ORG,
        seq: 1,
        scopePath: OTHER_ROOT,
        recordType: "fact",
        recordId: "ep-forged",
        op: "create",
        actorId: OTHER_ADMIN,
        summary: "forged",
        authorizedById: rowId,
      },
    });
    as(ORG, ADMIN, "admin");
    const entries = await auditEntries();
    expect(entries.find((e) => e.id === rowId)?.changeIds).toEqual([changeId]);
    expect(entries.flatMap((e) => e.changeIds)).not.toContain(forged.id);
  });

  it("a correction is one memory.delete row naming both changes it produced, supersede then create", async () => {
    as(ORG, WRITER, "member");
    const res = await PATCH_FACT(
      new Request(`http://t/api/memory/facts/${FACT}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact: "Renewal is due in April.", scope: DEAL_A }),
      }),
      { params: Promise.resolve({ id: FACT }) },
    );
    expect(res.status).toBe(202);

    const deletes = await db.auditLog.findMany({ where: { orgId: ORG, action: "memory.delete", decision: "allow" } });
    expect(deletes).toHaveLength(1);
    const events = await db.changeEvent.findMany({ where: { orgId: ORG }, orderBy: { seq: "asc" } });
    expect(events.map((e) => [e.op, e.authorizedById])).toEqual([
      ["supersede", deletes[0]!.id],
      ["create", deletes[0]!.id],
    ]);

    as(ORG, ADMIN, "admin");
    const entries = await auditEntries();
    expect(entries.find((e) => e.id === deletes[0]!.id)?.changeIds).toEqual(events.map((e) => e.id));
  });

  it("POST /api/memory/ingest stamps its own memory.write allow row on the change it lands", async () => {
    as(ORG, WRITER, "member");
    const res = await POST_INGEST(
      new Request("http://t/api/memory/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "The pilot starts on Monday.", scope: DEAL_A }),
      }),
    );
    expect(res.status).toBe(202);
    const [row] = await db.auditLog.findMany({ where: { orgId: ORG, action: "memory.write", decision: "allow" } });
    const [event] = await db.changeEvent.findMany({ where: { orgId: ORG } });
    expect(event!.authorizedById).toBe(row!.id);
  });

  it("a denied write and a read produce no change id", async () => {
    as(ORG, WRITER, "member");
    const denied = await POST_FACT(
      new Request("http://t/api/memory/facts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fact: "Outside my scope.", scope: DEAL_B }),
      }),
    );
    expect(denied.status).toBe(403);
    as(ORG, ADMIN, "admin");
    const entries = await auditEntries();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.changeIds.length === 0)).toBe(true);
  });
});
