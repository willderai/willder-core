// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// What keeps an erased person gone (consent suite bar 3, docs/consent-deletion-suite.md):
// the suppression list a connector re-sync checks, the connector records that
// pointed at erased episodes, change-feed summaries, and briefs.
//
// Real: Postgres with pgvector, check() against live grants, the erasure itself,
// the connector sync functions in lib/inngest.ts with their SourceFile records
// and change events, and the pgvector chunk writes of a Drive sync. Stand-in:
// the graph store, whose erasure is proven on a real Neo4j in
// memory-service/tests/test_person_erasure_integration.py; here it is a spy that
// reports which episodes it erased and records what a sync asked it to write.
//
// Set QA_DATABASE_URL to an ISOLATED test database with the migrations applied.
// Never the sandbox's inherited DATABASE_URL. Skips cleanly without it.
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import type { DriveFile } from "@/services/connectors/gdrive";
import { listAsTheApp } from "@/services/memory/erasure-suppression.testsupport";

const graphErase = vi.fn();
const graphIngest = vi.fn();
const graphIngestBulk = vi.fn();
const graphExtractFile = vi.fn();
const graphRemoveEpisode = vi.fn();
vi.mock("./store", () => ({
  memory: { ingest: (...a: unknown[]) => graphIngest(...a) },
  graphitiStore: {
    planPersonErasure: async () => [],
    erasePerson: (...a: unknown[]) => graphErase(...a),
    ingestBulk: (...a: unknown[]) => graphIngestBulk(...a),
    extractFile: (...a: unknown[]) => graphExtractFile(...a),
    removeEpisode: (...a: unknown[]) => graphRemoveEpisode(...a),
  },
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_aftermath";
const OTHER_ORG = "qa_aftermath_other";
const ROOT = `org_${ORG}`;
const SALES = `${ROOT}.sales`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const ADMIN = "qa_aftermath_admin";
const EDITOR = "qa_aftermath_editor";
const DIMENSIONS = 384;

const EMAIL = "dana_w@acme.example";
const NAME = "Dana Whitfield";
const MARKERS = [EMAIL, NAME, "d. whitfield"];
const BYSTANDER = "Kenji Sato renewed the annual plan.";

const vector = () => [1, ...Array(DIMENSIONS - 1).fill(0)];

describe.skipIf(!QA_URL)("after a person erasure, nothing brings the person back", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let syncOneTextItem: (typeof import("@/lib/inngest"))["syncOneTextItem"];
  let processDriveFile: (typeof import("@/lib/inngest"))["processDriveFile"];

  const admin: AccessContext = { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" }, origin: "app" };
  const editor: AccessContext = { orgId: ORG, actor: { type: "human", id: EDITOR, role: "member" }, origin: "app" };
  const slack = {
    id: "src-slack",
    orgId: ORG,
    type: "slack",
    name: "#deals",
    scopePath: SALES,
    connectAuthorizationId: null,
  };
  const otherSlack = {
    id: "src-slack-other",
    orgId: OTHER_ORG,
    type: "slack",
    name: "#deals",
    scopePath: OTHER_ROOT,
    connectAuthorizationId: null,
  };
  const drive = { id: "src-drive", orgId: ORG, name: "Contracts", scopePath: SALES, connectAuthorizationId: null };

  const markersIn = (value: unknown) =>
    MARKERS.filter((m) =>
      JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
        .toLowerCase()
        .includes(m.toLowerCase()),
    );

  async function wipe() {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId}`;
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.brief.deleteMany({ where: { orgId } });
      await db.source.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.contactIdempotencyKey.deleteMany({ where: { orgId } });
      await db.contact.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.user.deleteMany({ where: { orgId } });
    }
  }

  /** Every row an org's readers could be served from, for a whole-org probe. */
  async function everythingIn(orgId: string) {
    return {
      chunks: await db.memoryChunk.findMany({ where: { orgId }, select: { content: true } }),
      events: await db.changeEvent.findMany({ where: { orgId } }),
      briefs: await db.brief.findMany({ where: { orgId } }),
      suppressions: await db.erasureSuppression.findMany({ where: { orgId } }),
    };
  }

  // change_events.id is unique across every org and other suites share this
  // database, so ids are drawn fresh rather than spelled as fixed literals.
  const event = (orgId: string, seq: number, scopePath: string, summary: string) => ({
    id: randomUUID(),
    orgId,
    seq: BigInt(seq),
    scopePath,
    recordType: "fact",
    recordId: `ep-${seq}`,
    op: "create" as const,
    actorId: "connector",
    summary,
  });

  const brief = (id: string, orgId: string, title: string, sections: object[]) => ({
    id,
    orgId,
    type: "handoff" as const,
    scopePath: orgId === ORG ? SALES : OTHER_ROOT,
    title,
    summary: "Who to talk to on the account.",
    sections,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ syncOneTextItem, processDriveFile } = await import("@/lib/inngest"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await wipe();
    await db.$disconnect();
  });

  beforeEach(async () => {
    for (const spy of [graphErase, graphIngest, graphIngestBulk, graphExtractFile, graphRemoveEpisode]) spy.mockReset();
    graphErase.mockResolvedValue({
      episodes: 2,
      nodes: 1,
      edges: 1,
      summaries: 0,
      episodeIds: ["ep-dana", "ep-dana-doc"],
    });
    graphIngest.mockResolvedValue({ episodeId: "ep-new" });
    graphIngestBulk.mockImplementation(async (inputs: unknown[]) => inputs.map((_, i) => `ep-bulk-${i}`));
    graphRemoveEpisode.mockResolvedValue({ removed: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ embedding: vector() }), { status: 200 })),
    );
    await wipe();

    for (const orgId of [ORG, OTHER_ORG]) {
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.scope.create({ data: { orgId: ORG, path: SALES, name: "sales" } });
    await db.scope.create({ data: { orgId: OTHER_ORG, path: OTHER_ROOT, name: "root" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: "admin@aftermath.test", role: "admin", clerkId: "clerk-aftermath-admin" },
    });
    await db.user.create({
      data: {
        id: EDITOR,
        orgId: ORG,
        email: "editor@aftermath.test",
        role: "member",
        clerkId: "clerk-aftermath-editor",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: EDITOR, permission: "write" },
    });

    await db.contact.create({ data: { id: "am-dana", orgId: ORG, name: NAME, email: EMAIL } });
    await db.contact.create({
      data: { id: "am-dana-dup", orgId: ORG, name: "D. Whitfield", email: EMAIL.toUpperCase() },
    });
    await db.contact.create({ data: { id: "am-kenji", orgId: ORG, name: "Kenji Sato", email: "kenji@acme.example" } });
    await db.contact.create({ data: { id: "am-dana-other", orgId: OTHER_ORG, name: NAME, email: EMAIL } });

    // Connector records: a Slack item and a Drive file whose episodes the graph
    // step erases, a bystander of each, and another tenant's record that
    // happens to hold the same episode id.
    await db.source.create({
      data: { id: slack.id, orgId: ORG, type: "slack", externalId: "C1", name: slack.name, scopePath: SALES },
    });
    await db.source.create({
      data: { id: drive.id, orgId: ORG, type: "gdrive", externalId: "F1", name: drive.name, scopePath: SALES },
    });
    await db.source.create({
      data: {
        id: otherSlack.id,
        orgId: OTHER_ORG,
        type: "slack",
        externalId: "C1",
        name: otherSlack.name,
        scopePath: OTHER_ROOT,
      },
    });
    await db.sourceFile.createMany({
      data: [
        {
          sourceId: slack.id,
          externalFileId: "msg-dana",
          checksum: "v1",
          episodeId: "ep-dana",
          episodeScopePath: SALES,
        },
        {
          sourceId: slack.id,
          externalFileId: "msg-kenji",
          checksum: "v1",
          episodeId: "ep-kenji",
          episodeScopePath: SALES,
        },
        {
          sourceId: drive.id,
          externalFileId: "doc-mixed",
          checksum: "v1",
          episodeIds: ["ep-dana-doc", "ep-kenji-doc"],
          episodeScopePath: SALES,
        },
        {
          sourceId: drive.id,
          externalFileId: "doc-dana",
          checksum: "v1",
          episodeIds: ["ep-dana"],
          episodeScopePath: SALES,
        },
        {
          sourceId: otherSlack.id,
          externalFileId: "msg-dana",
          checksum: "v1",
          episodeId: "ep-dana",
          episodeScopePath: OTHER_ROOT,
        },
      ],
    });

    await db.changeEvent.createMany({
      data: [
        event(ORG, 1, SALES, `Call with ${NAME} about renewal`),
        event(ORG, 2, SALES, `Forwarded by ${EMAIL.toUpperCase()}`),
        event(ORG, 3, ROOT, BYSTANDER),
        event(OTHER_ORG, 1, OTHER_ROOT, `Call with ${NAME} about renewal`),
      ],
    });

    await db.brief.createMany({
      data: [
        // Named only inside a section, not in the title.
        brief("b-section", ORG, "Acme handoff", [{ heading: "Champion", content: `${NAME} signs off on price.` }]),
        brief("b-title", ORG, `Handoff: d. whitfield's accounts`, [{ heading: "Accounts", content: "Acme" }]),
        brief("b-bystander", ORG, "Kenji Sato handoff", [{ heading: "Champion", content: BYSTANDER }]),
        brief("b-other", OTHER_ORG, "Acme handoff", [{ heading: "Champion", content: `${NAME} signs off on price.` }]),
      ],
    });
  });

  describe("connector re-sync", () => {
    it.each([
      ["the full name", `${NAME} moved to the enterprise plan.`],
      ["the name in another case, possessive", `Ask DANA WHITFIELD's team for the PO.`],
      ["the email in another case", `Ping <${EMAIL.toUpperCase()}> about it.`],
      ["a second name on file", "D. Whitfield approved the quote."],
    ])("does not write back a changed Slack message naming %s", async (_label, text) => {
      // Positive control: before the erasure the same message is written.
      expect(await syncOneTextItem(slack, { id: "msg-new", text, checksum: "v0" }, null)).toBe("synced");
      expect(graphIngest).toHaveBeenCalledTimes(1);
      graphIngest.mockClear();

      await erasePerson(admin, { contactId: "am-dana" });
      const outcome = await syncOneTextItem(slack, { id: "msg-dana", text, checksum: "v2" }, null);

      expect(outcome).toBe("skipped");
      expect(graphIngest).not.toHaveBeenCalled();
      const record = await db.sourceFile.findUniqueOrThrow({
        where: { sourceId_externalFileId: { sourceId: slack.id, externalFileId: "msg-dana" } },
      });
      // Seen, so the same version is not re-checked; nothing points at a graph episode.
      expect(record).toMatchObject({ checksum: "v2", episodeId: null, episodeScopePath: null });
      const after = await db.changeEvent.findMany({ where: { orgId: ORG } });
      expect(markersIn(after)).toEqual([]);
    });

    it("still writes a message that does not name the person", async () => {
      await erasePerson(admin, { contactId: "am-dana" });

      const outcome = await syncOneTextItem(slack, { id: "msg-kenji-2", text: BYSTANDER, checksum: "v1" }, null);

      expect(outcome).toBe("synced");
      expect(graphIngest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ content: BYSTANDER, groupId: ORG }),
      );
    });

    it("does not write back a comment the person authored, even when the text does not name them", async () => {
      const figma = { ...slack, type: "figma" };
      await erasePerson(admin, { contactId: "am-dana" });

      const outcome = await syncOneTextItem(
        figma,
        { id: "cmt-1", text: "Ship it.", checksum: "v1", author: NAME },
        null,
      );

      expect(outcome).toBe("skipped");
      expect(graphIngest).not.toHaveBeenCalled();
    });

    it("binds the suppression list to the org: another tenant's sync of the same text is written", async () => {
      await erasePerson(admin, { contactId: "am-dana" });

      const outcome = await syncOneTextItem(
        otherSlack,
        { id: "msg-new", text: `${NAME}, ${EMAIL}`, checksum: "v1" },
        null,
      );

      expect(outcome).toBe("synced");
      expect(graphIngest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ groupId: OTHER_ORG }));
    });

    it("binds each digest to its org: a suppression row copied into another org matches nothing there", async () => {
      await erasePerson(admin, { contactId: "am-dana" });
      const rows = await db.erasureSuppression.findMany({ where: { orgId: ORG } });
      await listAsTheApp(db, {
        data: rows.map(({ kind, digest, wordCount, requestId }) => ({
          orgId: OTHER_ORG,
          kind,
          digest,
          wordCount,
          requestId,
        })),
      });

      const outcome = await syncOneTextItem(
        otherSlack,
        { id: "msg-new", text: `${NAME}, ${EMAIL}`, checksum: "v1" },
        null,
      );

      expect(outcome).toBe("synced");
    });

    it("leaves out only the Drive passages naming the person, and writes the rest", async () => {
      await erasePerson(admin, { contactId: "am-dana" });
      graphExtractFile.mockResolvedValue({ chunks: [`Signed by ${NAME}.`, BYSTANDER, `cc ${EMAIL}`] });
      const file: DriveFile = {
        id: "doc-mixed",
        name: "Q3 renewals.pdf",
        mimeType: "application/pdf",
        checksum: "v2",
        contentVersion: "v2",
        fileType: "pdf",
      };
      const deps = {
        downloadFile: vi.fn(async () => new Blob(["%PDF"])),
        put: vi.fn(async () => ({ url: "https://blob.test/q3.pdf" })),
        del: vi.fn(async () => undefined),
      };

      const outcome = await processDriveFile(drive, file, "token", deps);

      expect(outcome).toBe("synced");
      // The record's surviving episode is retired as usual; the erased one is not asked for.
      expect(graphRemoveEpisode).toHaveBeenCalledExactlyOnceWith({ groupId: SALES, episodeId: "ep-kenji-doc" });
      expect(graphIngestBulk).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ content: BYSTANDER })]);
      const chunks = await db.memoryChunk.findMany({
        where: { orgId: ORG, sourceId: drive.id },
        select: { content: true },
      });
      expect(chunks).toEqual([{ content: BYSTANDER }]);
      const record = await db.sourceFile.findUniqueOrThrow({
        where: { sourceId_externalFileId: { sourceId: drive.id, externalFileId: "doc-mixed" } },
      });
      expect(record).toMatchObject({ checksum: "v2", episodeIds: ["ep-bulk-0"] });
    });

    it("does not download a Drive file whose name names the person", async () => {
      await erasePerson(admin, { contactId: "am-dana" });
      const file: DriveFile = {
        id: "doc-dana",
        name: "Dana Whitfield - offer letter.docx",
        mimeType: "application/msword",
        checksum: "v2",
        contentVersion: "v2",
        fileType: "docx",
      };
      const deps = { downloadFile: vi.fn(), put: vi.fn(), del: vi.fn() };

      const outcome = await processDriveFile(drive, file, "token", deps);

      expect(outcome).toBe("skipped");
      expect(deps.downloadFile).not.toHaveBeenCalled();
      expect(graphRemoveEpisode).not.toHaveBeenCalled();
      const record = await db.sourceFile.findUniqueOrThrow({
        where: { sourceId_externalFileId: { sourceId: drive.id, externalFileId: "doc-dana" } },
      });
      expect(record).toMatchObject({ checksum: "v2", episodeIds: [], chunkIds: [], episodeScopePath: null });
    });
  });

  it("drops this org's connector pointers to erased episodes, and no other org's", async () => {
    await erasePerson(admin, { contactId: "am-dana" });

    const records = await db.sourceFile.findMany({
      orderBy: [{ sourceId: "asc" }, { externalFileId: "asc" }],
      where: { sourceId: { in: [slack.id, drive.id, otherSlack.id] } },
      select: { sourceId: true, externalFileId: true, episodeId: true, episodeIds: true, episodeScopePath: true },
    });
    expect(records).toEqual([
      { sourceId: drive.id, externalFileId: "doc-dana", episodeId: null, episodeIds: [], episodeScopePath: null },
      {
        sourceId: drive.id,
        externalFileId: "doc-mixed",
        episodeId: null,
        episodeIds: ["ep-kenji-doc"],
        episodeScopePath: SALES,
      },
      { sourceId: slack.id, externalFileId: "msg-dana", episodeId: null, episodeIds: [], episodeScopePath: null },
      {
        sourceId: slack.id,
        externalFileId: "msg-kenji",
        episodeId: "ep-kenji",
        episodeIds: [],
        episodeScopePath: SALES,
      },
      {
        sourceId: otherSlack.id,
        externalFileId: "msg-dana",
        episodeId: "ep-dana",
        episodeIds: [],
        episodeScopePath: OTHER_ROOT,
      },
    ]);
  });

  it("blanks change-feed summaries naming the person and keeps every event in order", async () => {
    const result = await erasePerson(admin, { contactId: "am-dana" });

    expect(result.changeSummariesScrubbed).toBe(2);
    const events = await db.changeEvent.findMany({ where: { orgId: ORG, seq: { lte: 3 } }, orderBy: { seq: "asc" } });
    expect(events.map((e) => [Number(e.seq), e.recordId, e.summary])).toEqual([
      [1, "ep-1", ""],
      [2, "ep-2", ""],
      [3, "ep-3", BYSTANDER],
    ]);
    const other = await db.changeEvent.findFirstOrThrow({ where: { orgId: OTHER_ORG } });
    expect(other.summary).toBe(`Call with ${NAME} about renewal`);
  });

  it("deletes the briefs naming the person, announces each deletion, and keeps the rest", async () => {
    const result = await erasePerson(admin, { contactId: "am-dana" });

    expect(result.briefsRemoved).toBe(2);
    expect(
      (
        await db.brief.findMany({
          select: { id: true },
          where: { orgId: { in: [ORG, OTHER_ORG] } },
          orderBy: { id: "asc" },
        })
      ).map((b) => b.id),
    ).toEqual(["b-bystander", "b-other"]);
    const deletions = await db.changeEvent.findMany({
      where: { orgId: ORG, recordType: "brief" },
      orderBy: { recordId: "asc" },
    });
    expect(deletions.map((e) => [e.recordId, e.op, e.scopePath, e.summary, e.actorId])).toEqual([
      ["b-section", "delete", SALES, "", ADMIN],
      ["b-title", "delete", SALES, "", ADMIN],
    ]);
  });

  it("deletes a brief whose own text never names the person when a fact it cited did", async () => {
    // A brief paraphrases; its citations keep the fact text it quoted (brief_citations).
    await db.brief.createMany({
      data: [
        brief("b-cited", ORG, "Pricing handoff", [
          { heading: "Approvals", content: "The champion signs off on price." },
        ]),
        brief("b-cited-bystander", ORG, "Ops handoff", [{ heading: "Ops", content: "Deploys on Tuesdays." }]),
        brief("b-cited-other", OTHER_ORG, "Pricing handoff", [
          { heading: "Approvals", content: "The champion signs off." },
        ]),
      ],
    });
    await db.briefCitation.createMany({
      data: [
        { briefId: "b-cited", sectionIndex: 0, factId: "f1", factText: `${NAME} signs off on price.` },
        { briefId: "b-cited-bystander", sectionIndex: 0, factId: "f2", factText: BYSTANDER },
        { briefId: "b-cited-other", sectionIndex: 0, factId: "f3", factText: `${NAME} signs off on price.` },
      ],
    });

    await erasePerson(admin, { contactId: "am-dana" });

    const left = await db.brief.findMany({ select: { id: true }, where: { orgId: { in: [ORG, OTHER_ORG] } } });
    expect(left.map((b) => b.id)).not.toContain("b-cited");
    expect(left.map((b) => b.id)).toEqual(expect.arrayContaining(["b-cited-bystander", "b-cited-other"]));
    expect(await db.briefCitation.count({ where: { briefId: "b-cited" } })).toBe(0);
  });

  it("leaves no readable trace in the org, and keeps the suppression list as digests only", async () => {
    // Positive control: the org held the person before.
    expect(markersIn(await everythingIn(ORG))).not.toEqual([]);

    await erasePerson(admin, { contactId: "am-dana" });
    const again = await erasePerson(admin, { email: EMAIL });

    const after = await everythingIn(ORG);
    expect(markersIn(after)).toEqual([]);
    // Recorded once however often the request is sent: one email, the two contact rows
    // removed, two two-word names, each as found in text, as a record's whole name, and
    // surname first, the one whose words hold a mark ("d. whitfield") also as found written
    // without spaces (with a space, and with a line break, where its name has its space), each
    // run together ("danawhitfield", "dwhitfield"), and,
    // by id, each version it removed: the two graph episodes and the two facts whose
    // announcement named her (services/memory/erasure-lineage.ts).
    expect(after.suppressions.map((s) => [s.kind, s.wordCount]).sort()).toEqual([
      ["concatenated_name", 10],
      ["concatenated_name", 13],
      ["contact_id", null],
      ["contact_id", null],
      ["email", null],
      ["joined_name", 2],
      ["joined_name", 2],
      ["record_name", null],
      ["record_name", null],
      ["record_name_reversed", null],
      ["record_name_reversed", null],
      ["text_name", 2],
      ["text_name", 2],
      ["version_id", null],
      ["version_id", null],
      ["version_id", null],
      ["version_id", null],
    ]);
    const versionDigest = (id: string) => createHash("sha256").update(`${ORG}\0version_id\0${id}`).digest("hex");
    expect(
      after.suppressions
        .filter((s) => s.kind === "version_id")
        .map((s) => s.digest)
        .sort(),
    ).toEqual(["ep-1", "ep-2", "ep-dana", "ep-dana-doc"].map(versionDigest).sort());
    expect(again).toMatchObject({ briefsRemoved: 0, changeSummariesScrubbed: 0 });
    expect(markersIn(await everythingIn(OTHER_ORG))).not.toEqual([]);
  });

  it("records nothing on the suppression list for a refused request", async () => {
    await expect(erasePerson(editor, { contactId: "am-dana" })).rejects.toMatchObject({ name: "AccessDeniedError" });

    expect(await db.erasureSuppression.count({ where: { orgId: ORG } })).toBe(0);
    expect(await syncOneTextItem(slack, { id: "msg-new", text: NAME + " again", checksum: "v1" }, null)).toBe("synced");
  });
});
