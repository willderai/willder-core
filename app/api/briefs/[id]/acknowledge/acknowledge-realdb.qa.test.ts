// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Brief acknowledgement against a real database.
//
// The mocked route tests stub `@/lib/db` and `@/services/access`. They prove
// the route's control flow and the arguments it passes, not the storage
// boundary underneath: the `orgId` filter in `latestBriefAcknowledgement()`,
// the target tagging that keeps one brief's acknowledgement out of another's
// read-back, and the central safety claim -- that a `brief.acknowledged` row
// can never itself trip the flag -- are all asserted against a `vi.fn()` that
// returns whatever the test told it to.
//
// This file calls the SHIPPING functions against a REAL Postgres 16 with ltree
// and the real access evaluator, with TWO tenants and TWO scopes, and asserts
// on the rows the database actually returns. Each case fails when its
// matching guard is removed.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited
// DATABASE_URL that points at a live database. Skips cleanly without it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-125";
const OTHER_ORG = "org-qa-125-other";

// Both orgs deliberately use the SAME scope path and the SAME brief id, so the
// only thing separating their acknowledgements is the tenant filter itself.
const SCOPE = "org_1.sales";
const SIBLING_SCOPE = "org_1.engineering";
const BRIEF_ID = "B-qa-125";

const GRANTED_READER = "u-125-granted";
const UNGRANTED_READER = "u-125-ungranted";
const OTHER_ORG_READER = "u-125-other-org";

const BRIEF_CREATED_AT = new Date("2026-09-01T00:00:00Z");

type Actor = { orgId: string; actor: { type: "human"; id: string; role: "member" } };
const actorFor = (orgId: string, userId: string): Actor => ({
  orgId,
  actor: { type: "human", id: userId, role: "member" },
});

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));

