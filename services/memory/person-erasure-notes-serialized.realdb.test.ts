// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Deleting working notes takes agents' note locks (services/memory/person-erasure.ts,
// deleteWorkingNotes), several per transaction and in rounds. Two such transactions in one
// org could each hold an agent the other waits on: two erasures of different people whose
// notes were posted by crossing agents, or two agents whose lock keys collide. So the
// deletions in one org take turns: a second waits for the first to commit, never for an
// agent lock the first holds.
//
// Re-applying erasures judges notes outside the transaction that deletes them
// (services/memory/erasure-reapply.ts). A note renewed in between with text that names
// nobody erased is the agent's live note, and stays.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeEpisode: async () => ({ removed: true }),
  },
}));

// A pass-through, so a test can act between the re-apply's scan and its deletion.
vi.mock("./person-erasure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./person-erasure")>();
  return { ...actual, deleteWorkingNotes: vi.fn(actual.deleteWorkingNotes) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "erasure_serialized";
const ROOT = `org_${ORG}`;
const ADMIN = "erasure_serialized_admin";
const NAME = "Dana Whitfield";
const TASK = "Renewal call";
const longAgo = new Date(Date.now() - 24 * 3600 * 1000);

describe.skipIf(!QA_URL)(
  "note deletions in one org take turns, and re-applying spares a note renewed since its scan, real Postgres",
  () => {
    let db: PrismaClient;
    let other: PrismaClient;
    let erasure: typeof import("./person-erasure");
    let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];
    let postWorkingNote: (typeof import("./working-notes"))["postWorkingNote"];

    const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

    async function wipe() {
      await db.workingNote.deleteMany({ where: { orgId: ORG } });
      await db.changeEvent.deleteMany({ where: { orgId: ORG } });
      await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
      await db.contact.deleteMany({ where: { orgId: ORG } });
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await db.user.deleteMany({ where: { orgId: ORG } });
    }

    const note = (agentId: string, body: string) =>
      db.workingNote.create({
        data: {
          orgId: ORG,
          scopePath: ROOT,
          agentId,
          task: "acme",
          kind: "claim",
          body,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });

    /** True once some transaction in this test's database waits on an advisory lock. */
    async function advisoryWaitSeen(): Promise<boolean> {
      // A deadline, not a count of polls: on a loaded machine the second transaction can take
      // longer than 80 polls of 25 ms to reach the lock. Inside the test's 30 s.
      for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
        const [row] = await db.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`;
        if (Number(row!.waiting) > 0) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      other = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      erasure = await import("./person-erasure");
      ({ reapplyErasures } = await import("./erasure-reapply"));
      ({ postWorkingNote } = await import("./working-notes"));
    });

    beforeEach(async () => {
      await wipe();
      await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
      const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
      await db.user.create({
        data: {
          id: ADMIN,
          orgId: ORG,
          email: "admin@erasure-serialized.test",
          role: "admin",
          clerkId: "clerk-erasure-serialized",
        },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });
    });

    afterAll(async () => {
      if (!db) return;
      await wipe();
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.$disconnect();
      await other.$disconnect();
    });

    /** Whether agent `agentId`'s note lock is free: taken and given back at once from a third connection. */
    async function agentLockFree(agentId: string): Promise<boolean> {
      return db.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ free: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(8241004::int4, hashtext(${ORG} || '/' || ${agentId})::int4) AS free`;
        return row!.free;
      });
    }

    it("a second deletion waits for the first before it takes any agent's lock", async () => {
      await note("agent-x", "Dana Whitfield wants a call");
      await note("agent-y", "Kenji Sato wants a call");

      let commitFirst!: () => void;
      const held = new Promise<void>((r) => (commitFirst = r));
      let firstDone!: () => void;
      const firstDeleted = new Promise<void>((r) => (firstDone = r));
      const first = db.$transaction(
        async (tx) => {
          await erasure.deleteWorkingNotes(tx, admin, Prisma.sql`body LIKE '%Dana%'`);
          firstDone();
          await held;
        },
        { timeout: 20_000 },
      );
      await firstDeleted;
      const second = other.$transaction(
        (tx) => erasure.deleteWorkingNotes(tx, admin, Prisma.sql`body LIKE '%Kenji%'`),
        { timeout: 20_000 },
      );

      const waited = await advisoryWaitSeen();
      // Waiting, it holds no agent lock: an agent it would lock is still free to post.
      const freeWhileWaiting = await agentLockFree("agent-y");
      commitFirst();
      await first;
      expect(waited).toBe(true);
      expect(freeWhileWaiting).toBe(true);
      expect(await second).toBe(1);
      expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(0);
    }, 30_000);

    it("re-applying erasures keeps a restored note its agent renewed, with new text, after the scan", async () => {
      await db.contact.create({
        data: { id: "dana", orgId: ORG, name: NAME, email: "dana@erasure-serialized.example", createdAt: longAgo },
      });
      await erasure.erasePerson(admin, { contactId: "dana" });
      // Put back by a restore: written before the erasure, naming her.
      const restored = await postWorkingNote(admin, {
        scopePath: ROOT,
        task: TASK,
        kind: "claim",
        body: `${NAME} wants a call`,
        expiresInMinutes: 60,
      });
      await db.workingNote.update({ where: { id: restored.note.id }, data: { createdAt: longAgo } });

      vi.mocked(erasure.deleteWorkingNotes).mockImplementationOnce(async (tx, ctx, namesPerson) => {
        // Between the scan and the deletion, the agent renews its note with new text.
        await postWorkingNote(admin, {
          scopePath: ROOT,
          task: TASK,
          kind: "claim",
          body: "Calling Acme at 4",
          expiresInMinutes: 60,
        });
        const actual = await vi.importActual<typeof import("./person-erasure")>("./person-erasure");
        return actual.deleteWorkingNotes(tx, ctx, namesPerson);
      });

      const result = await reapplyErasures(admin);

      expect(result.notesRemoved).toBe(0);
      expect(
        (await db.workingNote.findMany({ where: { orgId: ORG }, select: { body: true } })).map((n) => n.body),
      ).toEqual(["Calling Acme at 4"]);
    }, 30_000);
  },
);
