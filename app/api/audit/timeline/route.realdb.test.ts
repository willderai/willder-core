// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// GET /api/audit/timeline and GET /api/audit/timeline/:changeId against a real
// Postgres (set QA_DATABASE_URL to a migrated database). The routes run with the
// shipping check()/can() evaluator and real SQL; only the Clerk session is stubbed.
//
// What this proves that the unit tests cannot: the scope containment in both
// window queries is right in SQL (a sibling scope differing only at an `_`, a
// LIKE wildcard, stays out; an ancestor scope's read comes in), the tenant
// boundary holds, and reading a change's text writes an audit row.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "tl1";
const OTHER_ORG = "tl2";
const ROOT = `org_${ORG}`;
const CREW = `${ROOT}.crew_1c5b79`;
const WILDCARD_SIBLING = `${ROOT}.crewX1c5b79`;
const ADMIN = "u-admin-timeline";
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, seconds));

// Change ids are drawn fresh each run. change_events.id is unique across every
// org, and other real-Postgres suites share this database, so a fixed id here
// collides with any suite that picks the same literal.
const CREW_WRITE = randomUUID();
const NOTES_WRITE = randomUUID();
const SIBLING_WRITE = randomUUID();
const OTHER_ORG_WRITE = randomUUID();

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("audit timeline routes, real Postgres", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let GET_CHANGE: (typeof import("./[changeId]/route"))["GET"];

  async function wipe() {
    const orgs = { in: [ORG, OTHER_ORG] };
    await db.auditLog.deleteMany({ where: { orgId: orgs } });
    await db.changeEvent.deleteMany({ where: { orgId: orgs } });
    await db.grant.deleteMany({ where: { orgId: orgs } });
    await db.scope.deleteMany({ where: { orgId: orgs } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await db.org.deleteMany({ where: { id: orgs } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ GET: GET_CHANGE } = await import("./[changeId]/route"));
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();

    await db.org.create({ data: { id: ORG, name: "Timeline QA" } });
    await db.org.create({ data: { id: OTHER_ORG, name: "Timeline QA other" } });
    const admin = await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "a@timeline.test",
        role: "admin",
        clerkId: "clerk-timeline",
        name: "Ada Admin",
      },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    let seq = 0;
    const change = (orgId: string, id: string, actorId: string, scopePath: string, seconds: number) =>
      db.changeEvent.create({
        data: {
          id,
          orgId,
          seq: ++seq,
          scopePath,
          recordType: "fact",
          recordId: `rec-${id}`,
          op: "create",
          actorId,
          summary: `text of ${id}`,
          createdAt: at(seconds),
        },
      });
    await change(ORG, CREW_WRITE, "alpha", CREW, 0);
    await change(ORG, NOTES_WRITE, ADMIN, `${CREW}.notes`, 10);
    await change(ORG, SIBLING_WRITE, "alpha", WILDCARD_SIBLING, 20);
    await change(OTHER_ORG, OTHER_ORG_WRITE, "alpha", CREW, 30);

    const read = (
      orgId: string,
      actorId: string,
      target: string,
      seconds: number,
      decision: "allow" | "deny" = "allow",
    ) =>
      db.auditLog.create({
        data: { orgId, actorType: "agent", actorId, action: "memory.read", target, decision, at: at(seconds) },
      });
    await read(ORG, "beta", CREW, 6);
    await read(ORG, "gamma", ROOT, 13); // an ancestor of CREW: covers both crew writes
    await read(ORG, "delta", `${WILDCARD_SIBLING}/query:x`, 21);
    await read(ORG, "delta", `${CREW}/query:pricing`, 22, "deny");
    await read(OTHER_ORG, "beta", CREW, 31);
    // Outside CREW, differing only at the `_` a LIKE treats as a wildcard, one
    // level below the sibling so the dot-descendant leg is exercised too.
    await read(ORG, "outsider", `${WILDCARD_SIBLING}.deep/query:y`, 23, "deny");

    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: admin,
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  const WINDOW = `from=${at(-60).toISOString()}&to=${at(120).toISOString()}`;

  async function timelineFor(scope: string) {
    const res = await GET(new Request(`http://t/api/audit/timeline?scope=${scope}&${WINDOW}`));
    expect(res.status).toBe(200);
    return (await res.json()).timeline;
  }

  it("lists the scope's writes and nothing from a wildcard sibling or another org", async () => {
    const timeline = await timelineFor(CREW);
    expect(timeline.writes.map((w: { recordId: string }) => w.recordId)).toEqual([
      `rec-${CREW_WRITE}`,
      `rec-${NOTES_WRITE}`,
    ]);
    expect(JSON.stringify(timeline)).not.toContain("text of");
  });

  it("draws first sight from in-scope and ancestor reads, and shows the denial", async () => {
    const timeline = await timelineFor(CREW);
    const edges = timeline.sightings.map((s: { laneKey: string; latencyMs: number }) => [s.laneKey, s.latencyMs]);
    expect(edges).toEqual([
      ["agent:beta", 6000],
      ["agent:gamma", 13000],
      ["agent:gamma", 3000],
    ]);
    expect(timeline.denials.map((d: { laneKey: string }) => d.laneKey)).toEqual(["agent:delta"]);
    expect(timeline.lanes.find((l: { key: string }) => l.key === `human:${ADMIN}`).name).toBe("Ada Admin");
  });

  it("keeps a wildcard sibling's reads out of the scope's lanes and denials", async () => {
    // First sight re-checks coverage in memory, so only lanes and denials show
    // whether the read query's own containment held.
    const timeline = await timelineFor(CREW);
    expect(timeline.lanes.map((l: { key: string }) => l.key)).not.toContain("agent:outsider");
    expect(timeline.denials.map((d: { laneKey: string }) => d.laneKey)).not.toContain("agent:outsider");
  });

  it("rejects a scope outside the org with a 400", async () => {
    const res = await GET(new Request(`http://t/api/audit/timeline?scope=org_${OTHER_ORG}&${WINDOW}`));
    expect(res.status).toBe(400);
  });

  it("returns a change's text through an audited read, and 404s outside the scope", async () => {
    const before = await db.auditLog.count({ where: { orgId: ORG, actorId: ADMIN, action: "memory.read" } });
    const ok = await GET_CHANGE(new Request(`http://t/api/audit/timeline/x?scope=${CREW}`), {
      params: Promise.resolve({ changeId: CREW_WRITE }),
    });
    expect(ok.status).toBe(200);
    // No Agent row exists for the actor key "alpha", so the writer name comes from
    // fallbackAgentName(), which shows a free-text key as itself, marked as a token.
    expect(await ok.json()).toMatchObject({ summary: `text of ${CREW_WRITE}`, writer: '"alpha" (agent token)' });
    const after = await db.auditLog.count({ where: { orgId: ORG, actorId: ADMIN, action: "memory.read" } });
    expect(after).toBe(before + 1);

    const outside = await GET_CHANGE(new Request(`http://t/api/audit/timeline/x?scope=${CREW}`), {
      params: Promise.resolve({ changeId: SIBLING_WRITE }),
    });
    expect(outside.status).toBe(404);
    const otherOrg = await GET_CHANGE(new Request(`http://t/api/audit/timeline/x?scope=${CREW}`), {
      params: Promise.resolve({ changeId: OTHER_ORG_WRITE }),
    });
    expect(otherOrg.status).toBe(404);

    const otherOrgScope = await GET_CHANGE(new Request(`http://t/api/audit/timeline/x?scope=org_${OTHER_ORG}`), {
      params: Promise.resolve({ changeId: OTHER_ORG_WRITE }),
    });
    expect(otherOrgScope.status).toBe(400);
  });

  it("names the person an agent's write acted for, from the allow row that authorized it", async () => {
    const row = await db.auditLog.create({
      data: {
        orgId: ORG,
        actorType: "agent",
        actorId: "alpha",
        action: "memory.write",
        target: `${CREW}/fact`,
        decision: "allow",
        metadata: { triggeredBy: ADMIN },
        at: at(40),
      },
    });
    const id = randomUUID();
    await db.changeEvent.create({
      data: {
        id,
        orgId: ORG,
        seq: 100,
        scopePath: CREW,
        recordType: "fact",
        recordId: `rec-${id}`,
        op: "create",
        actorId: "alpha",
        actorType: "agent",
        summary: "an agent's write",
        authorizedById: row.id,
        createdAt: at(40),
      },
    });
    const res = await GET_CHANGE(new Request(`http://t/api/audit/timeline/x?scope=${CREW}`), {
      params: Promise.resolve({ changeId: id }),
    });
    expect(await res.json()).toMatchObject({
      writer: '"alpha" (agent token)',
      actingFor: "Ada Admin",
      authorizationKind: "direct",
    });
  });

  it("finds the change that wrote each version, only inside the scope and only for a create or update", async () => {
    const { changesThatWroteRecords } = await import("@/services/memory/change-history");
    const write = (
      orgId: string,
      seq: number,
      recordId: string,
      op: "create" | "update" | "delete",
      scopePath: string,
    ) =>
      db.changeEvent.create({
        data: {
          id: randomUUID(),
          orgId,
          seq,
          scopePath,
          recordType: "fact",
          recordId,
          op,
          actorId: "alpha",
          summary: `${op} ${recordId}`,
          createdAt: at(50),
        },
      });
    const kept = await write(ORG, 200, "ver-kept", "create", `${CREW}.notes`);
    const updated = await write(ORG, 201, "ver-kept", "update", CREW);
    await write(ORG, 202, "ver-kept", "delete", CREW);
    await write(ORG, 203, "ver-sibling", "create", WILDCARD_SIBLING);
    await write(OTHER_ORG, 204, "ver-other", "create", CREW);

    const found = await changesThatWroteRecords(ORG, CREW, ["ver-kept", "ver-sibling", "ver-other", "ver-none"]);
    // The latest create or update wins; the later delete wrote no version.
    expect(kept.id).not.toBe(updated.id);
    expect([...found.entries()]).toEqual([["ver-kept", { id: updated.id, summary: "update ver-kept" }]]);
  });
});
