// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Person erasure reaches working notes, and re-applying erasures after a restore reaches
// briefs and working notes (docs/consent-deletion-suite.md, bar 3, 4c and "after a backup
// restore").
//   - erasePerson deletes every note whose task or body names the person, in every scope,
//     live or released, with a `delete` change event for each, and leaves the change feed
//     holding no text that names them; a later release of the deleted note writes nothing.
//   - reapplyErasures deletes a restored brief that names the person, or cited a fact that
//     named them or a version the erasure removed, and a restored note that names them,
//     keeps what was written after the erasure and what never named them, and a second run
//     removes nothing.
//
// Real: Postgres, check(), the erasure, the suppression list, postWorkingNote and
// releaseWorkingNote. Stand-in: the graph store, as in person-erasure.realdb.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
    removeEpisode: async () => ({ removed: true }),
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_erase_notes";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const OPS = `${ROOT}.ops`;
const ADMIN = "qa_erase_notes_admin";
const DIMENSIONS = 384;

const NAME = "Dana Whitfield";
const EMAIL = "dana.whitfield@erase-notes.example";
/** Another person, whose name continues hers into a longer one: never erased by hers. */
const BARNES = `${NAME}-Barnes`;

/**
 * Touches as a claim holds them, and what erasure leaves of each. One table for the erasure and
 * for its re-application after a restore: both read paths the same way (pathsAsText), and these
 * rows are what keeps them from finding different paths.
 */
const TOUCH_CASES: [string, string, string[]][] = [
  ["her name as written", `file:acme/crm/customers/${NAME}/renewal.md`, []],
  ["her name as a file name", "file:acme/crm/customers/dana-whitfield.md", []],
  ["her name in snake case", "file:acme/crm/customers/Dana_Whitfield.md", []],
  ["her address", `file:acme/crm/inbox/${EMAIL}.eml`, []],
  // Read with separators as spaces, a longer name starting with hers matches too: touches err toward clearing.
  ["Barnes's longer name, over-erased on purpose", `file:acme/crm/customers/${BARNES}/po.md`, []],
  ["no name of hers", "file:acme/crm/pricing/floor.md", ["file:acme/crm/pricing/floor.md"]],
];

const vector = `[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`;

