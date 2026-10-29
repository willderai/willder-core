// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Person erasure reaching working notes and restored briefs
// (person-erasure-notes-briefs.realdb.test.ts covers the single-org behaviour):
//   - erasing a person in one org leaves another org's notes naming the same person,
//     and re-applying erasures in one org leaves another org's briefs and notes;
//   - when the person was added again after the erasure, re-applying deletes the
//     restored pre-erasure note and brief and keeps a note written since.
//
// Real: Postgres, check(), the erasure, the suppression list. Fake: the graph store.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeEpisode: async () => ({ removed: true }),
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;
const NAME = "Dana Whitfield";
const EMAIL = "dana.whitfield@erase-notes.example";
const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
const later = () => new Date(Date.now() + 60_000);

describe.skipIf(!QA_URL)(
  "person erasure of notes and briefs stays inside its org, and re-applying it after a re-add goes by time",
  () => {
    let db: PrismaClient;
    let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
    let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];
    const ORGS = ["erasure_a", "erasure_b"];
    const ctx = (org: string): AccessContext => ({
      orgId: org,
      actor: { type: "human", id: `${org}_admin`, role: "admin" },
      origin: "app",
    });

    async function wipe() {
      for (const org of ORGS) {
        await db.brief.deleteMany({ where: { orgId: org } });
        await db.workingNote.deleteMany({ where: { orgId: org } });
        await db.changeEvent.deleteMany({ where: { orgId: org } });
        await db.erasureSuppression.deleteMany({ where: { orgId: org } });
        await db.contact.deleteMany({ where: { orgId: org } });
        await db.auditLog.deleteMany({ where: { orgId: org } });
        await db.grant.deleteMany({ where: { orgId: org } });
        await db.scope.deleteMany({ where: { orgId: org } });
        await db.user.deleteMany({ where: { orgId: org } });
      }
    }
    const note = (org: string, id: string, task: string, body: string, createdAt = longAgo) =>
      db.workingNote.create({
        data: {
          id,
          orgId: org,
          scopePath: `org_${org}.sales`,
          agentId: "agent-x",
          task,
          kind: "claim",
          body,
          expiresAt: later(),
          createdAt,
        },
      });
    const brief = (org: string, id: string, title: string) =>
      db.brief.create({
        data: {
          id,
          orgId: org,
          type: "handoff",
          scopePath: `org_${org}.sales`,
          title,
          summary: "s",
          sections: [],
          createdAt: longAgo,
        },
      });

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      ({ erasePerson } = await import("./person-erasure"));
      ({ reapplyErasures } = await import("./erasure-reapply"));
    });
    afterAll(async () => {
      if (db) {
        await wipe();
        await db.$disconnect();
      }
    });
    beforeEach(async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await wipe();
      for (const org of ORGS) {
        await db.org.upsert({ where: { id: org }, update: {}, create: { id: org, name: org } });
        const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
        await db.scope.create({ data: { orgId: org, path: `org_${org}.sales`, name: "sales" } });
        await db.user.create({
          data: { id: `${org}_admin`, orgId: org, email: `admin@${org}.test`, role: "admin", clerkId: `clerk-${org}` },
        });
        await db.grant.create({
          data: { orgId: org, scopeId: root.id, granteeType: "user", granteeId: `${org}_admin`, permission: "admin" },
        });
        await db.contact.create({
          data: { id: `dana-${org}`, orgId: org, name: NAME, email: EMAIL, createdAt: longAgo },
        });
        await note(org, `n-${org}`, `Call ${NAME}`, "renewal");
        await brief(org, `b-${org}`, `Handoff: ${NAME} renewal`);
      }
    });

    it("erasePerson in org A leaves org B's notes naming the same person", async () => {
      const r = await erasePerson(ctx("erasure_a"), { email: EMAIL });
      expect(r.notesRemoved).toBe(1);
      expect(await db.workingNote.count({ where: { orgId: "erasure_a" } })).toBe(0);
      expect(await db.workingNote.count({ where: { orgId: "erasure_b" } })).toBe(1);
      expect(await db.changeEvent.count({ where: { orgId: "erasure_b", op: "delete" } })).toBe(0);
    });

    it("reapplyErasures in org A leaves org B's rows, even though B's name the person A erased", async () => {
      // Only A erased her: A's re-application must not reach B's rows.
      await erasePerson(ctx("erasure_a"), { email: EMAIL });
      const r = await reapplyErasures(ctx("erasure_a"));
      expect(r).toMatchObject({ briefsRemoved: 0, notesRemoved: 0 });
      expect(await db.workingNote.count({ where: { orgId: "erasure_b" } })).toBe(1);
      expect(await db.brief.count({ where: { orgId: "erasure_b" } })).toBe(1);
    });

    it("re-added person: restored pre-erasure note and brief are deleted, post-erasure note naming the re-added person stays", async () => {
      const backupNote = await db.workingNote.findUnique({ where: { id: "n-erasure_a" } });
      const backupBrief = await db.brief.findUnique({ where: { id: "b-erasure_a" } });
      await erasePerson(ctx("erasure_a"), { email: EMAIL });
      await db.contact.create({
        data: { id: "dana-again", orgId: "erasure_a", name: NAME, email: EMAIL, createdAt: later() },
      });
      await note("erasure_a", "n-new", `Intro ${NAME}`, "as advisor", later());
      await db.workingNote.create({ data: backupNote! });
      await db.brief.create({ data: backupBrief! as never });
      const r = await reapplyErasures(ctx("erasure_a"));
      expect(r).toMatchObject({ briefsRemoved: 1, notesRemoved: 1 });
      expect(
        (await db.workingNote.findMany({ where: { orgId: "erasure_a" }, select: { id: true } })).map((n) => n.id),
      ).toEqual(["n-new"]);
      expect(await db.contact.findUnique({ where: { id: "dana-again" } })).not.toBeNull();
    });
  },
);
