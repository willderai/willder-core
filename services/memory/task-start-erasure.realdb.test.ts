// The erased-content filter on the task-start read's task facts
// (services/memory/task-start.ts, servableTaskFacts), checked on its edges.
//
// person-erasure-restore.realdb.test.ts proves the filter exists: a restored chunk
// naming an erased person is not served back to the task that wrote it. Three parts of
// how it is applied had no test that fails when they change:
// - the check reads a fact's whole text, and the block's 4,000-character cut comes
//   after it, so a name past character 4,000 still hides the fact;
// - the check compares when the fact was written with when the erasure was recorded,
//   so a fact naming the person written after the erasure is a deliberate re-add and
//   is served, and one written in the same millisecond as the erasure is not;
// - the cut counts code points, as Postgres counts characters, so a served fact is at
//   most 4,000 characters and no character is split.
// A recent write is served with the text of the fact version it created, and the same check
// applies there: a write whose fact is an old copy naming the erased person is not served at
// all, since a restored summary can carry the name too.
// A write's own summary is checked the same way: the erasure blanks the summary of every
// change event that names the person, so a restored event whose summary names them is an
// old copy and is not served, whatever kind of record it is about, and whether the block
// found it by the task's terms or served it as one of the newest writes.
//
// Real: Postgres, the suppression list as the erasure records it (recordSuppressions)
// and readServableTaskStart, asked to serve everything it read, so every record is checked.
// No erasure is run; the list is what the read consults.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_taskStartErasure";
const ROOT = `org_${ORG}`;
const SUPPORT = `${ROOT}.support`;
const TASK = "SUP-77";
const NAME = "Orla Vennick";
const FACT_TEXT_SERVED_CHARS = 4000;