describe.skipIf(!QA_URL)(
  "person erasure reaches working notes, and re-applying it reaches restored briefs and notes",
  () => {
    let db: PrismaClient;
    let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
    let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];
    let postWorkingNote: (typeof import("./working-notes"))["postWorkingNote"];
    let releaseWorkingNote: (typeof import("./working-notes"))["releaseWorkingNote"];

    const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
    const longAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const later = () => new Date(Date.now() + 60_000);

    async function wipe() {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
      await db.brief.deleteMany({ where: { orgId: ORG } });
      await db.workingNote.deleteMany({ where: { orgId: ORG } });
      await db.changeEvent.deleteMany({ where: { orgId: ORG } });
      await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
      await db.contact.deleteMany({ where: { orgId: ORG } });
      await db.auditLog.deleteMany({ where: { orgId: ORG } });
      await db.grant.deleteMany({ where: { orgId: ORG } });
      await db.scope.deleteMany({ where: { orgId: ORG } });
      await db.user.deleteMany({ where: { orgId: ORG } });
    }

    const post = (scopePath: string, task: string, body: string) =>
      postWorkingNote(admin, { scopePath, task, kind: "claim", body, expiresInMinutes: 60 });

    const noteTasks = async () =>
      (await db.workingNote.findMany({ where: { orgId: ORG }, select: { task: true } })).map((n) => n.task).sort();

    /** Every change event summary in the org that names her: her address, or her name not continued into Barnes's. */
    async function summariesNamingHer(): Promise<string[]> {
      const events = await db.changeEvent.findMany({ where: { orgId: ORG }, select: { summary: true } });
      return events
        .map((e) => e.summary)
        .filter((s) => s.toLowerCase().includes(EMAIL) || s.replaceAll(BARNES, "").includes(NAME));
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      ({ erasePerson } = await import("./person-erasure"));
      ({ reapplyErasures } = await import("./erasure-reapply"));
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
        data: { id: ADMIN, orgId: ORG, email: "admin@erase-notes.test", role: "admin", clerkId: "clerk-erase-notes" },
      });
      await db.grant.create({
        data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
      });
      await db.contact.create({ data: { id: "dana", orgId: ORG, name: NAME, email: EMAIL, createdAt: longAgo } });
    });

    describe("erasePerson", () => {
      beforeEach(async () => {
        await post(SALES, `Renewal call with ${NAME}`, "Asking for the floor price");
        await post(OPS, "Invoice follow-up", `Waiting on ${EMAIL} to confirm the PO`);
        await post(SALES, "Discount sign-off", `${NAME} approved 10 percent`);
        await releaseWorkingNote(admin, { scopePath: SALES, task: "Discount sign-off", kind: "claim" });
        await post(SALES, "Pricing", "Keep the floor at 160k");
        await post(SALES, "Procurement", `${BARNES} runs procurement`);
      });

      it.each(TOUCH_CASES)(
        "empties a kept claim's touches that name her by %s, keeping the claim",
        async (_case, touch, kept) => {
          await db.workingNote.create({
            data: {
              id: "n-touches",
              orgId: ORG,
              scopePath: SALES,
              agentId: "agent-x",
              task: "Renewal notes",
              kind: "claim",
              body: "Updating the files",
              touches: [touch],
              expiresAt: later(),
            },
          });

          await erasePerson(admin, { email: EMAIL });

          expect(
            await db.workingNote.findUnique({ where: { id: "n-touches" }, select: { task: true, touches: true } }),
          ).toEqual({ task: "Renewal notes", touches: kept });
        },
      );

      it("blanks an overlap's summary that lists a path naming her, as a path writes a name", async () => {
        const overlap = (id: string, summary: string, seq: number) =>
          db.changeEvent.create({
            data: {
              id,
              orgId: ORG,
              seq: 900_000 + seq,
              scopePath: SALES,
              recordType: "claim_overlap",
              recordId: "n-x",
              op: "create",
              actorId: "agent-x",
              actorType: "agent",
              origin: "mcp",
              summary,
            },
          });
        await overlap(
          "e-hers",
          'overlap detected, not resolved: claim n-y by agent-y, claimed 10:00Z, shares 1 file: file:acme/crm/customers/dana-whitfield.md; this claim is on "renewals"',
          1,
        );
        await overlap(
          "e-other",
          'overlap detected, not resolved: claim n-y by agent-y, claimed 10:00Z, shares 1 file: file:acme/crm/pricing/floor.md; this claim is on "pricing"',
          2,
        );

        await erasePerson(admin, { email: EMAIL });

        const summaries = await db.changeEvent.findMany({
          where: { id: { in: ["e-hers", "e-other"] } },
          select: { id: true, summary: true },
          orderBy: { id: "asc" },
        });
        expect(summaries.map((e) => [e.id, e.summary === ""])).toEqual([
          ["e-hers", true],
          ["e-other", false],
        ]);
      });

      it("deletes every note naming her, in every scope, live or released, and keeps the rest", async () => {
        expect(await noteTasks()).toHaveLength(5);

        const result = await erasePerson(admin, { email: EMAIL });

        expect(result.notesRemoved).toBe(3);
        expect(await noteTasks()).toEqual(["Pricing", "Procurement"]);
        const [erased] = await db.auditLog.findMany({
          where: { orgId: ORG, action: "person.erased" },
          select: { metadata: true },
        });
        expect((erased!.metadata as { stores: { notes: unknown } }).stores.notes).toEqual({ notes: 3 });
      });

      it("leaves no change-feed text naming her, and announces each deleted note's end with a blank delete event", async () => {
        const before = await db.workingNote.findMany({
          where: { orgId: ORG },
          select: { id: true, task: true, body: true },
        });
        const hers = before.filter((n) =>
          `${n.task}\n${n.body}`.replaceAll(BARNES, "").match(new RegExp(`${NAME}|${EMAIL}`, "i")),
        );
        expect(hers).toHaveLength(3);
        expect(await summariesNamingHer()).not.toEqual([]);

        await erasePerson(admin, { email: EMAIL });

        expect(await summariesNamingHer()).toEqual([]);
        const deletes = await db.changeEvent.findMany({
          where: {
            orgId: ORG,
            recordType: "note",
            op: "delete",
            actorId: ADMIN,
            recordId: { in: hers.map((n) => n.id) },
          },
          select: { recordId: true, summary: true },
        });
        // The released note already has its release event; every one of hers gets the erasure's own.
        const blank = deletes.filter((d) => d.summary === "");
        expect(new Set(blank.map((d) => d.recordId))).toEqual(new Set(hers.map((n) => n.id)));
      });

      it("a release of a deleted note, after the erasure, writes nothing naming her", async () => {
        await erasePerson(admin, { email: EMAIL });
        const events = await db.changeEvent.count({ where: { orgId: ORG } });

        expect(
          await releaseWorkingNote(admin, { scopePath: SALES, task: `Renewal call with ${NAME}`, kind: "claim" }),
        ).toBeNull();

        expect(await db.changeEvent.count({ where: { orgId: ORG } })).toBe(events);
        expect(await summariesNamingHer()).toEqual([]);
      });

      it("erasing her again removes a note posted since, a third request removes nothing, and other notes stay", async () => {
        await erasePerson(admin, { email: EMAIL });
        await db.contact.create({ data: { id: "dana-again", orgId: ORG, name: NAME, email: EMAIL } });
        await post(SALES, "Advisor intro", `${NAME} rejoined as an advisor`);

        // Erasing her again by the re-added contact removes the new note: a new request is a new act.
        const second = await erasePerson(admin, { contactId: "dana-again" });
        expect(second.notesRemoved).toBe(1);
        expect((await erasePerson(admin, { email: EMAIL })).notesRemoved).toBe(0);
        expect(await noteTasks()).toEqual(["Pricing", "Procurement"]);
      });

      it("deletes a note naming her without spaces and keeps one naming a person her name runs into", async () => {
        await post(SALES, "Offer letter", "Sent Dana_Whitfield_offer.pdf for signature");
        await post(OPS, "Handle", "Ping DanaWhitfield about the PO");
        await post(SALES, "Vendor contact", "Owner is dana-whitfield-barnes");

        const result = await erasePerson(admin, { email: EMAIL });

        expect(result.notesRemoved).toBe(5);
        expect(await noteTasks()).toEqual(["Pricing", "Procurement", "Vendor contact"]);
      });

      it("keeps two people a tab or a line break parts where the erased name has a hyphen", async () => {
        await db.contact.create({
          data: { id: "anne", orgId: ORG, name: "Anne-Marie Dupont", email: "amd@erase-notes.example" },
        });
        await post(SALES, "Mentoring", "Mentor\tMentee\nAnne\tMarie Dupont\nBo\tWu");
        await post(SALES, "Attendees", "Present:\nAnne\nMarie Dupont\nBo Wu");
        await post(SALES, "Contract", "Anne-Marie Dupont signed the order");
        await post(SALES, "Contract file", "Attached Anne_Marie_Dupont_contract.pdf");

        const result = await erasePerson(admin, { contactId: "anne" });

        expect(result.notesRemoved).toBe(2);
        const tasks = await noteTasks();
        expect(tasks).toEqual(expect.arrayContaining(["Mentoring", "Attendees"]));
        expect(tasks).not.toContain("Contract");
        expect(tasks).not.toContain("Contract file");
      });
    });

    describe("reapplyErasures after a restore from before the erasure", () => {
      /** The rows a restore of the briefs, citations and notes tables puts back. */
      type Backup = {
        briefs: Awaited<ReturnType<PrismaClient["brief"]["findMany"]>>;
        citations: Awaited<ReturnType<PrismaClient["briefCitation"]["findMany"]>>;
        notes: Awaited<ReturnType<PrismaClient["workingNote"]["findMany"]>>;
      };

      async function takeBackup(): Promise<Backup> {
        const briefs = await db.brief.findMany({ where: { orgId: ORG } });
        return {
          briefs,
          citations: await db.briefCitation.findMany({ where: { briefId: { in: briefs.map((b) => b.id) } } }),
          notes: await db.workingNote.findMany({ where: { orgId: ORG } }),
        };
      }

      async function restore(backup: Backup) {
        for (const b of backup.briefs) await db.brief.upsert({ where: { id: b.id }, update: {}, create: b as never });
        for (const c of backup.citations) await db.briefCitation.upsert({ where: { id: c.id }, update: {}, create: c });
        for (const n of backup.notes) await db.workingNote.upsert({ where: { id: n.id }, update: {}, create: n });
      }

      const brief = (id: string, title: string, citations: { factId: string; factText: string }[] = []) =>
        db.brief.create({
          data: {
            id,
            orgId: ORG,
            type: "handoff",
            scopePath: SALES,
            title,
            summary: "s",
            sections: [],
            createdAt: longAgo,
            citations: { create: citations.map((c) => ({ ...c, sectionIndex: 0 })) },
          },
        });

      const note = (id: string, task: string, body: string, createdAt = longAgo) =>
        db.workingNote.create({
          data: {
            id,
            orgId: ORG,
            scopePath: SALES,
            agentId: "agent-x",
            task,
            kind: "claim",
            body,
            expiresAt: later(),
            createdAt,
          },
        });

      beforeEach(async () => {
        // A fact the erasure removes by its text, so its id goes on the suppression list.
        await db.$executeRaw`
        INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
        VALUES ('c-dana', ${ORG}, ${`${NAME} asked for the annual plan.`}, 'text', 'extraction', ${SALES}, ${vector}::vector, ${longAgo})
      `;
        await brief("b-title", `Handoff: ${NAME} renewal`);
        await brief("b-cites-text", "Handoff: renewal", [
          { factId: "c-other", factText: `${EMAIL} asked for a quote` },
        ]);
        await brief("b-cites-version", "Handoff: annual plan", [
          { factId: "c-dana", factText: "She asked for the annual plan." },
        ]);
        await brief("b-pricing", "Handoff: pricing", [{ factId: "c-pricing", factText: "The floor is 160k." }]);
        await brief("b-barnes", `Handoff: ${BARNES} procurement`);
        await note("n-dana", `Call ${NAME}`, "about the renewal");
        await note("n-pricing", "Pricing", "Keep the floor at 160k");
      });

      it("deletes the restored briefs and notes that name her, keeps the rest, and a second run removes nothing", async () => {
        const backup = await takeBackup();
        const erased = await erasePerson(admin, { email: EMAIL });
        // The erasure itself removes them first; the restore puts them back.
        expect(erased.briefsRemoved).toBe(3);
        expect(erased.notesRemoved).toBe(1);
        await restore(backup);
        expect(await db.brief.count({ where: { orgId: ORG } })).toBe(5);

        const result = await reapplyErasures(admin);

        expect(result).toMatchObject({ briefsRemoved: 3, notesRemoved: 1 });
        const briefs = await db.brief.findMany({ where: { orgId: ORG }, select: { id: true }, orderBy: { id: "asc" } });
        expect(briefs.map((b) => b.id)).toEqual(["b-barnes", "b-pricing"]);
        expect(await noteTasks()).toEqual(["Pricing"]);
        const deleted = await db.changeEvent.findMany({
          where: {
            orgId: ORG,
            op: "delete",
            recordId: { in: ["b-title", "b-cites-text", "b-cites-version", "n-dana"] },
          },
          select: { recordId: true },
        });
        // One delete event from the erasure and one from the re-application, for each.
        expect(deleted).toHaveLength(8);

        expect(await reapplyErasures(admin)).toMatchObject({ briefsRemoved: 0, notesRemoved: 0 });
      });

      it.each(TOUCH_CASES)(
        "empties the touches naming her by %s of a claim a restore put back, keeping the claim",
        async (_case, touch, kept) => {
          await db.workingNote.create({
            data: {
              id: "n-touches",
              orgId: ORG,
              scopePath: SALES,
              agentId: "agent-x",
              task: "Renewal notes",
              kind: "claim",
              body: "Updating the files",
              touches: [touch],
              expiresAt: later(),
              createdAt: longAgo,
            },
          });
          const backup = await takeBackup();
          await erasePerson(admin, { email: EMAIL });
          // The restore puts the row back as it was backed up, its touches with it.
          await db.workingNote.delete({ where: { id: "n-touches" } });
          await restore(backup);
          expect((await db.workingNote.findUniqueOrThrow({ where: { id: "n-touches" } })).touches).toEqual([touch]);

          await reapplyErasures(admin);

          expect(await db.workingNote.findUnique({ where: { id: "n-touches" }, select: { touches: true } })).toEqual({
            touches: kept,
          });
        },
      );

      it("keeps a brief and a note naming her that were written after the erasure: a deliberate new mention", async () => {
        await erasePerson(admin, { email: EMAIL });
        await db.brief.create({
          data: {
            id: "b-new",
            orgId: ORG,
            type: "handoff",
            scopePath: SALES,
            title: `Handoff: ${NAME} as advisor`,
            summary: "s",
            sections: [],
            createdAt: later(),
          },
        });
        await note("n-new", `Intro ${NAME}`, "as an advisor", later());

        expect(await reapplyErasures(admin)).toMatchObject({ briefsRemoved: 0, notesRemoved: 0 });
        expect(await db.brief.findUnique({ where: { id: "b-new" } })).not.toBeNull();
        expect(await db.workingNote.findUnique({ where: { id: "n-new" } })).not.toBeNull();
      });

      it("is refused without access.manage on the org root, before anything is removed", async () => {
        const backup = await takeBackup();
        await erasePerson(admin, { email: EMAIL });
        await restore(backup);
        const member: AccessContext = {
          orgId: ORG,
          actor: { type: "human", id: "nobody", role: "member" },
          origin: "app",
        };

        await expect(reapplyErasures(member)).rejects.toThrow();
        expect(await db.brief.count({ where: { orgId: ORG } })).toBe(5);
        expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(2);
      });
    });
  },
);
