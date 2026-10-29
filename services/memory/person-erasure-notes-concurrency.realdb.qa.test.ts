// Person erasure racing renewals of a working note
// that names the person.
//
// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A renewal locks the note's row and then takes the org's change-feed lock. The erasure's
// last transaction deletes notes and records change events, so it must take the note rows
// before that lock (person-erasure.ts, "First: a renewal locks its note's row ..."). These
// tests fire renewals of a note naming Dana in two scopes at the same moment as the erasure,
// on real Postgres, and expect no deadlock or serialization error from any call, and an end
// state that is one of the two legal orders: the note was renewed and then deleted, or it was
// deleted and a renewal posted after the erasure is a new act. A note that names nobody
// erased is never touched.
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

const ORG = "erasure_concurrency";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const OPS = `${ROOT}.ops`;
const ADMIN = "erasure_concurrency_admin";
const NAME = "Dana Whitfield";
const EMAIL = "dana.whitfield@erasure-concurrency.example";
const ROUNDS = 6;
const RENEWALS = 8;

describe.skipIf(!QA_URL)("QA #775: erasure racing renewals of a note naming the person, real Postgres", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let postWorkingNote: (typeof import("./working-notes"))["postWorkingNote"];
  let releaseWorkingNote: (typeof import("./working-notes"))["releaseWorkingNote"];

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const longAgo = new Date(Date.now() - 24 * 3600 * 1000);

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

  const renew = (scopePath: string, i: number) =>
    postWorkingNote(admin, {
      scopePath,
      task: "Renewal call",
      kind: "claim",
      body: `${NAME} wants a call, try ${i}`,
      expiresInMinutes: 60,
    });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ postWorkingNote, releaseWorkingNote } = await import("./working-notes"));
  });

  afterAll(async () => {
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.scope.create({ data: { orgId: ORG, path: OPS, name: "ops" } });
    await db.user.create({
      data: {
        id: ADMIN,
        orgId: ORG,
        email: "admin@erasure-concurrency.test",
        role: "admin",
        clerkId: "clerk-erasure-concurrency",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  });

  it("no call fails, and every round ends in a legal order", { timeout: 120_000 }, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await wipe();
      await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
      const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
      await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
      await db.scope.create({ data: { orgId: ORG, path: OPS, name: "ops" } });
      await db.user.create({
        data: {
          id: ADMIN,
          orgId: ORG,
          email: "admin@erasure-concurrency.test",
          role: "admin",
          clerkId: "clerk-erasure-concurrency",
        },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });
      await db.contact.create({ data: { id: "dana", orgId: ORG, name: NAME, email: EMAIL, createdAt: longAgo } });
      await renew(SALES, -1);
      await renew(OPS, -1);
      await postWorkingNote(admin, {
        scopePath: SALES,
        task: "Pricing",
        kind: "claim",
        body: "Keep the floor at 160k",
        expiresInMinutes: 60,
      });

      const raceStart = new Date();
      const calls = [
        erasePerson(admin, { contactId: "dana" }),
        ...Array.from({ length: RENEWALS }, (_, i) => renew(i % 2 ? SALES : OPS, i)),
      ];
      const settled = await Promise.allSettled(calls);
      const failures = settled.flatMap((s) =>
        s.status === "rejected" ? [String((s.reason as Error)?.message ?? s.reason)] : [],
      );
      expect(failures, `round ${round}`).toEqual([]);

      // The note that names nobody erased is untouched.
      expect(
        (await db.workingNote.count({ where: { orgId: ORG, task: "pricing" } })) +
          (await db.workingNote.count({ where: { orgId: ORG, task: "Pricing" } })),
      ).toBe(1);
      // A note naming her that is left must have been created by a renewal after the erasure
      // deleted the original: the one posted before the race is gone in every order.
      const left = await db.workingNote.findMany({
        where: { orgId: ORG, body: { contains: NAME } },
        select: { createdAt: true },
      });
      for (const note of left)
        expect(note.createdAt.getTime(), `round ${round}`).toBeGreaterThanOrEqual(raceStart.getTime());
    }
  });
  it(
    "a release racing the erasure either releases the note first or finds nothing, never fails",
    { timeout: 120_000 },
    async () => {
      for (let round = 0; round < ROUNDS * 2; round++) {
        await wipe();
        await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
        const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
        await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
        await db.user.create({
          data: {
            id: ADMIN,
            orgId: ORG,
            email: "admin@erasure-concurrency.test",
            role: "admin",
            clerkId: "clerk-erasure-concurrency",
          },
        });
        await db.grant.create({
          data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
        });
        await db.contact.create({ data: { id: "dana", orgId: ORG, name: NAME, email: EMAIL, createdAt: longAgo } });
        await renew(SALES, -1);

        const settled = await Promise.allSettled([
          releaseWorkingNote(admin, { scopePath: SALES, task: "Renewal call", kind: "claim" }),
          erasePerson(admin, { contactId: "dana" }),
        ]);
        const failures = settled.flatMap((s) =>
          s.status === "rejected" ? [String((s.reason as Error)?.message ?? s.reason)] : [],
        );
        expect(failures, `round ${round}`).toEqual([]);
        expect(await db.workingNote.count({ where: { orgId: ORG } }), `round ${round}`).toBe(0);
      }
    },
  );
});
