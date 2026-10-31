// Two person erasures in one org at the same time,
// whose working notes were posted by crossing agents.
//
// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Deleting notes takes agents' note locks in rounds (person-erasure.ts, deleteWorkingNotes).
// Within a round the locks go in agent id order, but a note from an agent first seen after a
// round's delete is locked in the next round, out of that order. If a second erasure in the
// org already holds that agent and waits on one the first holds, the two deadlock and
// Postgres aborts one: the erasure request fails. The org's note-deletion lock makes the
// second wait before it takes any agent lock. The first test builds that interleaving on
// purpose through the whole erasePerson path; the second fires both erasures with posts from
// every agent and expects no call to fail.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
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

// A pass-through, so a test can hold an erasure right after it takes an agent's lock.
vi.mock("./working-notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./working-notes")>();
  return { ...actual, lockAgentNotes: vi.fn(actual.lockAgentNotes) };
});

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "erasure_two_erasures";
const ROOT = `org_${ORG}`;
const ADMIN = "erasure_two_admin";
const AGENTS = ["erasure-a0", "erasure-a1", "erasure-a2", "erasure-a3"];
const DANA = "Dana Whitfield";
const KENJI = "Kenji Sato";
const longAgo = new Date(Date.now() - 24 * 3600 * 1000);

describe.skipIf(!QA_URL)("QA #775: two erasures in one org with crossing agents, real Postgres", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let workingNotes: typeof import("./working-notes");

  const asUser = (id: string): AccessContext => ({
    orgId: ORG,
    actor: { type: "human", id, role: "admin" },
    origin: "app",
  });
  const admin = asUser(ADMIN);

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

  async function seed() {
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    for (const id of [ADMIN, ...AGENTS]) {
      await db.user.create({
        data: { id, orgId: ORG, email: `${id}@erasure-two.test`, role: "admin", clerkId: `clerk-${id}` },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: id, permission: "admin" },
      });
    }
    await db.contact.create({
      data: { id: "dana", orgId: ORG, name: DANA, email: "dana@erasure-two.example", createdAt: longAgo },
    });
    await db.contact.create({
      data: { id: "kenji", orgId: ORG, name: KENJI, email: "kenji@erasure-two.example", createdAt: longAgo },
    });
  }

  const note = (agentId: string, task: string, body: string) =>
    db.workingNote.create({
      data: {
        orgId: ORG,
        scopePath: ROOT,
        agentId,
        task,
        kind: "claim",
        body,
        expiresAt: new Date(Date.now() + 3600_000),
        createdAt: longAgo,
      },
    });

  /** Resolves once some transaction in this database waits on an advisory lock. */
  async function advisoryWait(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const [row] = await db.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.datname = current_database() AND l.locktype = 'advisory' AND NOT l.granted`;
      if (Number(row!.waiting) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("no transaction ever waited on an advisory lock");
  }

  const failuresOf = (settled: PromiseSettledResult<unknown>[]) =>
    settled.flatMap((s) => (s.status === "rejected" ? [String((s.reason as Error)?.message ?? s.reason)] : []));

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    workingNotes = await import("./working-notes");
  });

  beforeEach(async () => {
    vi.mocked(workingNotes.lockAgentNotes).mockClear();
    await seed();
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
  });

  it(
    "a note seen in a later round does not deadlock the first erasure with a second one",
    { timeout: 60_000 },
    async () => {
      const [a0, a1] = AGENTS as [string, string];
      await note(a1, "dana call", `${DANA} wants a call`);
      await note(a0, "kenji call", `${KENJI} wants a call`);
      await note(a1, "kenji follow-up", `${KENJI} asked for pricing`);

      // Dana's erasure takes a1's lock and is held there, before its first round's delete.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let holding!: () => void;
      const danaHoldsA1 = new Promise<void>((r) => (holding = r));
      const actualLock = (await vi.importActual<typeof import("./working-notes")>("./working-notes")).lockAgentNotes;
      vi.mocked(workingNotes.lockAgentNotes).mockImplementationOnce(async (tx, orgId, agentId) => {
        await actualLock(tx, orgId, agentId);
        holding();
        await gate;
      });

      const dana = erasePerson(admin, { contactId: "dana" });
      await danaHoldsA1;
      // Kenji's erasure starts: without the org lock it takes a0 and waits on a1.
      const kenji = erasePerson(admin, { contactId: "kenji" });
      await advisoryWait();
      // An a0 note naming Dana commits now, after Dana's first round chose its agents: her
      // second round must lock a0.
      await note(a0, "dana intro", `Intro ${DANA} to the buyer`);
      release();

      const settled = await Promise.allSettled([dana, kenji]);
      expect(failuresOf(settled)).toEqual([]);
      expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(0);
    },
  );

  it(
    "both erasures and every agent's posts succeed, and no note written before them is left",
    { timeout: 120_000 },
    async () => {
      for (let round = 0; round < 5; round++) {
        await seed();
        for (const [i, agent] of AGENTS.entries()) {
          await note(agent, `dana ${i}`, `${DANA} wants a call`);
          await note(agent, `kenji ${i}`, `${KENJI} wants a call`);
        }
        const raceStart = new Date();
        const posts = AGENTS.flatMap((agent, i) => [
          workingNotes.postWorkingNote(asUser(agent), {
            scopePath: ROOT,
            task: `dana ${i}`,
            kind: "claim",
            body: `${DANA} wants a call, renewed`,
            expiresInMinutes: 60,
          }),
          workingNotes.postWorkingNote(asUser(agent), {
            scopePath: ROOT,
            task: `kenji new ${i}`,
            kind: "claim",
            body: `${KENJI} new note`,
            expiresInMinutes: 60,
          }),
        ]);
        const settled = await Promise.allSettled([
          erasePerson(admin, { contactId: "dana" }),
          erasePerson(admin, { contactId: "kenji" }),
          ...posts,
        ]);
        expect(failuresOf(settled), `round ${round}`).toEqual([]);
        const left = await db.workingNote.findMany({ where: { orgId: ORG }, select: { createdAt: true, task: true } });
        for (const n of left)
          expect(n.createdAt.getTime(), `round ${round}: ${n.task}`).toBeGreaterThanOrEqual(raceStart.getTime() - 1000);
      }
    },
  );
});
