// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The applied state (erasure-suppression.ts, markApplied) on every path that adds to an org's
// suppression list or removes what it stands for, beyond the ones the no-readable-match suites
// cover: names recorded as "joined_name", a second erasure of a person already erased (which
// moves their entries' time), working notes and briefs an erasure or a re-apply deletes, and
// the re-apply an import runs. Each test fails a step after the list is written and checks the
// org does not read as applied until the step completes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const graphPlan = vi.fn(async () => []);
vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: (...a: unknown[]) => graphPlan(...(a as [])),
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeEpisode: async () => ({ removed: true }),
    removeChunkFacts: async () => {},
    removeGroupFacts: async () => ({ removedCount: 0 }),
  },
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));
// A pass-through, so a test can run another erasure's listing right after a re-apply loads its filter.
vi.mock("./erasure-suppression", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./erasure-suppression")>();
  return { ...actual, loadErasedContentFilter: vi.fn(actual.loadErasedContentFilter) };
});

const QA_URL = process.env.QA_DATABASE_URL;

// Alphanumeric, so the org root is a valid ltree label.
const ORG = "erasureappliedpaths";
const ROOT = `org_${ORG}`;
const ADMIN = "u-erasure-applied-paths";
const NAME = "Anne-Marie Dupontel";
const EMAIL = "anne-marie@applied-paths.example";
const DIMENSIONS = 384;
const LONG_AGO = new Date(Date.now() - 24 * 3600 * 1000);

function embed(text: string): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < DIMENSIONS; block++) {
    for (const byte of createHash("sha256").update(`${block}:${text}`).digest()) vector.push(byte / 255 - 0.5);
  }
  const unit = vector.slice(0, DIMENSIONS);
  const norm = Math.hypot(...unit);
  return unit.map((x) => x / norm);
}

async function embeddingService(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(url instanceof Request ? url.url : url)).pathname;
  const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; texts?: string[] };
  if (path === "/embed") return Response.json({ embedding: embed(body.text ?? "") });
  if (path === "/embed-batch") return Response.json({ embeddings: (body.texts ?? []).map(embed) });
  return new Response("not found", { status: 404 });
}

const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
/** The migration's backfill statement, as it ships. */
function backfillStatement(): string {
  const sql = readFileSync(
    join(process.cwd(), "prisma/migrations/20261016070000_erasure_suppressions_applied/migration.sql"),
    "utf8",
  );
  const start = sql.indexOf('INSERT INTO "erasure_suppressions_applied"');
  return `${sql.slice(start, sql.indexOf(";", start)).trim()} ON CONFLICT DO NOTHING`;
}
const HOUR = 3600_000;