describe.skipIf(!QA_URL)("brief acknowledgement against real Postgres", () => {
  let db: PrismaClient;
  let POST: (typeof import("./route"))["POST"];
  let check: (typeof import("@/services/access"))["check"];
  let auditChangesUnderScope: (typeof import("@/services/access"))["auditChangesUnderScope"];
  let recordBriefAcknowledgement: (typeof import("@/services/access"))["recordBriefAcknowledgement"];
  let latestBriefAcknowledgement: (typeof import("@/services/access"))["latestBriefAcknowledgement"];
  let requireAccessContext: ReturnType<typeof vi.fn>;

  const tenantTables = ["auditLog", "brief", "grant", "scope", "user"] as const;

  async function clearTenants() {
    for (const orgId of [ORG, OTHER_ORG]) {
      for (const table of tenantTables) {
        await (db[table] as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where: { orgId } });
      }
    }
    await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
  }

  /** Every `brief.acknowledged` row this org holds, oldest first. */
  async function ackRows(orgId: string) {
    return db.auditLog.findMany({
      where: { orgId, action: "brief.acknowledged" },
      orderBy: { at: "asc" },
      select: { actorId: true, target: true, metadata: true, at: true },
    });
  }

  const request = () => new Request("http://qa.test/api/briefs/B-qa-125/acknowledge", { method: "POST" });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST } = await import("./route"));
    ({ check, auditChangesUnderScope, recordBriefAcknowledgement, latestBriefAcknowledgement } = await import(
      "@/services/access"
    ));
    ({ requireAccessContext } = (await import("@/lib/access-context")) as never);

    await clearTenants();

    for (const orgId of [ORG, OTHER_ORG]) {
      await db.org.create({ data: { id: orgId, name: orgId } });
      // Identical scope paths and brief ids in both tenants, on purpose.
      await db.scope.create({ data: { orgId, path: SCOPE, name: "sales" } });
      await db.brief.create({
        data: {
          id: `${BRIEF_ID}-${orgId}`,
          orgId,
          type: "handoff",
          scopePath: SCOPE,
          title: "t",
          summary: "s",
          sections: {},
          createdAt: BRIEF_CREATED_AT,
        },
      });
    }

    const siblingScope = await db.scope.create({ data: { orgId: ORG, path: SIBLING_SCOPE, name: "eng" } });
    const briefScope = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: SCOPE } });

    await db.user.create({
      data: { id: GRANTED_READER, orgId: ORG, email: "granted@qa.test", role: "member", clerkId: "clerk-125-a" },
    });
    await db.user.create({
      data: { id: UNGRANTED_READER, orgId: ORG, email: "ungranted@qa.test", role: "member", clerkId: "clerk-125-b" },
    });
    await db.user.create({
      data: { id: OTHER_ORG_READER, orgId: OTHER_ORG, email: "other@qa.test", role: "member", clerkId: "clerk-125-c" },
    });

    await db.grant.create({
      data: { orgId: ORG, scopeId: briefScope.id, granteeType: "user", granteeId: GRANTED_READER, permission: "read" },
    });
    // The ungranted reader is a real member of the same org holding a real
    // grant -- on a SIBLING scope only. This is the revoked-grantee shape, not
    // an anonymous user.
    await db.grant.create({
      data: {
        orgId: ORG,
        scopeId: siblingScope.id,
        granteeType: "user",
        granteeId: UNGRANTED_READER,
        permission: "read",
      },
    });
  });

  afterAll(async () => {
    await clearTenants();
    await db.$disconnect();
  });

  describe("the evaluator itself, before any route call", () => {
    it("allows the granted reader and denies the sibling-scope-only reader on the brief's scope", async () => {
      const allowed = await check(actorFor(ORG, GRANTED_READER) as never, {
        action: "memory.read",
        scope: SCOPE,
      });
      const denied = await check(actorFor(ORG, UNGRANTED_READER) as never, {
        action: "memory.read",
        scope: SCOPE,
      });
      expect(allowed.allowed).toBe(true);
      expect(denied.allowed).toBe(false);
    });
  });

  describe("POST /api/briefs/:id/acknowledge", () => {
    it("permits the granted reader and persists exactly one acknowledgement row", async () => {
      requireAccessContext.mockResolvedValue({
        org: { id: ORG },
        user: { id: GRANTED_READER },
        ctx: actorFor(ORG, GRANTED_READER),
      } as never);

      const res = await POST(request(), params(`${BRIEF_ID}-${ORG}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.stale).toBe(false);
      expect(typeof body.acknowledgedAt).toBe("string");

      const rows = await ackRows(ORG);
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(GRANTED_READER);
      expect(rows[0].target).toBe(`${SCOPE}/brief:${BRIEF_ID}-${ORG}/acknowledged`);
      expect(rows[0].metadata).toMatchObject({ stale: false });
    });

    it("refuses the sibling-scope-only reader with the not-found response, and writes NO row attributing an acknowledgement to them", async () => {
      requireAccessContext.mockResolvedValue({
        org: { id: ORG },
        user: { id: UNGRANTED_READER },
        ctx: actorFor(ORG, UNGRANTED_READER),
      } as never);

      const res = await POST(request(), params(`${BRIEF_ID}-${ORG}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "brief not found" });

      const rows = await ackRows(ORG);
      expect(rows.map((r) => r.actorId)).toEqual([GRANTED_READER]);
    });

    it("cannot reach another tenant's brief by id, and writes nothing there", async () => {
      requireAccessContext.mockResolvedValue({
        org: { id: OTHER_ORG },
        user: { id: OTHER_ORG_READER },
        ctx: actorFor(OTHER_ORG, OTHER_ORG_READER),
      } as never);

      const res = await POST(request(), params(`${BRIEF_ID}-${ORG}`));
      expect(res.status).toBe(404);
      expect(await ackRows(OTHER_ORG)).toHaveLength(0);
    });
  });

  describe("latestBriefAcknowledgement() read-back", () => {
    it("does not return one tenant's acknowledgement to the other, for the same scope and brief id", async () => {
      // Both tenants hold an acknowledgement written under the identical scope
      // path and brief id string; only orgId separates them.
      await recordBriefAcknowledgement({
        orgId: OTHER_ORG,
        scopePath: SCOPE,
        briefId: `${BRIEF_ID}-shared`,
        actorType: "human",
        actorId: OTHER_ORG_READER,
        origin: "app",
        stale: true,
      });
      await recordBriefAcknowledgement({
        orgId: ORG,
        scopePath: SCOPE,
        briefId: `${BRIEF_ID}-shared`,
        actorType: "human",
        actorId: GRANTED_READER,
        origin: "app",
        stale: false,
      });

      const mine = await latestBriefAcknowledgement({
        orgId: ORG,
        scopePath: SCOPE,
        briefId: `${BRIEF_ID}-shared`,
      });
      const theirs = await latestBriefAcknowledgement({
        orgId: OTHER_ORG,
        scopePath: SCOPE,
        briefId: `${BRIEF_ID}-shared`,
      });

      // Each tenant sees its own verdict, not the other's.
      expect(mine?.stale).toBe(false);
      expect(theirs?.stale).toBe(true);
    });

    it("does not return an acknowledgement recorded under a different scope for the same brief id", async () => {
      await recordBriefAcknowledgement({
        orgId: ORG,
        scopePath: SIBLING_SCOPE,
        briefId: `${BRIEF_ID}-scoped`,
        actorType: "human",
        actorId: GRANTED_READER,
        origin: "app",
        stale: true,
      });

      expect(
        await latestBriefAcknowledgement({ orgId: ORG, scopePath: SCOPE, briefId: `${BRIEF_ID}-scoped` }),
      ).toBeNull();
      expect(
        (await latestBriefAcknowledgement({ orgId: ORG, scopePath: SIBLING_SCOPE, briefId: `${BRIEF_ID}-scoped` }))
          ?.stale,
      ).toBe(true);
    });

    it("returns the most recent acknowledgement when a brief is acknowledged twice", async () => {
      const briefId = `${BRIEF_ID}-twice`;
      const first = await recordBriefAcknowledgement({
        orgId: ORG,
        scopePath: SCOPE,
        briefId,
        actorType: "human",
        actorId: GRANTED_READER,
        origin: "app",
        stale: false,
      });
      await db.auditLog.update({ where: { id: first.id }, data: { at: new Date("2026-09-10T00:00:00Z") } });
      const second = await recordBriefAcknowledgement({
        orgId: ORG,
        scopePath: SCOPE,
        briefId,
        actorType: "human",
        actorId: GRANTED_READER,
        origin: "app",
        stale: true,
      });
      await db.auditLog.update({ where: { id: second.id }, data: { at: new Date("2026-09-11T00:00:00Z") } });

      const latest = await latestBriefAcknowledgement({ orgId: ORG, scopePath: SCOPE, briefId });
      expect(latest?.stale).toBe(true);
      expect(latest?.at).toEqual(new Date("2026-09-11T00:00:00Z"));
    });
  });

  describe("an acknowledgement can never itself trip the staleness flag", () => {
    it("is invisible to auditChangesUnderScope() even though it sits under the brief's own scope", async () => {
      const briefId = `${BRIEF_ID}-flag`;
      const ack = await recordBriefAcknowledgement({
        orgId: ORG,
        scopePath: SCOPE,
        briefId,
        actorType: "human",
        actorId: GRANTED_READER,
        origin: "app",
        stale: false,
      });
      // Dated after the brief so a missing action filter would surface it.
      await db.auditLog.update({ where: { id: ack.id }, data: { at: new Date("2026-09-12T00:00:00Z") } });

      const changes = await auditChangesUnderScope({
        orgId: ORG,
        scopePath: SCOPE,
        after: BRIEF_CREATED_AT,
        excludeTarget: `${SCOPE}/brief:${briefId}`,
        limit: 10,
      });
      expect(changes).toEqual([]);

      // A real memory write at the same place IS surfaced, which is what makes
      // the empty result above attributable to the action filter rather than to
      // the containment predicate or the fixture.
      await db.auditLog.create({
        data: {
          id: "case125-real-write",
          orgId: ORG,
          actorType: "human",
          actorId: "someone-else",
          action: "memory.write.applied",
          target: `${SCOPE}.dealX/entity:Acme`,
          decision: "allow",
          at: new Date("2026-09-13T00:00:00Z"),
        },
      });
      const afterWrite = await auditChangesUnderScope({
        orgId: ORG,
        scopePath: SCOPE,
        after: BRIEF_CREATED_AT,
        excludeTarget: `${SCOPE}/brief:${briefId}`,
        limit: 10,
      });
      expect(afterWrite.map((c) => c.target)).toEqual([`${SCOPE}.dealX/entity:Acme`]);
    });
  });
});
