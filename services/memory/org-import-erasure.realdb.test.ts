// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// An import is a restore, so it leaves out everything the target org's erasures cover,
// by the same rule the export applies (services/memory/export-erasure.ts). This file
// covers every kind an import writes: a fact naming the person, a fact filed under her
// name, a rule, a working note, a brief naming her, a brief citing a fact that named her
// (by the fact's text, and by the id of a version the erasure removed), and an edge to a
// fact left out, and a fact and rule the erasure never saw by id. Each is counted in the
// receipt as erased, not as imported (an edge to one as skipped), and the import then
// re-applies the org's erasures as a second pass. Content dated after the erasure is a
// deliberate re-add and is imported. The admin clears the org between the erasure and the
// import, as a restore from an export does; the suppression list stays.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";

vi.mock("./store", () => ({
  memory: {},
  graphitiStore: {
    removeGroupFacts: async () => ({ removedCount: 0 }),
    planPersonErasure: async () => [],
    erasePerson: async () => ({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] }),
    removeChunkFacts: async () => undefined,
  },
}));

const QA_URL = process.env.QA_DATABASE_URL;

// Alphanumeric, so orgRootPath(id) is a valid ltree label.
const ORG = "qaimporterasesib";
const ROOT = `org_${ORG}`;
const ADMIN = "u-qa-import-erase-sib";
const NAME = "Orla Brennick";
const DIMENSIONS = 384;

/** A unit vector from the text alone, as the memory service would give. */
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
const OLD = new Date("2026-01-01T00:00:00Z");

type Line = { type: string; [k: string]: unknown };

