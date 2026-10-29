// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An erased person stays gone after a backup taken before the erasure is restored
// (docs/consent-deletion-suite.md, "Bar 3:
// after a backup restore").
//
// A restore cannot be exercised from outside the product, so this suite plays one:
// it copies the person's rows (contacts, chunks, connector records) before the
// erasure, erases them, and writes the copies back, which is what restoring those
// tables from the older backup does. The suppression list is kept, as the restore
// procedure's first step requires. It then checks the three things that must hold:
//   - read: neither a vector read nor the task-start read of the task that wrote
//     them returns the restored chunks by email, name or phone, while a chunk
//     naming the person written after the erasure is still served;
//   - re-ingest: a connector re-sync of the restored records writes nothing naming
//     the person, whether the item is unchanged or changed;
//   - re-apply: `reapplyErasures` removes the restored contact and chunks, keeps
//     what was written after the erasure, and a second run removes nothing.
// A negative control restores the suppression list too, from the same backup, and
// shows the restored chunks are served again: the procedure's step that keeps the
// list is what makes the rest hold.
//
// Real: Postgres with pgvector, check(), the erasure, the suppression list, the
// vector read path, the task-start read and the connector item sync. Stand-in: the graph store, a spy,
// whose erasure is proven on Neo4j in memory-service/tests/test_person_erasure_integration.py.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const graphErase = vi.fn();
const graphPlan = vi.fn(async () => []);
const graphIngest = vi.fn();
vi.mock("./store", () => ({
  memory: { ingest: (...a: unknown[]) => graphIngest(...a) },
  graphitiStore: {
    planPersonErasure: (...a: unknown[]) => graphPlan(...(a as [])),
    erasePerson: (...a: unknown[]) => graphErase(...a),
    removeEpisode: async () => ({ removed: true }),
    removeChunkFacts: async () => {},
  },
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_restore";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const ADMIN = "qa_restore_admin";
const DIMENSIONS = 384;

const EMAIL = "talvi.quenmor@restore.example";
const NAME = "Talvi Quenmor";
const PHONE = "415 555 0142";
const MARKERS = [EMAIL, NAME, PHONE];

/** Restored facts filed under the person, whose text never names them. */
const FILED_UNDER_HER = ["c-filed-name", "c-filed-email"];
/** Another person's fact, whose text names a hyphenated surname that starts with hers. */
const BARNES_TEXT = `${NAME}-Barnes runs procurement.`;
/** Other people's facts: filed under a name containing hers, or naming a hyphenated surname. */
const FILED_FOR_OTHERS = ["c-filed-mary", "c-filed-barnes", "c-barnes-text"];

/**
 * Other people's contacts whose names contain hers, which the erasure leaves alone. Each
 * has its own address, so nothing but its name could tie it to her.
 */
const BYSTANDER_CONTACTS = [
  { id: "mary-tq", name: `Mary ${NAME}`, email: "mary@other.example" },
  { id: "tq-foundation", name: `${NAME} Foundation`, email: "hello@foundation.example" },
  { id: "ana-tq", name: "Ana Talvi-Quenmor", email: "ana@other.example" },
];
const BYSTANDER_IDS = BYSTANDER_CONTACTS.map((c) => c.id);

/** The task the chunks were written under, so the task-start read serves them back to it. */
const TASK = "SALES-118";

const vector = () => [1, ...Array(DIMENSIONS - 1).fill(0)];
const pgVector = (v: number[]) => `[${v.join(",")}]`;

describe.skipIf(!QA_URL)("after a backup from before an erasure is restored, the person stays gone", () => {
  /**
   * completeRestore's entries for this file's org: it walks every org in the worker's database,
   * and another file's org may be left there, so the list is never this file's alone.
   */
  const completeRestoreHere = async () => (await completeRestore()).filter((c) => c.orgId === ORG);

  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];
  let completeRestore: (typeof import("./erasure-reapply"))["completeRestore"];
  let erasuresApplied: (typeof import("./erasure-suppression"))["erasuresApplied"];
  let readableMemoryHolds: (typeof import("./readable-values"))["readableMemoryHolds"];
  let specificValuesIn: (typeof import("./specific-values"))["specificValuesIn"];
  let PgvectorMemoryStore: (typeof import("./pgvector-store"))["PgvectorMemoryStore"];
  let readServableTaskStart: (typeof import("./task-start"))["readServableTaskStart"];
  /** The task facts a task-start read serves, every one of them asked for, so every one is checked. */
  const servedTaskFacts = async () =>
    (await readServableTaskStart(admin, SALES, "", TASK, (read) => read.task.facts.map((fact) => fact.id))).task.facts;
  let readMemoryVersion: (typeof import("./versions"))["readMemoryVersion"];
  let readStoreOverview: (typeof import("./store-overview"))["readStoreOverview"];
  let syncOneTextItem: (typeof import("@/lib/inngest"))["syncOneTextItem"];
  let AccessDeniedError: (typeof import("@/services/access"))["AccessDeniedError"];

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const github = {
    id: "src-restore",
    orgId: ORG,
    type: "github",
    name: "acme/sales",
    scopePath: SALES,
    connectAuthorizationId: null,
  };

  /** Which markers `value` holds, outside text that names another person whose name contains hers. */
  const markersIn = (value: unknown) => {
    const text = JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))
      .replaceAll(BARNES_TEXT, "")
      .toLowerCase();
    return MARKERS.filter((m) => text.includes(m.toLowerCase()));
  };

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.contactIdempotencyKey.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  async function addChunk(id: string, content: string, createdAt: Date, entityName: string | null = null) {
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","entityName","scopePath","sourceId","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'text', 'extraction', ${entityName}, ${SALES}, ${github.id}, ${pgVector(vector())}::vector, ${createdAt})
    `;
  }

  /** The tables a restore brings back, as they stood before the erasure. */
  type Backup = {
    contacts: Awaited<ReturnType<PrismaClient["contact"]["findMany"]>>;
    chunks: { id: string; content: string; entityName: string | null; createdAt: Date }[];
    sourceFiles: Awaited<ReturnType<PrismaClient["sourceFile"]["findMany"]>>;
    suppressions: Awaited<ReturnType<PrismaClient["erasureSuppression"]["findMany"]>>;
    applied: Awaited<ReturnType<PrismaClient["erasureSuppressionApplied"]["findMany"]>>;
  };

  async function takeBackup(): Promise<Backup> {
    return {
      contacts: await db.contact.findMany({ where: { orgId: ORG } }),
      chunks: await db.$queryRaw<{ id: string; content: string; entityName: string | null; createdAt: Date }[]>`
        SELECT id, content, "entityName", "createdAt" FROM memory_chunks WHERE "orgId" = ${ORG}`,
      sourceFiles: await db.sourceFile.findMany({ where: { sourceId: github.id } }),
      suppressions: await db.erasureSuppression.findMany({ where: { orgId: ORG } }),
      applied: await db.erasureSuppressionApplied.findMany({ where: { orgId: ORG } }),
    };
  }

  /** Write the backup's rows back over the live tables, as a restore of those tables does. */
  async function restore(backup: Backup, { suppressionList }: { suppressionList: "kept" | "restored-from-backup" }) {
    for (const c of backup.contacts)
      await db.contact.upsert({ where: { id: c.id }, update: c as never, create: c as never });
    for (const c of backup.chunks) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id = ${c.id}`;
      await addChunk(c.id, c.content, c.createdAt, c.entityName);
    }
    await db.sourceFile.deleteMany({ where: { sourceId: github.id } });
    await db.sourceFile.createMany({ data: backup.sourceFiles as never });
    // The applied markers come back as the backup holds them; the procedure copies back only the list.
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });
    if (backup.applied.length) await db.erasureSuppressionApplied.createMany({ data: backup.applied });
    if (suppressionList === "restored-from-backup") {
      await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
      if (backup.suppressions.length) await db.erasureSuppression.createMany({ data: backup.suppressions });
    }
  }

  async function probe(): Promise<string> {
    const store = new PgvectorMemoryStore();
    const out: string[] = [];
    for (const query of [EMAIL, NAME, PHONE, "everyone we talked to"]) {
      out.push(
        JSON.stringify(
          await store.retrieve({
            groupId: ORG,
            tenantId: ORG,
            query,
            limit: 50,
            scopePath: SALES,
            includeUntagged: true,
          }),
        ),
      );
    }
    out.push(JSON.stringify(await servedTaskFacts()));
    return out.join("\n");
  }

  /** The chunks the task-start read serves back to the task that wrote them. */
  async function taskFactIds(): Promise<string[]> {
    return (await servedTaskFacts()).map((fact) => fact.id).sort();
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ reapplyErasures, completeRestore } = await import("./erasure-reapply"));
    ({ erasuresApplied } = await import("./erasure-suppression"));
    ({ readableMemoryHolds } = await import("./readable-values"));
    ({ specificValuesIn } = await import("./specific-values"));
    ({ PgvectorMemoryStore } = await import("./pgvector-store"));
    ({ readServableTaskStart } = await import("./task-start"));
    ({ readMemoryVersion } = await import("./versions"));
    ({ readStoreOverview } = await import("./store-overview"));
    ({ syncOneTextItem } = await import("@/lib/inngest"));
    ({ AccessDeniedError } = await import("@/services/access"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  let backup: Backup;
  const longAgo = new Date(Date.now() - 24 * 3600 * 1000);

  beforeEach(async () => {
    graphErase.mockReset();
    graphErase.mockResolvedValue({ episodes: 1, nodes: 1, edges: 1, summaries: 0, episodeIds: ["ep-talvi"] });
    graphIngest.mockReset();
    graphIngest.mockResolvedValue({ episodeId: "ep-new" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: vector() }), { status: 200 })),
    );
    await wipe();

    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@restore.test", role: "admin", clerkId: "clerk-restore-admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });

    await db.contact.create({ data: { id: "talvi", orgId: ORG, name: NAME, email: EMAIL, createdAt: longAgo } });
    await db.contact.create({
      data: { id: "kenji", orgId: ORG, name: "Kenji Sato", email: "kenji@acme.example", createdAt: longAgo },
    });
    for (const c of BYSTANDER_CONTACTS) await db.contact.create({ data: { ...c, orgId: ORG, createdAt: longAgo } });
    await db.source.create({
      data: {
        id: github.id,
        orgId: ORG,
        type: "github",
        externalId: "acme/sales",
        name: github.name,
        scopePath: SALES,
      },
    });
    await db.sourceFile.createMany({
      data: [
        {
          sourceId: github.id,
          externalFileId: "issue-1",
          checksum: "v1",
          episodeId: "ep-talvi",
          episodeScopePath: SALES,
        },
        {
          sourceId: github.id,
          externalFileId: "issue-2",
          checksum: "v1",
          episodeId: "ep-kenji",
          episodeScopePath: SALES,
        },
      ],
    });
    await addChunk("c-talvi", `Issue #1: ${NAME} (${EMAIL}, +1 ${PHONE}) asked for the annual plan.`, longAgo);
    await addChunk("c-talvi-phone", `Callback for ${NAME} on ${PHONE}.`, longAgo);
    await addChunk("c-kenji", "Issue #2: Kenji Sato renewed the annual plan.", longAgo);
    // Facts as memory_ingest files them: under the entity they are about, so their text
    // may never name the person (FILED_UNDER_HER), and other people's facts filed under
    // names that contain hers (FILED_FOR_OTHERS).
    await addChunk("c-filed-name", "She asked for the annual plan.", longAgo, NAME);
    await addChunk("c-filed-email", "Forwarded the pricing sheet.", longAgo, EMAIL);
    await addChunk("c-filed-mary", "Signed the order.", longAgo, `Mary ${NAME}`);
    await addChunk("c-filed-barnes", "Runs procurement.", longAgo, `${NAME}-Barnes`);
    await addChunk("c-barnes-text", BARNES_TEXT, longAgo);
    // The chunks were written under one task, as an agent's memory_ingest records them.
    await db.changeEvent.createMany({
      data: ["c-talvi", "c-talvi-phone", "c-kenji", "c-filed-name"].map((recordId, i) => ({
        orgId: ORG,
        seq: BigInt(i + 1),
        scopePath: SALES,
        recordType: "fact",
        recordId,
        op: "create" as const,
        actorId: "agent-sales",
        summary: recordId,
        task: TASK,
        createdAt: longAgo,
      })),
    });

    // Positive control: the reader sees the person before anything happens.
    expect(markersIn(await probe())).toEqual(MARKERS);
    expect(await taskFactIds()).toEqual(["c-filed-name", "c-kenji", "c-talvi", "c-talvi-phone"]);
    backup = await takeBackup();
    await erasePerson(admin, { contactId: "talvi" });
    expect(markersIn(await probe())).toEqual([]);
  });

  it("records the org's erasures as applied when the erasure completes", async () => {
    expect(await erasuresApplied(ORG)).toBe(true);
    const listed = await db.erasureSuppression.count({ where: { orgId: ORG } });
    const applied = await db.erasureSuppressionApplied.findMany({ where: { orgId: ORG } });
    expect(applied).toHaveLength(listed);
    expect(new Set(applied.map((a) => a.by)).size).toBe(1);
    expect(applied[0]!.by).toMatch(/^person_erasure:/);
  });

  // Outside any restore, a live write that adds to the suppression
  // list and removes what it lists in the same transaction (memory ingest withdrawing a
  // correction of an erased version, lib/inngest/memory-ingest.ts) leaves every erasure
  // carried out, so the org must still read as applied, and the value check must still
  // answer. Otherwise the note goes silent in the org until the next erasure.
  it("QA: withdrawing a correction of an erased version keeps the org applied, and the value check still answers", async () => {
    const { withdrawCorrectionOfErased } = await import("./erasure-lineage");
    const rows = { orgId: ORG, scope: SALES, includeUntagged: false };
    const values = specificValuesIn("Did Orrin Vastel sign?");
    expect(await erasuresApplied(ORG)).toBe(true);
    expect(await readableMemoryHolds(rows, values)).toEqual([false]);
    await addChunk("c-correction", "She moved to the enterprise plan.", new Date());
    await withdrawCorrectionOfErased({ groupId: ORG, correctionOf: { factId: "c-talvi" } } as never, "c-correction");
    expect(await db.memoryChunk.count({ where: { orgId: ORG, id: "c-correction" } })).toBe(0);
    expect(await erasuresApplied(ORG)).toBe(true);
    expect(await readableMemoryHolds(rows, values)).toEqual([false]);
  });

  it("reads as applied after an erasure that failed before its first step is sent again and completes", async () => {
    // The first attempt lists the person, then stops at the graph's plan, before any step;
    // the retry is a new request that finds no step of the first, and must still cover the
    // entries the first listed.
    graphPlan.mockRejectedValueOnce(new Error("graph store unavailable"));
    await expect(erasePerson(admin, { contactId: "kenji" })).rejects.toThrow(/graph store unavailable/);
    expect(await erasuresApplied(ORG)).toBe(false);
    await erasePerson(admin, { contactId: "kenji" });
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  it("reads as applied after a version that escaped an earlier erasure is removed", async () => {
    const { eraseEscapedReplacements } = await import("./erasure-lineage-backfill");
    // A version an earlier erasure blanked and removed, and a correction written in place of it.
    const before = new Date(longAgo.getTime() - 60_000);
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(90),
        scopePath: SALES,
        recordType: "fact",
        recordId: "c-escaped-old",
        op: "create",
        actorId: "agent-sales",
        summary: "",
        createdAt: before,
      },
    });
    await addChunk("c-escaped-new", "Moved to the enterprise plan.", longAgo);
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(91),
        scopePath: SALES,
        recordType: "fact",
        recordId: "c-escaped-new",
        op: "create",
        actorId: "agent-sales",
        summary: "c-escaped-new",
        createdAt: longAgo,
      },
    });
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "c-escaped-new",
        toId: "c-escaped-old",
        kind: "supersedes",
        scopePath: SALES,
        actorType: "agent",
        actorId: "agent-sales",
      },
    });
    const result = await eraseEscapedReplacements(admin);
    expect(result.replacements).toEqual(["c-escaped-new"]);
    expect(await db.memoryChunk.count({ where: { orgId: ORG, id: "c-escaped-new" } })).toBe(0);
    expect(await erasuresApplied(ORG)).toBe(true);
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
  });

  it("finds an admin who holds the org root's admin grant with only a member's role", async () => {
    await restore(backup, { suppressionList: "kept" });
    await db.user.update({ where: { id: ADMIN }, data: { role: "member" } });
    await db.orgMembership.updateMany({ where: { orgId: ORG, userId: ADMIN }, data: { role: "member" } });
    const [completion] = await completeRestoreHere();
    expect(completion).toMatchObject({ orgId: ORG, applied: true, adminUserId: ADMIN });
  });

  it("leaves the org not applied while another erasure is still running, until that one completes too", async () => {
    const { recordSuppressions, markApplied } = await import("./erasure-suppression");
    // A second erasure has recorded its entries and not yet removed what they name.
    await recordSuppressions(db, ORG, "running-request", {
      emails: ["ola.running@restore.example"],
      names: ["ola running"],
      contactIds: [],
    });
    await erasePerson(admin, { contactId: "kenji" });
    expect(await erasuresApplied(ORG)).toBe(false);
    await markApplied(db, ORG, "person_erasure:running-request", { requestIds: ["running-request"] });
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  describe("with the suppression list kept through the restore", () => {
    beforeEach(async () => {
      await restore(backup, { suppressionList: "kept" });
    });

    it("reads as not applied until the restore is completed, and memory_query's value check makes no claim meanwhile", async () => {
      const rows = { orgId: ORG, scope: SALES, includeUntagged: false };
      // Her address, which only her restored rows held, and a bystander's name.
      const values = specificValuesIn(`Did we write to "${EMAIL}" or Kenji Sato?`);
      expect(await erasuresApplied(ORG)).toBe(false);
      expect(await readableMemoryHolds(rows, values)).toBeNull();

      const completions = await completeRestoreHere();
      expect(completions).toEqual([expect.objectContaining({ orgId: ORG, applied: true, adminUserId: ADMIN })]);
      expect(await erasuresApplied(ORG)).toBe(true);
      expect(markersIn(await probe())).toEqual([]);
      expect(await readableMemoryHolds(rows, values)).toEqual([false, true]);
      // A second run finds every org applied and touches nothing.
      expect(await completeRestoreHere()).toEqual([{ orgId: ORG, applied: true }]);
    });

    // A receipt says every erasure on the list is carried out. An
    // erasure that completes on the restored database before the re-apply has run carried
    // out only its own, so the org must still read as not applied, and completing the
    // restore must still remove her restored rows.
    it("QA: an erasure completed on the restored database before the re-apply does not mark the org applied", async () => {
      expect(await erasuresApplied(ORG)).toBe(false);
      await erasePerson(admin, { contactId: "kenji" });
      expect.soft(await erasuresApplied(ORG)).toBe(false);
      await completeRestoreHere();
      expect(await db.contact.count({ where: { orgId: ORG, id: "talvi" } })).toBe(0);
      expect(await db.memoryChunk.count({ where: { orgId: ORG, id: { in: ["c-talvi", "c-talvi-phone"] } } })).toBe(0);
    });

    // A re-apply that fails part-way must leave the org not applied,
    // so running complete-restore again finishes it. Here a second person, erased on the live
    // database after the backup, is on the copied-back list with rows the backup restored;
    // her graph erasure fails during the re-apply after the first person's succeeded.
    it("QA: a re-apply that fails part-way leaves the org not applied, and a second run completes it", async () => {
      const { recordSuppressions } = await import("./erasure-suppression");
      const noorEmail = "noor.halvai@restore.example";
      await db.contact.create({
        data: {
          id: "noor",
          orgId: ORG,
          name: "Noor Halvai",
          email: noorEmail,
          createdAt: new Date(longAgo.getTime() + 60_000),
        },
      });
      await addChunk("c-noor", `Noor Halvai (${noorEmail}) asked about pricing.`, longAgo);
      await recordSuppressions(db, ORG, "live-erasure-noor", {
        emails: [noorEmail],
        names: ["noor halvai"],
        contactIds: ["noor"],
      });
      graphErase.mockImplementation(async (input: { emails: string[] }) => {
        if (input.emails.includes(noorEmail)) throw new Error("graph store unavailable");
        return { episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] };
      });
      const [first] = await completeRestoreHere();
      expect(first).toMatchObject({ orgId: ORG, applied: false });
      expect.soft(await erasuresApplied(ORG)).toBe(false);

      graphErase.mockResolvedValue({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] });
      const [second] = await completeRestoreHere();
      expect(second).toMatchObject({ orgId: ORG, applied: true });
      expect(await db.contact.count({ where: { orgId: ORG, id: "noor" } })).toBe(0);
      expect(await db.memoryChunk.count({ where: { orgId: ORG, id: "c-noor" } })).toBe(0);
    });

    it("does not call the restore complete when no owner or admin may run the re-apply, and removes nothing", async () => {
      await db.grant.deleteMany({ where: { orgId: ORG, granteeId: ADMIN } });
      const before = await db.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM memory_chunks WHERE "orgId" = ${ORG}`;
      const [completion] = await completeRestoreHere();
      expect(completion).toMatchObject({ orgId: ORG, applied: false });
      expect(completion!.error).toMatch(/no owner, admin or admin grantee/);
      expect(
        await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM memory_chunks WHERE "orgId" = ${ORG}`,
      ).toEqual(before);
      expect(await erasuresApplied(ORG)).toBe(false);
    });

    it("serves none of the restored chunks by email, name or phone, and still serves the bystander", async () => {
      // The restore really put them back.
      expect(await db.memoryChunk.count({ where: { orgId: ORG, id: { in: ["c-talvi", "c-talvi-phone"] } } })).toBe(2);
      const after = await probe();
      expect(markersIn(after)).toEqual([]);
      expect(after).toContain("Kenji Sato renewed");
      expect(await taskFactIds()).toEqual(["c-kenji"]);
    });

    it("serves no restored fact filed under the person, by vector read, task start or memory_version", async () => {
      expect(await db.memoryChunk.count({ where: { orgId: ORG, id: { in: FILED_UNDER_HER } } })).toBe(2);
      const after = await probe();

      expect(after).not.toContain("She asked for the annual plan");
      expect(after).not.toContain("Forwarded the pricing sheet");
      expect(await taskFactIds()).not.toContain("c-filed-name");
      // Restored copies whose text names her, too: memory_version had no erased filter at all.
      for (const id of [...FILED_UNDER_HER, "c-talvi", "c-talvi-phone"]) {
        expect(await readMemoryVersion(admin, id), id).toBeNull();
      }
    });

    it("still serves other people's facts filed under, or naming, names that contain the person's", async () => {
      const after = await probe();

      expect(after).toContain("Signed the order.");
      expect(after).toContain("Runs procurement.");
      expect(after).toContain(BARNES_TEXT);
      for (const id of FILED_FOR_OTHERS) expect(await readMemoryVersion(admin, id), id).not.toBeNull();
    });

    it("lists none of the restored facts in the store overview, and still lists the others'", async () => {
      const listed = (await readStoreOverview(ORG, SALES)).chunks.map((c) => c.id).sort();

      expect(listed).toEqual(["c-kenji", ...FILED_FOR_OTHERS].sort());
    });

    it("re-applies the erasure to restored facts filed under the person, and keeps the others'", async () => {
      await reapplyErasures(admin);

      const left = await db.memoryChunk.findMany({
        where: { orgId: ORG, id: { in: [...FILED_UNDER_HER, ...FILED_FOR_OTHERS] } },
        select: { id: true },
      });
      expect(left.map((c) => c.id).sort()).toEqual([...FILED_FOR_OTHERS].sort());
    });

    it("still serves a chunk naming the person that was written after the erasure: a deliberate re-add is not hidden", async () => {
      await addChunk("c-talvi-again", `${NAME} signed up again on their own.`, new Date(Date.now() + 1000));
      expect(markersIn(await probe())).toEqual([NAME]);
    });

    it("does not write the person back on a re-sync of the restored records, unchanged or changed", async () => {
      const text = `Issue #1: ${NAME} (${EMAIL}) asked for the annual plan.`;
      // The sync's plan skips an unchanged checksum before it reaches the item at all; an item it
      // does reach, the restored version or an edit of it, is stopped by the suppression list.
      const outcomes = [];
      for (const checksum of ["v1", "v2"])
        outcomes.push(await syncOneTextItem(github, { id: "issue-1", text, checksum }, null));
      expect(outcomes).toEqual(["skipped", "skipped"]);
      expect(graphIngest).not.toHaveBeenCalled();
      expect(markersIn(await db.changeEvent.findMany({ where: { orgId: ORG, op: "create" } }))).toEqual([]);
    });

    it("re-applies the erasure to a restored contact, through the full erasure, and a second run removes nothing", async () => {
      const first = await reapplyErasures(admin);
      expect(first).toMatchObject({ contactsErased: 1 });
      expect(first.requestIds).toHaveLength(1);
      expect(
        (await db.contact.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id).sort(),
      ).toEqual([...BYSTANDER_IDS, "kenji"].sort());
      expect(
        (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id).sort(),
      ).toEqual(["c-kenji", ...FILED_FOR_OTHERS].sort());
      // The restored contact carried the plain text the graph erasure needs, so the graph was asked again.
      expect(graphErase).toHaveBeenLastCalledWith(
        expect.objectContaining({ emails: [EMAIL], names: [NAME.toLowerCase()] }),
      );
      expect(
        await db.auditLog.count({
          where: { orgId: ORG, action: "access.manage", target: { endsWith: "person_erasure:reapply" } },
        }),
      ).toBe(1);

      const second = await reapplyErasures(admin);
      expect(second).toEqual({
        contactsErased: 0,
        requestIds: [],
        reAddedContactsRemoved: 0,
        chunksRemoved: 0,
        uploadsRemoved: 0,
        rulesRedacted: 0,
        briefsRemoved: 0,
        notesRemoved: 0,
      });
    });

    it("removes restored chunks that no restored contact names, and keeps content written after the erasure", async () => {
      await db.contact.deleteMany({ where: { orgId: ORG, id: "talvi" } });
      await addChunk("c-talvi-again", `${NAME} signed up again on their own.`, new Date(Date.now() + 1000));

      const result = await reapplyErasures(admin);

      // Her two restored chunks naming her in their text, and the two filed under her.
      expect(result).toEqual({
        contactsErased: 0,
        requestIds: [],
        reAddedContactsRemoved: 0,
        chunksRemoved: 4,
        uploadsRemoved: 0,
        rulesRedacted: 0,
        briefsRemoved: 0,
        notesRemoved: 0,
      });
      expect(
        (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id).sort(),
      ).toEqual(["c-kenji", "c-talvi-again", ...FILED_FOR_OTHERS].sort());
    });

    it("keeps a person re-added after the erasure when a restored contact names them, and removes only what the backup put back", async () => {
      const later = new Date(Date.now() + 1000);
      await db.contact.create({ data: { id: "talvi-again", orgId: ORG, name: NAME, email: EMAIL, createdAt: later } });
      await addChunk("c-talvi-again", `${NAME} signed up again on their own.`, later);

      const result = await reapplyErasures(admin);

      expect(result).toMatchObject({ contactsErased: 0, requestIds: [], reAddedContactsRemoved: 1, chunksRemoved: 4 });
      expect(
        (await db.contact.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id).sort(),
      ).toEqual([...BYSTANDER_IDS, "kenji", "talvi-again"].sort());
      expect(
        (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id).sort(),
      ).toEqual(["c-kenji", "c-talvi-again", ...FILED_FOR_OTHERS].sort());
      // The graph holds the re-added person's content too, and nothing there tells old from new.
      expect(graphErase).toHaveBeenCalledTimes(1);
    });

    it("knows a person re-added under her name folded otherwise (Turkish capitals, an address in capitals) as a re-add", async () => {
      // Compared as the erasure folds names and addresses (foldName): "TALV\u0130 QUENMOR" is
      // "talvi quenmor", where lowercasing alone gives an "i" and a combining dot.
      const later = new Date(Date.now() + 1000);
      await db.contact.create({
        data: { id: "talvi-again", orgId: ORG, name: "TALV\u0130 QUENMOR", email: null, createdAt: later },
      });
      await addChunk("c-talvi-again", `${NAME} signed up again on their own.`, later);

      const result = await reapplyErasures(admin);

      expect(result).toMatchObject({ contactsErased: 0, requestIds: [], reAddedContactsRemoved: 1, chunksRemoved: 4 });
      expect(
        (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id).sort(),
      ).toEqual(["c-kenji", "c-talvi-again", ...FILED_FOR_OTHERS].sort());
    });

    it("refuses a caller without access.manage and removes nothing", async () => {
      await db.user.create({
        data: {
          id: "qa_restore_member",
          orgId: ORG,
          email: "m@restore.test",
          role: "member",
          clerkId: "clerk-restore-m",
        },
      });
      const member: AccessContext = {
        orgId: ORG,
        actor: { type: "human", id: "qa_restore_member", role: "member" },
        origin: "app",
      };
      // No restored contact, so the refusal cannot come from the per-contact erasure's own check.
      await db.contact.deleteMany({ where: { orgId: ORG, id: "talvi" } });
      await expect(reapplyErasures(member)).rejects.toBeInstanceOf(AccessDeniedError);
      expect(await db.memoryChunk.count({ where: { orgId: ORG } })).toBe(
        3 + FILED_UNDER_HER.length + FILED_FOR_OTHERS.length,
      );
    });
  });

  it("erases no other person's contact when re-applied with nothing restored", async () => {
    const result = await reapplyErasures(admin);

    expect(result).toEqual({
      contactsErased: 0,
      requestIds: [],
      reAddedContactsRemoved: 0,
      chunksRemoved: 0,
      uploadsRemoved: 0,
      rulesRedacted: 0,
      briefsRemoved: 0,
      notesRemoved: 0,
    });
    expect(
      (await db.contact.findMany({ where: { orgId: ORG }, select: { id: true } })).map((c) => c.id).sort(),
    ).toEqual([...BYSTANDER_IDS, "kenji"].sort());
    // Only the erasure itself reached the graph.
    expect(graphErase).toHaveBeenCalledTimes(1);
  });

  it("negative control: restoring the suppression list from the same backup brings the person back on read", async () => {
    await restore(backup, { suppressionList: "restored-from-backup" });
    expect(await db.erasureSuppression.count({ where: { orgId: ORG } })).toBe(0);
    expect(markersIn(await probe())).toEqual(MARKERS);
  });
});
