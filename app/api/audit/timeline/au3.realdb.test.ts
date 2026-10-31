// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Every event GET /api/audit/timeline exports carries the six fields NIST AU-3 asks of
// an audit record, when the rows behind it were written by the
// product's own producers: check() for reads and refusals, and the change-event
// producers for a connector sync's write, a person's source connect and an agent's
// delete. Nothing here inserts an audit row or a change event by hand, so a producer
// that stops recording a field fails this test.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "au3org";
const ROOT = `org_${ORG}`;
const TEAM = `${ROOT}.team`;
const ADMIN = "u-au3-admin";
const READER = "agent-au3-reader";
const TOKEN = "au3-reader-live-token";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("the audit timeline export carries AU-3's fields, real Postgres", () => {
  let db: PrismaClient;
  let timeline: import("@/services/audit/timeline").Timeline;
  let au3: typeof import("@/services/audit/au3");

  async function wipe() {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { id: ADMIN } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    const { GET } = await import("./route");
    const { check, hashCapabilityToken } = await import("@/services/access");
    const { recordSourceItemChange } = await import("@/services/memory/content-change-event");
    const { recordSourceChange } = await import("@/services/memory/source-change-event");
    const { recordFactRemoved } = await import("@/services/memory/fact-change-event");
    au3 = await import("@/services/audit/au3");
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };

    await wipe();
    await db.org.create({ data: { id: ORG, name: "AU-3 QA" } });
    const admin = await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "a@au3.test", role: "admin", clerkId: "clerk-au3", name: "Ada Admin" },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: TEAM, name: "team" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: READER,
        tokenHash: hashCapabilityToken(TOKEN),
        scopePath: TEAM,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const from = new Date(Date.now() - 60_000);
    // Writes, each by its real producer.
    await db.$transaction((tx) =>
      recordSourceItemChange(tx, {
        orgId: ORG,
        scopePath: TEAM,
        episodeId: "ep-1",
        actorId: "slack-sync:src-1",
        authorizedById: null,
        op: "create",
        title: "standup moved to 10",
      }),
    );
    await db.$transaction((tx) =>
      recordSourceChange(tx, { id: "src-1", orgId: ORG, scopePath: TEAM, name: "#team" }, "create", ADMIN, "app"),
    );
    await recordFactRemoved({
      orgId: ORG,
      actorType: "agent",
      actorId: "agent-au3-writer",
      origin: "mcp",
      scopePath: TEAM,
      factId: "fact-1",
      removed: true,
    });
    // A read the reader's token allows, after the writes, so it is drawn as a sighting.
    const allowed = await check(
      { orgId: ORG, actor: { type: "agent", id: READER, capabilityToken: TOKEN }, origin: "mcp" },
      { action: "memory.read", scope: TEAM },
    );
    expect(allowed.allowed).toBe(true);
    // A read refused: a token that matches nothing, presented to the REST API.
    const refused = await check(
      {
        orgId: ORG,
        actor: { type: "agent", id: "agent-au3-stranger", capabilityToken: "no-such-token" },
        origin: "api",
      },
      { action: "memory.read", scope: TEAM },
    );
    expect(refused.allowed).toBe(false);

    requireAccessContext.mockResolvedValue({
      org: await db.org.findUnique({ where: { id: ORG } }),
      user: admin,
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" },
    });
    const to = new Date(Date.now() + 60_000);
    const res = await GET(
      new Request(`http://t/api/audit/timeline?scope=${TEAM}&from=${from.toISOString()}&to=${to.toISOString()}`),
    );
    expect(res.status).toBe(200);
    ({ timeline } = await res.json());
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("exports every event kind, and every event carries all six fields", () => {
    const records = au3.au3Records(timeline);
    expect(new Set(records.map((r) => r.kind))).toEqual(new Set(au3.TIMELINE_EVENT_KINDS));
    expect(records.map((r) => [r.kind, au3.au3Gaps(r.record)])).toEqual(records.map((r) => [r.kind, []]));
  });

  it("names each event's source and principal as its producer recorded them", () => {
    const summary = au3
      .au3Records(timeline)
      .map(({ record }) => [record.what, record.source, record.outcome, record.identity?.type, record.identity?.id]);
    expect(summary).toEqual([
      ["fact.create", "connector-sync", "success", "extraction", "slack-sync:src-1"],
      ["source.create", "app", "success", "human", ADMIN],
      ["fact.delete", "mcp", "success", "agent", "agent-au3-writer"],
      ["memory.read", "mcp", "allow", "agent", READER],
      ["memory.read", "mcp", "allow", "agent", READER],
      ["memory.read", "mcp", "allow", "agent", READER],
      ["memory.read", "api", "deny", "agent", "agent-au3-stranger"],
    ]);
  });
});