/** Past the current millisecond, so a time recorded next is later than one recorded before. */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe.skipIf(!QA_URL)("erasures recorded as applied on every path, real Postgres", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];
  let suppression: typeof import("./erasure-suppression");
  let erasuresApplied: (typeof import("./erasure-suppression"))["erasuresApplied"];
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let importMemory: (typeof import("./org-import"))["importMemory"];
  let ImportIncompleteError: (typeof import("./org-import"))["ImportIncompleteError"];

  /** Make every DELETE on `table` in this org fail, until {@link allowDeletes}. */
  async function failDeletes(table: string) {
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION eap_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'eap: % delete fails', TG_TABLE_NAME; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER eap_fail BEFORE DELETE ON ${table}
      FOR EACH ROW WHEN (OLD."orgId" = '${ORG}') EXECUTE FUNCTION eap_fail()`);
  }
  async function allowDeletes(table: string) {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS eap_fail ON ${table}`);
    await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS eap_fail()");
  }

  async function wipe() {
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.workingNote.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  async function addChunk(id: string, content: string, createdAt = new Date()) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "factVersion", embedding, "createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'text', 'agent', 'agent-1', ${ROOT}, false, ${`[${embed(content).join(",")}]`}::vector, ${createdAt})`;
  }
  const chunks = async () => db.memoryChunk.count({ where: { orgId: ORG } });

  async function addNote(body: string, createdAt = new Date()) {
    await db.workingNote.create({
      data: {
        orgId: ORG,
        scopePath: ROOT,
        agentId: "agent-1",
        task: "acme",
        kind: "status",
        body,
        createdAt,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
  }
  async function addBrief(summary: string, createdAt = new Date()) {
    await db.brief.create({
      data: { orgId: ORG, type: "handoff", scopePath: ROOT, title: "Renewal", summary, sections: [], createdAt },
    });
  }

  /** The applied markers as a restore of an older backup brings them back: none. */
  const restoredOverOlderMarkers = () => db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn(embeddingService));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ reapplyErasures } = await import("./erasure-reapply"));
    suppression = await import("./erasure-suppression");
    ({ erasuresApplied } = suppression);
    ({ exportMemory } = await import("./org-export"));
    ({ importMemory, ImportIncompleteError } = await import("./org-import"));
  });

  beforeEach(async () => {
    graphPlan.mockReset();
    graphPlan.mockResolvedValue([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await wipe();
    await db.org.create({ data: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@applied-paths.test", role: "admin", clerkId: "clerk-applied-paths" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({ data: { id: "anne", orgId: ORG, name: NAME, email: EMAIL, createdAt: LONG_AGO } });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  it("marks the joined_name entries an erasure records, with the rest of its list", async () => {
    await erasePerson(admin, { contactId: "anne" });
    const joined = await db.erasureSuppression.findMany({
      where: { orgId: ORG, kind: "joined_name" },
      include: { applied: true },
    });
    // "anne marie dupontel" written without spaces: "-" or " " at the mark, " " or "\n" between words.
    expect(joined.length).toBeGreaterThan(0);
    expect(joined.every((entry) => entry.applied !== null)).toBe(true);
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  it("a second erasure by name re-marks the joined_name entries the first one listed", async () => {
    await erasePerson(admin, { contactId: "anne" });
    await tick();
    // Added again, under another address: her name's entries keep the first request's id, so
    // only the second erasure's own values (markApplied, person) can mark them again.
    await db.contact.create({ data: { id: "anne-2", orgId: ORG, name: NAME, email: "anne-marie@elsewhere.example" } });
    await erasePerson(admin, { contactId: "anne-2" });
    const joined = await db.erasureSuppression.findMany({
      where: { orgId: ORG, kind: "joined_name" },
      include: { applied: true },
    });
    expect(joined.length).toBeGreaterThan(0);
    expect(joined.every((entry) => entry.applied?.by.startsWith("person_erasure:") && entry.createdAt > LONG_AGO)).toBe(
      true,
    );
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  it("an erasure does not mark an entry another erasure of the same person listed again while it ran", async () => {
    await erasePerson(admin, { contactId: "anne" });
    await addChunk("c-since", `${EMAIL} asked for the March invoice.`);
    // The second erasure (by her address) lists her while the third (by contact, added again) is
    // between its own listing and its last transaction; then the second fails.
    await db.contact.create({ data: { id: "anne-2", orgId: ORG, name: NAME, email: EMAIL } });
    graphPlan.mockImplementationOnce(async () => {
      await tick();
      await suppression.recordSuppressions(db, ORG, "concurrent-erasure", {
        emails: [EMAIL],
        names: [],
        contactIds: [],
      });
      return [];
    });
    await erasePerson(admin, { contactId: "anne-2" });
    // The address entry now stands for what was written up to the concurrent erasure's listing,
    // which has not finished: not applied.
    expect(await erasuresApplied(ORG)).toBe(false);
    await erasePerson(admin, { email: EMAIL });
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  it("a re-apply does not mark an entry an erasure listed again after the re-apply loaded its filter", async () => {
    await erasePerson(admin, { contactId: "anne" });
    await addChunk("c-since", `${EMAIL} asked for the March invoice.`);
    await restoredOverOlderMarkers();
    const actual = await vi.importActual<typeof import("./erasure-suppression")>("./erasure-suppression");
    vi.mocked(suppression.loadErasedContentFilter).mockImplementationOnce(async (orgId: string) => {
      const filter = await actual.loadErasedContentFilter(orgId);
      // A second erasure of her lists her address now, and then fails before removing anything.
      await tick();
      await suppression.recordSuppressions(db, ORG, "second-erasure", { emails: [EMAIL], names: [], contactIds: [] });
      return filter;
    });

    await reapplyErasures(admin);

    // The re-apply judged the chunk by the old time and kept it; the second erasure has not run.
    expect(await chunks()).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);
    await erasePerson(admin, { email: EMAIL });
    expect(await chunks()).toBe(0);
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  it("erasures and re-applies of one org running at once all finish, with no deadlock, and leave it applied", async () => {
    // The applied-markers lock is taken last in every transaction that marks and alone in a
    // listing (erasure-suppression.ts, lockAppliedMarkers); a cycle with the audit chain, the
    // change feed or the note locks would show here as a rejected call.
    await erasePerson(admin, { contactId: "anne" });
    for (let round = 0; round < 5; round++) {
      await addChunk(`c-round-${round}`, `${EMAIL} asked for invoice ${round}.`);
      await addNote(`Waiting on ${NAME}, round ${round}.`);
      const results = await Promise.allSettled([
        erasePerson(admin, { email: EMAIL }),
        reapplyErasures(admin),
        erasePerson(admin, { email: EMAIL }),
        reapplyErasures(admin),
      ]);
      expect(
        results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);
      expect(await erasuresApplied(ORG)).toBe(true);
    }
    expect(await chunks()).toBe(0);
  }, 60_000);

  it("an erasure that lists her again while the first runs, then fails, leaves her entries unapplied, at run time and by the backfill", async () => {
    // Erasure A (by contact) is past its listing; erasure B (by address) lists her again and
    // fails; then A completes and writes its person.erased row.
    graphPlan
      .mockImplementationOnce(async () => {
        await expect(erasePerson(admin, { email: EMAIL })).rejects.toThrow(/graph store unavailable/);
        return [];
      })
      .mockImplementationOnce(async () => {
        throw new Error("graph store unavailable");
      });
    await addChunk("c-between", `${EMAIL} asked for the July invoice.`);
    await erasePerson(admin, { contactId: "anne" });
    expect(await db.auditLog.count({ where: { orgId: ORG, action: "person.erased" } })).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);

    // The migration over this state: A completed, but her address entry is B's to carry out.
    await restoredOverOlderMarkers();
    await db.$executeRawUnsafe(backfillStatement());
    const email = await db.erasureSuppression.findFirst({
      where: { orgId: ORG, kind: "email" },
      include: { applied: true },
    });
    expect(email?.applied).toBeNull();
    expect(
      await db.erasureSuppression.count({ where: { orgId: ORG, kind: "contact_id", applied: { isNot: null } } }),
    ).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);
  });

  it("a listing's time is later than every earlier listing's, whatever the app clock says", async () => {
    const first = await suppression.recordSuppressions(db, ORG, "first", {
      emails: [EMAIL],
      names: [NAME],
      contactIds: [],
    });
    await db.$transaction((tx) => suppression.markApplied(tx, ORG, "first", { requestIds: ["first"], asOf: first }));
    expect(await erasuresApplied(ORG)).toBe(true);
    // This instance's clock is an hour behind the one that listed her first.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - HOUR });
    try {
      const second = await suppression.recordSuppressions(db, ORG, "second", {
        emails: [EMAIL],
        names: [],
        contactIds: [],
      });
      expect(second.getTime()).toBeGreaterThan(first.getTime());
    } finally {
      vi.useRealTimers();
    }
    const email = await db.erasureSuppression.findFirst({ where: { orgId: ORG, kind: "email" } });
    expect(email!.createdAt.getTime()).toBeGreaterThan(first.getTime());
    // A name entry written an hour ahead (an instance whose clock ran fast, before listings took
    // the database's): the next listing is still later than it.
    await db.$executeRaw`UPDATE erasure_suppressions SET "createdAt" = "createdAt" + interval '1 hour' WHERE "orgId" = ${ORG} AND kind = 'text_name'`;
    const ahead = (await db.erasureSuppression.findFirst({ where: { orgId: ORG, kind: "text_name" } }))!.createdAt;
    const third = await suppression.recordSuppressions(db, ORG, "third", {
      emails: [EMAIL],
      names: [],
      contactIds: [],
    });
    expect(third.getTime()).toBeGreaterThan(ahead.getTime());
    // The first erasure, marking again as of its own listing, cannot mark what the second moved.
    await db.$transaction((tx) => suppression.markApplied(tx, ORG, "first", { requestIds: ["first"], asOf: first }));
    expect(await erasuresApplied(ORG)).toBe(false);
  });

  it("a re-apply on an instance whose clock runs ahead does not mark an entry an erasure listed again", async () => {
    await erasePerson(admin, { contactId: "anne" });
    await addChunk("c-since", `${EMAIL} asked for the August invoice.`);
    await restoredOverOlderMarkers();
    const actual = await vi.importActual<typeof import("./erasure-suppression")>("./erasure-suppression");
    vi.mocked(suppression.loadErasedContentFilter).mockImplementationOnce(async (orgId: string) => {
      const filter = await actual.loadErasedContentFilter(orgId);
      // Another instance, with the right time, lists her again; then that erasure fails.
      vi.useRealTimers();
      await suppression.recordSuppressions(db, ORG, "second-erasure", { emails: [EMAIL], names: [], contactIds: [] });
      return filter;
    });
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + HOUR });
    try {
      await reapplyErasures(admin);
    } finally {
      vi.useRealTimers();
    }
    expect(await chunks()).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);
  });

  it("a second erasure of a person already erased reads as not applied until it removes what was written since", async () => {
    await erasePerson(admin, { contactId: "anne" });
    expect(await erasuresApplied(ORG)).toBe(true);
    // Written after the first erasure: deliberate, and served until she is erased again.
    await addChunk("c-since", `${EMAIL} asked for the March invoice.`);
    // The second erasure lists her address again, moving that entry's time past the chunk,
    // and then the graph store is unavailable: the list is written and nothing removed.
    graphPlan.mockRejectedValueOnce(new Error("graph store unavailable"));
    await expect(erasePerson(admin, { email: EMAIL })).rejects.toThrow(/graph store unavailable/);
    expect(await chunks()).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);

    await erasePerson(admin, { email: EMAIL });
    expect(await chunks()).toBe(0);
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  it("an erasure whose working-note deletion fails marks nothing; sent again, it does", async () => {
    await addNote(`Waiting on ${NAME} for the renewal.`);
    await failDeletes("working_notes");
    try {
      await expect(erasePerson(admin, { contactId: "anne" })).rejects.toThrow(/working_notes delete fails/);
    } finally {
      await allowDeletes("working_notes");
    }
    expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(false);

    await erasePerson(admin, { contactId: "anne" });
    expect(await db.workingNote.count({ where: { orgId: ORG } })).toBe(0);
    expect(await erasuresApplied(ORG)).toBe(true);
  });

  for (const { table, restore } of [
    { table: "working_notes", restore: () => addNote(`Waiting on ${NAME} for the renewal.`, LONG_AGO) },
    { table: "briefs", restore: () => addBrief(`${NAME} owns the renewal.`, LONG_AGO) },
  ]) {
    it(`a re-apply marks its entries only after its ${table} pass: one that fails there leaves the org not applied`, async () => {
      await erasePerson(admin, { contactId: "anne" });
      // A restore of a backup taken before the erasure: the copy is back, the markers are not.
      await restore();
      await restoredOverOlderMarkers();
      expect(await erasuresApplied(ORG)).toBe(false);

      await failDeletes(table);
      try {
        await expect(reapplyErasures(admin)).rejects.toThrow(new RegExp(`${table} delete fails`));
      } finally {
        await allowDeletes(table);
      }
      expect(await erasuresApplied(ORG)).toBe(false);

      const result = await reapplyErasures(admin);
      expect(result.notesRemoved + result.briefsRemoved).toBe(1);
      expect(await erasuresApplied(ORG)).toBe(true);
    }, 30_000);
  }

  it("an import's re-apply leaves the org applied, and an import undone by a failed re-apply leaves it not applied", async () => {
    await addChunk("c-kept", "Acme renews in March.");
    const lines: string[] = [];
    for await (const line of exportMemory(admin)) lines.push(line.trimEnd());
    await erasePerson(admin, { contactId: "anne" });
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await restoredOverOlderMarkers();
    async function* stream() {
      yield* lines;
    }

    // The re-apply's last step, marking its entries, fails: the import is undone.
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION eap_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'eap: marking fails'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER eap_fail BEFORE INSERT ON erasure_suppressions_applied
      FOR EACH ROW WHEN (NEW."orgId" = '${ORG}') EXECUTE FUNCTION eap_fail()`);
    try {
      await expect(importMemory(admin, stream())).rejects.toBeInstanceOf(ImportIncompleteError);
    } finally {
      await allowDeletes("erasure_suppressions_applied");
    }
    expect(await chunks()).toBe(0);
    expect(await erasuresApplied(ORG)).toBe(false);

    const receipt = await importMemory(admin, stream());
    expect(receipt.imported.fact).toBe(1);
    expect(await erasuresApplied(ORG)).toBe(true);
  }, 30_000);
});