describe.skipIf(!QA_URL)("an import leaves out every kind an erasure in the target org covers, real Postgres", () => {
  let db: PrismaClient;
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let importMemory: (typeof import("./org-import"))["importMemory"];
  let ImportRefusedError: (typeof import("./org-import"))["ImportRefusedError"];
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];

  /** The export taken while the org still named her. */
  let before: string[] = [];

  async function collect(): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of exportMemory(admin)) lines.push(line.trimEnd());
    return lines;
  }
  async function* stream(lines: string[]) {
    yield* lines;
  }
  const parse = (lines: string[]) => lines.map((l) => JSON.parse(l) as Line);

  /** `lines` with `extra` records added before the end record, its counts raised to match. */
  function withRecords(lines: string[], extra: Line[]): string[] {
    const records = parse(lines);
    const end = records.pop()! as { type: "end"; counts: Record<string, number> };
    for (const r of extra) end.counts[r.type] = (end.counts[r.type] ?? 0) + 1;
    // Each extra record goes after the last of its type: an import reads types in the export's order.
    const order = [
      "manifest",
      "scope",
      "source",
      "fact",
      "upload",
      "convention",
      "working_note",
      "brief",
      "edge",
      "audit",
    ];
    const all = [...records, ...extra]
      .map((r, i) => ({ r, i }))
      .sort((x, y) => order.indexOf(x.r.type) - order.indexOf(y.r.type) || x.i - y.i);
    return [...all.map(({ r }) => r), end].map((r) => JSON.stringify(r));
  }

  /** Empties the org of memory, as an admin restoring from an export does; the suppression list stays. */
  async function clearMemory() {
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG}`;
    await db.$executeRaw`UPDATE conventions SET "supersedesId" = NULL, "supersededById" = NULL WHERE "orgId" = ${ORG}`;
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.workingNote.deleteMany({ where: { orgId: ORG } });
    await db.brief.deleteMany({ where: { orgId: ORG } });
    await db.source.deleteMany({ where: { orgId: ORG } });
  }

  async function reset() {
    await clearMemory();
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.user.deleteMany({ where: { id: ADMIN } });
  }

  async function addFact(id: string, content: string, entityName: string | null) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "entityName", "scopePath",
        "factVersion", embedding, "createdAt")
      VALUES (${id}, ${ORG}, ${content}, 'text', 'agent', 'agent-1', ${entityName}, ${ROOT},
        ${entityName !== null}, ${`[${embed(content).join(",")}]`}::vector, ${OLD})`;
  }

  async function addBrief(
    title: string,
    summary: string,
    citations: { factId: string; factText: string }[],
    diagram: string | null = null,
  ) {
    await db.brief.create({
      data: {
        orgId: ORG,
        type: "handoff",
        scopePath: ROOT,
        title,
        summary,
        createdAt: OLD,
        diagram,
        sections: [{ heading: "Status", body: summary }],
        citations: { create: citations.map((c) => ({ sectionIndex: 0, ...c })) },
      },
    });
  }

  /** What the org holds after an import, by the text a reader would see. */
  async function held() {
    const [facts, rules, notes, briefs, edges] = await Promise.all([
      db.memoryChunk.findMany({ where: { orgId: ORG }, select: { content: true } }),
      db.convention.findMany({ where: { orgId: ORG }, select: { text: true } }),
      db.workingNote.findMany({ where: { orgId: ORG }, select: { body: true } }),
      db.brief.findMany({ where: { orgId: ORG }, select: { title: true } }),
      db.factEdge.count({ where: { orgId: ORG } }),
    ]);
    return {
      facts: facts.map((f) => f.content).sort(),
      rules: rules.map((r) => r.text).sort(),
      notes: notes.map((n) => n.body).sort(),
      briefs: briefs.map((b) => b.title).sort(),
      edges,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn(embeddingService));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ exportMemory } = await import("./org-export"));
    ({ importMemory, ImportRefusedError } = await import("./org-import"));
    ({ erasePerson } = await import("./person-erasure"));
    await reset();

    await db.org.create({ data: { id: ORG, name: ORG } });
    await seedMember(db, { orgId: ORG, userId: ADMIN, role: "admin" });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: "root" } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
    await db.contact.create({ data: { id: "orla", orgId: ORG, name: NAME, email: "orla@sib.example" } });

    await addFact("f-text", `${NAME} owns the Acme renewal.`, null);
    await addFact("f-filed", "Owns the Q3 procurement plan.", NAME);
    await addFact("f-keep", "Acme renews in March on the annual plan.", null);
    await addFact("f-keep-2", "Acme pays by invoice.", null);
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "f-keep",
        toId: "f-text",
        kind: "dependsOn",
        scopePath: ROOT,
        actorType: "agent",
        actorId: "agent-1",
        createdAt: OLD,
      },
    });
    await db.factEdge.create({
      data: {
        orgId: ORG,
        fromId: "f-keep",
        toId: "f-keep-2",
        kind: "dependsOn",
        scopePath: ROOT,
        actorType: "agent",
        actorId: "agent-1",
        createdAt: OLD,
      },
    });
    for (const [id, text] of [
      ["cv-named", `${NAME} approves Acme discounts.`],
      ["cv-keep", "Discounts above 10% need finance."],
    ]) {
      await db.convention.create({
        data: {
          id,
          orgId: ORG,
          scopePath: ROOT,
          kind: "decision",
          subject: "Discounts",
          text,
          actorId: ADMIN,
          createdAt: OLD,
        },
      });
    }
    for (const body of [`Waiting on ${NAME}'s sign-off.`, "Cutting the release."]) {
      await db.workingNote.create({
        data: {
          orgId: ORG,
          scopePath: ROOT,
          agentId: "agent-1",
          task: "acme",
          kind: "status",
          body,
          expiresAt: new Date("2026-01-01T04:00:00Z"),
          createdAt: OLD,
        },
      });
    }
    await addBrief("names her", `${NAME} owns the renewal.`, []);
    // Paraphrased her away, but cites the version the erasure removes: erased by its id.
    await addBrief("cites an erased version", "The owner runs the renewal.", [
      { factId: "f-text", factText: "She owns the renewal." },
    ]);
    // Cites a fact the export does not hold (a graph fact) whose stored text names her.
    await addBrief("cites a fact naming her", "Procurement is covered.", [
      { factId: "graph-fact-1", factText: `${NAME} runs procurement.` },
    ]);
    // Names her only in its diagram, after a line break: read as stored, not JSON-escaped ("\\nOrla").
    await addBrief("diagram names her", "Ownership map attached.", [], `sequenceDiagram\n${NAME}->>Ops: hand off`);
    await addBrief("keep", "Acme renews in March.", [
      { factId: "f-keep", factText: "Acme renews in March on the annual plan." },
    ]);

    before = await collect();
    // The erasure is recorded strictly after every exported row.
    await new Promise((r) => setTimeout(r, 20));
    await erasePerson(admin, { contactId: "orla" });
    await clearMemory();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await reset();
    await db.$disconnect();
  });

  it("the export taken before the erasure holds every kind naming her", () => {
    const text = before.join("\n");
    expect(text).toContain(NAME);
    expect(parse(before).at(-1)).toMatchObject({
      counts: { fact: 4, convention: 2, working_note: 2, brief: 5, edge: 2 },
    });
  });

  it("imports none of what the erasure covers, counts it as erased, and re-applies the erasures after", async () => {
    // Written after the erasure: a deliberate re-add, imported as usual.
    const later = new Date(Date.now() + 60_000).toISOString();
    const readded: Line = {
      type: "fact",
      id: "f-readded",
      scope: "",
      content: `${NAME} rejoined as a contractor.`,
      entityName: null,
      factVersion: false,
      role: null,
      source: "text",
      actorType: "human",
      actorId: ADMIN,
      actorName: null,
      sourceId: null,
      occurredAt: null,
      createdAt: later,
    };

    // Held by the export but deleted before the erasure ran, so the erasure never recorded
    // their ids: only the name a fact is filed under, and a rule's text, can find them.
    const fact = parse(before).find((r) => r.type === "fact" && r.id === "f-keep")!;
    const rule = parse(before).find((r) => r.type === "convention" && r.id === "cv-keep")!;
    const filedGone: Line = {
      ...fact,
      id: "f-gone",
      content: "Leads the vendor review.",
      entityName: NAME,
      factVersion: true,
    };
    const ruleGone: Line = { ...rule, id: "cv-gone", text: `Escalations go to ${NAME}.` };

    const receipt = await importMemory(admin, stream(withRecords(before, [filedGone, ruleGone, readded])));

    expect(await held()).toEqual({
      facts: ["Acme pays by invoice.", "Acme renews in March on the annual plan.", `${NAME} rejoined as a contractor.`],
      rules: ["Discounts above 10% need finance."],
      notes: ["Cutting the release."],
      briefs: ["keep"],
      edges: 1,
    });
    expect(receipt.imported).toMatchObject({ fact: 3, convention: 1, working_note: 1, brief: 1, edge: 1 });
    expect(receipt.erased).toEqual({
      scope: 0,
      source: 0,
      fact: 3,
      upload: 0,
      convention: 2,
      working_note: 1,
      brief: 4,
      edge: 0,
      audit: 0,
    });
    // The edge to a fact left out as erased is not written: one end was not imported.
    expect(receipt.skippedEdges).toBe(1);
    // The second pass ran, and found nothing the first left behind.
    expect(receipt.erasuresReapplied).toMatchObject({ contactsErased: 0, chunksRemoved: 0, rulesRedacted: 0 });
    // The kept brief still cites its kept fact, under its new id.
    const kept = await db.brief.findFirst({ where: { orgId: ORG }, include: { citations: true } });
    const cited = await db.memoryChunk.findUnique({ where: { id: kept!.citations[0]!.factId } });
    expect(cited?.content).toBe("Acme renews in March on the annual plan.");
  }, 30_000);

  it("the export after that import holds nothing the erasure covers", async () => {
    const after = await collect();
    const data = after.filter((l) => !l.startsWith('{"type":"audit"'));
    expect(data.filter((l) => l.includes(NAME))).toEqual([expect.stringContaining("rejoined as a contractor")]);
  });

  it("leaves out a restored brief whose citation names her, though its own text does not", async () => {
    // Put back by a database restore, not by the import: dated before the erasure.
    await addBrief("restored, cites her", "Procurement is covered.", [
      { factId: "graph-fact-2", factText: `${NAME} signs off procurement.` },
    ]);
    const after = parse(await collect());
    expect(after.filter((r) => r.type === "brief").map((r) => r.title)).toEqual(["keep"]);
    await db.brief.deleteMany({ where: { orgId: ORG, title: "restored, cites her" } });
  });

  it("refuses an export whose erased record's id appears twice, and leaves the org as it was", async () => {
    await clearMemory();
    const records = parse(before);
    const named = records.find((r) => r.type === "fact" && r.id === "f-text")!;
    const lines = withRecords(before, [{ ...named }]);
    await expect(importMemory(admin, stream(lines))).rejects.toBeInstanceOf(ImportRefusedError);
    await expect(importMemory(admin, stream(lines))).rejects.toThrow(/f-text appears twice/);
    expect(await held()).toEqual({ facts: [], rules: [], notes: [], briefs: [], edges: 0 });
  }, 30_000);
});