describe.skipIf(!QA_URL)(
  "task-start task facts: the erased-person check sees the whole fact, and only old copies",
  () => {
    // The read does not authorize, so the token is never presented anywhere.
    const ctx: AccessContext = {
      orgId: ORG,
      actor: { type: "agent", id: "qa", capabilityToken: "unused" },
      origin: "mcp",
    };
    let db: PrismaClient;
    let readServableTaskStart: (typeof import("./task-start"))["readServableTaskStart"];
    /** Everything a read holds, as a block serving all of it would show it. */
    const everything = (read: import("./task-start").TaskStartRead) => [
      ...read.task.facts.map((fact) => fact.id),
      ...read.context.writes.map((write) => write.recordId),
    ];
    let servedIds: string[];
    let served: Map<string, string>;
    let writeText: Map<string, string | undefined>;
    let byTermsSummaries: Map<string, string>;
    let newestSummaries: Map<string, string>;

    async function cleanup(): Promise<void> {
      await db.changeEvent.deleteMany({ where: { orgId: ORG } });
      await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
      await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      ({ readServableTaskStart } = await import("./task-start"));
      const { recordSuppressions } = await import("./erasure-suppression");
      await cleanup();
      await db.org.create({ data: { id: ORG, name: ORG } });

      // The erasure is recorded now; the suppression row takes the database's clock.
      await recordSuppressions(db, ORG, "qa-request", { emails: [], names: [NAME.toLowerCase()], contactIds: [] });
      // Cut to the millisecond a fact's write time is stored and compared at, so a fact can be
      // written at exactly the erasure's instant.
      await db.$executeRaw`UPDATE "erasure_suppressions" SET "createdAt" = date_trunc('milliseconds', "createdAt") WHERE "orgId" = ${ORG}`;
      const [{ createdAt: erasedAt }] = await db.erasureSuppression.findMany({
        where: { orgId: ORG },
        select: { createdAt: true },
      });
      const before = new Date(erasedAt.getTime() - 60 * 60 * 1000);
      const after = new Date(erasedAt.getTime() + 60 * 60 * 1000);

      const facts: { id: string; content: string; createdAt: Date }[] = [
        // Old copy, the name past the block's cut: still a copy the erasure removed.
        {
          id: "qa-name-past-cut",
          content: `${"Ticket history. ".repeat(300)}Escalated by ${NAME}.`,
          createdAt: before,
        },
        // Old copy, the name at the start: the case the restore suite already covers.
        { id: "qa-name-first", content: `${NAME} asked for a refund.`, createdAt: before },
        // Written at the erasure's very instant: not after it, so still a copy the erasure removed.
        { id: "qa-name-at-erasure", content: `${NAME} called about the refund.`, createdAt: erasedAt },
        // Written after the erasure: a deliberate re-add, served as usual.
        { id: "qa-name-readded", content: `${NAME} rejoined as a customer and asked for a call.`, createdAt: after },
        // Names nobody erased, longer than the cut, made of characters outside the BMP.
        { id: "qa-long-bystander", content: "\u{1F4E6}".repeat(FACT_TEXT_SERVED_CHARS + 200), createdAt: before },
      ];
      for (const fact of facts) {
        await db.memoryChunk.create({ data: { ...fact, orgId: ORG, entityName: fact.id, scopePath: SUPPORT } });
      }
      await db.changeEvent.createMany({
        data: facts.map((fact, i) => ({
          orgId: ORG,
          seq: BigInt(i + 1),
          scopePath: SUPPORT,
          recordType: "fact",
          recordId: fact.id,
          op: "create" as const,
          actorId: "qa",
          summary: fact.id,
          task: TASK,
          createdAt: fact.createdAt,
        })),
      });

      const { task } = await readServableTaskStart(ctx, SUPPORT, "", TASK, everything);
      servedIds = task.facts.map((fact) => fact.id).sort();
      served = new Map(task.facts.map((fact) => [fact.id, fact.content]));

      // Two writes no task named, found by the task's terms: an old copy naming the erased
      // person, and a bystander.
      const writes = [
        { id: "qa-write-names-erased", content: `Escalation ledger: ${NAME} asked for a refund.`, createdAt: before },
        { id: "qa-write-bystander", content: "Escalation ledger: a customer asked for a refund.", createdAt: before },
      ];
      for (const write of writes) {
        await db.memoryChunk.create({ data: { ...write, orgId: ORG, entityName: write.id, scopePath: SUPPORT } });
      }
      await db.changeEvent.createMany({
        data: writes.map((write, i) => ({
          orgId: ORG,
          seq: BigInt(100 + i),
          scopePath: SUPPORT,
          recordType: "fact",
          recordId: write.id,
          op: "create" as const,
          actorId: "qa",
          summary: "Escalation ledger entry",
          createdAt: write.createdAt,
        })),
      });
      const { context } = await readServableTaskStart(ctx, SUPPORT, "escalation ledger refund", "", everything);
      writeText = new Map(context.writes.map((write) => [write.recordId, write.content]));

      // A second, later erasure of someone else, so a summary naming the first person written
      // between the two is due the check and must be judged by her erasure's time, not the latest.
      await recordSuppressions(db, ORG, "qa-request-later", { emails: [], names: ["brannoch tull"], contactIds: [] });
      const laterErasure = new Date(after.getTime() + 60 * 60 * 1000);
      await db.$executeRaw`UPDATE "erasure_suppressions" SET "createdAt" = ${laterErasure} WHERE "orgId" = ${ORG} AND "createdAt" > ${erasedAt}`;

      // Restored change events whose own summary names the erased person, as an erasure would
      // have blanked it, beside summaries it would have left alone. Found by the term "handover".
      await db.memoryChunk.create({
        data: {
          id: "qa-summary-fact",
          orgId: ORG,
          entityName: "qa-summary-fact",
          scopePath: SUPPORT,
          content: "Handover checklist for the refund desk.",
          createdAt: before,
        },
      });
      const summaries = [
        {
          recordType: "brief",
          recordId: "qa-summary-names-erased",
          summary: `Handover brief for ${NAME}`,
          createdAt: before,
        },
        {
          recordType: "brief",
          recordId: "qa-summary-at-erasure",
          summary: `Handover call with ${NAME}`,
          createdAt: erasedAt,
        },
        {
          recordType: "brief",
          recordId: "qa-summary-readded",
          summary: `Handover: ${NAME} rejoined`,
          createdAt: after,
        },
        {
          recordType: "brief",
          recordId: "qa-summary-bystander",
          summary: "Handover brief for a customer",
          createdAt: before,
        },
        { recordType: "fact", recordId: "qa-summary-fact", summary: `Handover notes from ${NAME}`, createdAt: before },
      ];
      await db.changeEvent.createMany({
        data: summaries.map((event, i) => ({
          ...event,
          orgId: ORG,
          seq: BigInt(200 + i),
          scopePath: SUPPORT,
          op: "create" as const,
          actorId: "qa",
        })),
      });
      const byTerms = await readServableTaskStart(ctx, SUPPORT, "handover", "", everything);
      byTermsSummaries = new Map(byTerms.context.writes.map((write) => [write.recordId, write.summary]));

      // A task that names nothing is served the scope's newest writes by their summaries alone.
      const newest = [
        { recordId: "qa-newest-names-erased", summary: `${NAME} renewed the contract`, createdAt: before },
        { recordId: "qa-newest-bystander", summary: "A customer renewed the contract", createdAt: before },
        { recordId: "qa-newest-readded", summary: `${NAME} renewed again`, createdAt: after },
      ];
      await db.changeEvent.createMany({
        data: newest.map((event, i) => ({
          ...event,
          orgId: ORG,
          seq: BigInt(300 + i),
          scopePath: SUPPORT,
          recordType: "brief",
          op: "create" as const,
          actorId: "qa",
        })),
      });
      const unnamed = await readServableTaskStart(ctx, SUPPORT, "", "", everything);
      newestSummaries = new Map(unnamed.context.writes.map((write) => [write.recordId, write.summary]));
    });

    afterAll(async () => {
      if (QA_URL === undefined) return;
      await cleanup();
      await db.$disconnect();
    });

    it("serves exactly the re-added fact and the bystander", () => {
      expect(servedIds).toEqual(["qa-long-bystander", "qa-name-readded"]);
    });

    it("leaves out an old fact that names the erased person past character 4,000", () => {
      expect(servedIds).not.toContain("qa-name-past-cut");
    });

    it("leaves out a fact naming the erased person written at the erasure's instant", () => {
      expect(servedIds).not.toContain("qa-name-at-erasure");
    });

    it("serves a fact naming the person that was written after the erasure", () => {
      expect(served.get("qa-name-readded")).toContain(NAME);
    });

    it("leaves out a recent write whose fact is an old copy naming the erased person, and serves a bystander's with its text", () => {
      expect(writeText.has("qa-write-names-erased")).toBe(false);
      expect(writeText.get("qa-write-bystander")).toBe("Escalation ledger: a customer asked for a refund.");
    });

    it("leaves out a found write whose restored summary names the erased person, at or before the erasure", () => {
      expect(byTermsSummaries.has("qa-summary-names-erased")).toBe(false);
      expect(byTermsSummaries.has("qa-summary-at-erasure")).toBe(false);
    });

    it("leaves out a write whose summary names the erased person even when its fact passes", () => {
      expect(byTermsSummaries.has("qa-summary-fact")).toBe(false);
    });

    it("serves a found write whose summary names the person after her erasure, though before a later one, and a bystander's", () => {
      expect(byTermsSummaries.get("qa-summary-readded")).toBe(`Handover: ${NAME} rejoined`);
      expect(byTermsSummaries.get("qa-summary-bystander")).toBe("Handover brief for a customer");
    });

    it("leaves out a newest write whose restored summary names the erased person when the task names nothing", () => {
      expect([...newestSummaries.keys()].sort()).toEqual(["qa-newest-bystander", "qa-newest-readded"]);
    });

    it("cuts a served fact to 4,000 characters without splitting one", () => {
      expect(served.get("qa-long-bystander")).toBe("\u{1F4E6}".repeat(FACT_TEXT_SERVED_CHARS));
    });
  },
);
