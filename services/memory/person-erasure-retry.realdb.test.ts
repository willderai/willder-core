// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// A person erasure that fails part-way, or races a writer, still ends whole.
//
// Real: Postgres, check() against live grants, the audit log, the change feed's own
// writer, and failures raised by the database itself (a trigger that refuses one
// statement). Stand-in: the graph store, a fake that keeps the person's episodes until
// it is asked to erase them, as the memory service does: its plan names them, its erase
// removes and reports them, and a repeat finds none (the real routes are proven on Neo4j
// in memory-service/tests/test_person_erasure_integration.py).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";

const graphPlan = vi.fn();
const graphErase = vi.fn();
vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    planPersonErasure: (...a: unknown[]) => graphPlan(...a),
    erasePerson: (...a: unknown[]) => graphErase(...a),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_erasure_retry";
const ROOT = `org_${ORG}`;
const ADMIN = "qa_erasure_retry_admin";
const NAME = "Dana Whitfield";
const EMAIL = "dana_w@acme.example";
const DIMENSIONS = 384;

describe.skipIf(!QA_URL)("a person erasure that fails part-way or races a writer still ends whole", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let recordChangeEvent: (typeof import("./change-events"))["recordChangeEvent"];
  let appDb: (typeof import("@/lib/db"))["db"];
  let graphEpisodes: Set<string>;

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };

  async function wipe() {
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await db.source.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
  }

  /** Make every `op` on `table` fail, as a lost connection or a constraint would, until {@link heal}. */
  async function failEvery(op: "UPDATE" | "DELETE", table: "source_files" | "contacts") {
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION qa_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER qa_refuse BEFORE ${op} ON ${table} FOR EACH ROW EXECUTE FUNCTION qa_refuse()`,
    );
  }
  async function heal() {
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qa_refuse ON source_files`);
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qa_refuse ON contacts`);
  }

  async function chunk(id: string, content: string) {
    await db.$executeRaw`
      INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'text', 'extraction', ${ROOT},
              ${`[${[1, ...Array(DIMENSIONS - 1).fill(0)].join(",")}]`}::vector, (now() AT TIME ZONE 'UTC'))
    `;
  }
  async function changeEvent(recordId: string, title: string) {
    await db.$transaction((tx) =>
      recordChangeEvent(tx as never, {
        orgId: ORG,
        scopePath: ROOT,
        recordType: "fact",
        recordId,
        op: "create",
        actorId: "agent-1",
        actorType: "agent",
        origin: "app",
        title,
      }),
    );
  }
  async function brief(id: string, title: string) {
    await db.brief.create({
      data: { id, orgId: ORG, type: "handoff", scopePath: ROOT, title, summary: "Handoff.", sections: [] },
    });
  }
  const chunkIds = async () =>
    (await db.memoryChunk.findMany({ where: { orgId: ORG }, select: { id: true }, orderBy: { id: "asc" } })).map(
      (c) => c.id,
    );
  const erasedRows = () => db.auditLog.findMany({ where: { orgId: ORG, action: "person.erased" } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ recordChangeEvent } = await import("./change-events"));
    ({ db: appDb } = await import("@/lib/db"));
  });

  afterAll(async () => {
    if (!db) return;
    await heal();
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    // The memory service's behaviour: the plan names what an erase would remove now;
    // the erase removes it and reports it; after that the person has no episode left.
    graphEpisodes = new Set(["ep-dana"]);
    graphPlan.mockReset();
    graphPlan.mockImplementation(async () => [...graphEpisodes]);
    graphErase.mockReset();
    graphErase.mockImplementation(async () => {
      const episodeIds = [...graphEpisodes];
      graphEpisodes.clear();
      const found = episodeIds.length;
      return { episodes: found, nodes: 2 * found, edges: 3 * found, summaries: 0, episodeIds };
    });

    await wipe();
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@retry.test", role: "admin", clerkId: "clerk-retry-admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({ data: { id: "dana", orgId: ORG, name: NAME, email: EMAIL } });
    await db.contact.create({ data: { id: "kenji", orgId: ORG, name: "Kenji Sato", email: "kenji@acme.example" } });
    await chunk("c-dana-1", `${NAME} wants the annual plan.`);
    await chunk("c-dana-2", `Forwarded by ${EMAIL}.`);
    await chunk("c-kenji", "Kenji Sato runs procurement.");
    await changeEvent("f-dana", `${NAME} asked for SSO`);
    await changeEvent("f-kenji", "Kenji asked for a quote");
    await brief("b-dana", `Handoff for ${NAME}`);
    await brief("b-kenji", "Handoff for Kenji Sato");
    // A Slack message about her, ingested as one graph episode.
    await db.source.create({
      data: { id: "s-slack", orgId: ORG, type: "slack", externalId: "C1", name: "Slack", scopePath: ROOT },
    });
    await db.sourceFile.create({
      data: {
        sourceId: "s-slack",
        externalFileId: "msg-dana",
        checksum: "v1",
        episodeId: "ep-dana",
        episodeScopePath: ROOT,
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await heal();
  });

  it("drops a connector record's pointer to her episode when the first attempt fails before the graph erase", async () => {
    await failEvery("UPDATE", "source_files");
    await expect(erasePerson(admin, { contactId: "dana" })).rejects.toThrow("refused by the test");
    await heal();

    await erasePerson(admin, { contactId: "dana" });

    const file = await db.sourceFile.findFirstOrThrow({ where: { sourceId: "s-slack", externalFileId: "msg-dana" } });
    expect(file).toMatchObject({ episodeId: null, episodeIds: [], episodeScopePath: null });
    expect(graphEpisodes.size).toBe(0);
  });

  it("writes one person.erased row that counts what a failed first attempt removed", async () => {
    await failEvery("DELETE", "contacts");
    await expect(erasePerson(admin, { contactId: "dana" })).rejects.toThrow("refused by the test");
    await heal();
    // The first attempt's graph, chunk, summary and brief steps committed before the contacts failed.
    expect(await chunkIds()).toEqual(["c-kenji"]);
    expect(await erasedRows()).toHaveLength(0);

    const retry = await erasePerson(admin, { email: EMAIL });

    const rows = await erasedRows();
    expect(rows).toHaveLength(1);
    const metadata = rows[0].metadata as { requestId: string; stores: unknown; earlierRequestIds: string[] };
    const stores = {
      graph: { episodes: 1, nodes: 2, edges: 3, summaries: 0 },
      vector: { chunks: 2 },
      contacts: { contacts: 1, ledgerSnapshots: 0 },
      changeFeed: { summariesBlanked: 1 },
      briefs: { briefs: 1 },
      lineage: { replacements: 0, announced: 0 },
      rules: { rules: 0 },
      notes: { notes: 0 },
    };
    expect(metadata.stores).toEqual(stores);
    expect(metadata.requestId).toBe(retry.requestId);
    const steps = await db.auditLog.findMany({ where: { orgId: ORG, action: "person.erasure_step" } });
    const firstAttempt = [...new Set(steps.map((s) => (s.metadata as { requestId: string }).requestId))].filter(
      (id) => id !== retry.requestId,
    );
    expect(metadata.earlierRequestIds).toEqual(firstAttempt);
    expect(retry).toMatchObject({
      chunksRemoved: 2,
      changeSummariesScrubbed: 1,
      briefsRemoved: 1,
      contactsRemoved: 1,
      graph: stores.graph,
    });
    expect(JSON.stringify(steps)).not.toContain(EMAIL);
    expect(JSON.stringify(steps)).not.toContain(NAME);
  });

  it("removes what is written naming her after the scans, and nothing else written then", async () => {
    // A writer that lands while the erasure is between its last scan and its last
    // transaction: the briefs step has already removed her brief, so the scans are done.
    const original = appDb.$transaction.bind(appDb);
    let wrote = false;
    vi.spyOn(appDb, "$transaction").mockImplementation((async (...args: unknown[]) => {
      if (!wrote && (await db.brief.count({ where: { id: "b-dana" } })) === 0) {
        wrote = true;
        await chunk("c-dana-late", `${NAME} renewed today.`);
        await chunk("c-kenji-late", "Kenji renewed today.");
        await changeEvent("f-dana-late", `${NAME} renewed`);
        await changeEvent("f-kenji-late", "Kenji renewed");
        await brief("b-dana-late", `Renewal notes for ${NAME}`);
        await brief("b-kenji-late", "Renewal notes for Kenji Sato");
      }
      return (original as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as never);

    const result = await erasePerson(admin, { contactId: "dana" });

    expect(wrote).toBe(true);
    expect(await chunkIds()).toEqual(["c-kenji", "c-kenji-late"]);
    const summaries = await db.changeEvent.findMany({
      where: { orgId: ORG, recordType: "fact" },
      orderBy: { seq: "asc" },
    });
    expect(summaries.map((e) => [e.recordId, e.summary])).toEqual([
      ["f-dana", ""],
      ["f-kenji", "Kenji asked for a quote"],
      ["f-dana-late", ""],
      ["f-kenji-late", "Kenji renewed"],
    ]);
    expect((await db.brief.findMany({ where: { orgId: ORG }, orderBy: { id: "asc" } })).map((b) => b.id)).toEqual([
      "b-kenji",
      "b-kenji-late",
    ]);
    expect(result).toMatchObject({ chunksRemoved: 3, changeSummariesScrubbed: 2, briefsRemoved: 2 });
    const [row] = await erasedRows();
    expect(row.metadata).toMatchObject({
      stores: { vector: { chunks: 3 }, changeFeed: { summariesBlanked: 2 }, briefs: { briefs: 2 } },
    });
  });
});
