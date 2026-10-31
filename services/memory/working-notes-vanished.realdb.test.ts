// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A note deleted between a renewal's read and its update (services/memory/working-notes.ts).
// Person erasure takes the agent's note lock first, so it never lands there
// (person-erasure-notes-concurrency.realdb.qa.test.ts). A deleter that does not still can:
// an admin's SQL, an org deleted from a script, or a failed import's cleanup, which
// deletes the notes it wrote by id. Then a renewal
// answers that the note no longer exists, writes nothing, and records no change event; a
// release finds nothing to release, as when the note was never there. Neither fails with
// the database's own "record not found" error.
//
// The deletion is held open in a second connection until the renewal is seen waiting on
// the note's row lock, then committed, so the race is the same on every run.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "erasure_vanished";
const ROOT = `org_${ORG}`;
const ADMIN = "erasure_vanished_admin";
const TASK = "Renewal call";

describe.skipIf(!QA_URL)("a note deleted while it is being renewed or released, real Postgres", () => {
  let db: PrismaClient;
  let deleter: PrismaClient;
  let wm: typeof import("./working-notes");

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  async function wipe() {
    await db.workingNote.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  /** Waits until a statement on working_notes in this test's own database is blocked on a lock. */
  async function untilBlockedOnNotes() {
    for (let i = 0; i < 200; i++) {
      const [row] = await db.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%working_notes%'`;
      if (Number(row!.waiting) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("the renewal never waited on the note's row");
  }

  /**
   * Runs `act` while another connection deletes the note without the agent's lock: the
   * delete is open before `act` reads the note, and commits once `act` waits on its row.
   */
  async function withNoteDeletedUnderneath<T>(act: () => Promise<T>): Promise<PromiseSettledResult<T>> {
    let commit!: () => void;
    const gate = new Promise<void>((r) => (commit = r));
    let deleted!: () => void;
    const isDeleted = new Promise<void>((r) => (deleted = r));
    const deletion = deleter.$transaction(
      async (tx) => {
        await tx.workingNote.deleteMany({ where: { orgId: ORG, task: TASK } });
        deleted();
        await gate;
      },
      { timeout: 20_000 },
    );
    await isDeleted;
    const acting = act();
    const settled = Promise.allSettled([acting]);
    await untilBlockedOnNotes();
    commit();
    await deletion;
    return (await settled)[0]!;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    deleter = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    wm = await import("./working-notes");
  });

  beforeEach(async () => {
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@erasure-vanished.test",
        role: "admin",
        clerkId: "clerk-erasure-vanished",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await wm.postWorkingNote(admin, {
      scopePath: ROOT,
      task: TASK,
      kind: "claim",
      body: "Calling Acme at 3",
      expiresInMinutes: 60,
    });
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
    await db.$disconnect();
    await deleter.$disconnect();
  });

  it("a renewal says the note no longer exists, and writes nothing", async () => {
    const result = await withNoteDeletedUnderneath(() =>
      wm.postWorkingNote(admin, {
        scopePath: ROOT,
        task: TASK,
        kind: "claim",
        body: "Calling Acme at 4",
        expiresInMinutes: 60,
      }),
    );

    expect(result.status).toBe("rejected");
    const reason = (result as PromiseRejectedResult).reason as Error;
    expect(reason).toBeInstanceOf(wm.WorkingNoteGoneError);
    expect(reason.message).toMatch(/no longer exists/);
    expect(reason.message).toMatch(/post it again/i);
    expect(reason.message).not.toMatch(/P2025|record/i);
    expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(0);
    expect(await db.changeEvent.count({ where: { orgId: ORG, op: "update" } })).toBe(0);
  }, 30_000);

  it("posting again after that starts a new note", async () => {
    await withNoteDeletedUnderneath(() =>
      wm.postWorkingNote(admin, {
        scopePath: ROOT,
        task: TASK,
        kind: "claim",
        body: "Calling Acme at 4",
        expiresInMinutes: 60,
      }),
    );
    const again = await wm.postWorkingNote(admin, {
      scopePath: ROOT,
      task: TASK,
      kind: "claim",
      body: "Calling Acme at 4",
      expiresInMinutes: 60,
    });
    expect(again.renewed).toBe(false);
    expect(again.note.body).toBe("Calling Acme at 4");
  }, 30_000);

  it("a release finds nothing to release, as when the note was never there", async () => {
    const result = await withNoteDeletedUnderneath(() =>
      wm.releaseWorkingNote(admin, { scopePath: ROOT, task: TASK, kind: "claim" }),
    );

    expect(result).toEqual({ status: "fulfilled", value: null });
    expect(await db.changeEvent.count({ where: { orgId: ORG, op: "delete" } })).toBe(0);
  }, 30_000);
});
