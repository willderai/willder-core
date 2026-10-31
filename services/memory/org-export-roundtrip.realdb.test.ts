// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The export is complete when it imports into a fresh org and the same questions return
// the same answers, so an org can always leave with its data. This file is that proof: org A is
// exported by its admin and imported into an empty org B, then the same searches are
// asked of both and every record type is counted in both. Around it, the access rules:
// a member exports only what they can read, an agent exports nothing, erased content
// stays out, and an import refuses a non-empty org, a non-admin, and a cut-short file,
// leaving the target as it was.
//
// Embeddings come from a deterministic fake for the memory service, stubbed at the
// fetch seam: the same text gets the same vector in both orgs, as with the real model.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { seedMember } from "@/services/access/member.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

// Alphanumeric ids, so orgRootPath(id) is a valid ltree label as it is for a real cuid.
const A = "qaexporta";
const B = "qaexportb";
const FULL = "qaexportfull";
const ROOT_A = `org_${A}`;
const ROOT_B = `org_${B}`;
const ORGS = [A, B, FULL];

const ADMIN = "u-qa-export-admin";
const SALES_MEMBER = "u-qa-export-sales";

const DIMENSIONS = 384;

/** A unit vector from the text alone, so equal text embeds equally in any org. */
function embed(text: string): number[] {
  const vector: number[] = [];
  for (let block = 0; vector.length < DIMENSIONS; block++) {
    const bytes = createHash("sha256").update(`${block}:${text.toLowerCase()}`).digest();
    for (const byte of bytes) vector.push(byte / 255 - 0.5);
  }
  const unit = vector.slice(0, DIMENSIONS);
  const norm = Math.hypot(...unit);
  return unit.map((x) => x / norm);
}

/** The memory service's /embed and /embed-batch, answered from {@link embed}. */
async function embeddingService(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(url instanceof Request ? url.url : url)).pathname;
  const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string; texts?: string[] };
  if (path === "/embed") return Response.json({ embedding: embed(body.text ?? "") });
  if (path === "/embed-batch") return Response.json({ embeddings: (body.texts ?? []).map(embed) });
  return new Response("not found", { status: 404 });
}

const person = (orgId: string, id: string): AccessContext => ({
  orgId,
  actor: { type: "human", id, role: "admin" },
  origin: "app",
});

describe.skipIf(!QA_URL)("export then import into a fresh org, real Postgres", () => {
  let db: PrismaClient;
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let importMemory: (typeof import("./org-import"))["importMemory"];
  let ImportRefusedError: (typeof import("./org-import"))["ImportRefusedError"];
  let AccessDeniedError: (typeof import("@/services/access"))["AccessDeniedError"];
  let store: InstanceType<(typeof import("./pgvector-store"))["PgvectorMemoryStore"]>;

  /** The full export of A as its admin, kept for every import below. */
  let exported: string[] = [];

  async function collect(ctx: AccessContext): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of exportMemory(ctx)) lines.push(line.trimEnd());
    return lines;
  }
  const records = (lines: string[]) => lines.map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
  async function* stream(lines: string[]) {
    yield* lines;
  }

  async function reset() {
    await db.factEdge.deleteMany({ where: { orgId: { in: ORGS } } });
    await db.$executeRaw`UPDATE conventions SET "supersedesId" = NULL, "supersededById" = NULL WHERE "orgId" = ANY(${ORGS})`;
    await deleteOrgsWithRetry(db, { where: { id: { in: ORGS } } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, SALES_MEMBER] } } });
  }

  /** Counts of every imported kind in `orgId`, for comparing two orgs. */
  async function countsOf(orgId: string) {
    const [facts, passages, conventions, notes, briefs, citations, edges, sources, files, scopes] = await Promise.all([
      db.memoryChunk.count({ where: { orgId } }),
      db.memoryChunkPassage.count({ where: { chunk: { orgId } } }),
      db.convention.count({ where: { orgId } }),
      db.workingNote.count({ where: { orgId } }),
      db.brief.count({ where: { orgId } }),
      db.briefCitation.count({ where: { brief: { orgId } } }),
      db.factEdge.count({ where: { orgId } }),
      db.source.count({ where: { orgId } }),
      db.sourceFile.count({ where: { source: { orgId } } }),
      db.scope.count({ where: { orgId } }),
    ]);
    return { facts, passages, conventions, notes, briefs, citations, edges, sources, files, scopes };
  }

  /** What a whole-org search of `orgId` answers, as text in rank order. */
  async function answers(orgId: string, query: string): Promise<string[]> {
    const root = `org_${orgId}`;
    const result = await store.retrieve({
      groupId: orgId,
      tenantId: orgId,
      query,
      scopePath: root,
      includeUntagged: true,
      limit: 5,
    });
    return result.facts.map((f) => f.fact);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn(embeddingService));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ exportMemory } = await import("./org-export"));
    ({ importMemory, ImportRefusedError } = await import("./org-import"));
    ({ AccessDeniedError } = await import("@/services/access"));
    const { PgvectorMemoryStore } = await import("./pgvector-store");
    store = new PgvectorMemoryStore();
    await reset();

    for (const org of ORGS) {
      await db.org.create({ data: { id: org, name: org } });
      const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
      await db.grant.create({
        data: { orgId: org, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
      });
      await seedMember(db, { orgId: org, userId: ADMIN, role: "admin" });
    }
    const sales = await db.scope.create({ data: { orgId: A, path: `${ROOT_A}.sales`, name: "sales" } });
    await db.scope.create({ data: { orgId: A, path: `${ROOT_A}.sales.eu`, name: "sales eu" } });
    await db.scope.create({ data: { orgId: A, path: `${ROOT_A}.eng`, name: "eng" } });
    // A sibling of sales whose name starts with it: `_` must not match as a wildcard.
    await db.scope.create({ data: { orgId: A, path: `${ROOT_A}.sales_eu`, name: "sales_eu" } });
    await seedMember(db, { orgId: A, userId: SALES_MEMBER, role: "member" });
    await db.grant.create({
      data: { orgId: A, scopeId: sales.id, granteeType: "user", granteeId: SALES_MEMBER, permission: "read" },
    });

    // Org A's memory: facts in three scopes and none, two versions of one fact where the
    // later lost a race, a superseded rule, a note, a brief citing a fact, a source.
    const source = await db.source.create({
      data: {
        orgId: A,
        type: "gdrive",
        externalId: "folder-1",
        name: "Sales folder",
        scopePath: `${ROOT_A}.sales`,
        encryptedTokens: "secret-token-ciphertext",
        files: { create: [{ externalFileId: "file-1", checksum: "c1" }] },
      },
    });
    const facts = [
      {
        id: "fa-acme-1",
        scope: `${ROOT_A}.sales`,
        content: "Acme renews in March on the annual plan.",
        entity: "Acme",
        at: "2026-01-01T00:00:00Z",
      },
      {
        id: "fa-acme-2",
        scope: `${ROOT_A}.sales`,
        content: "Acme renews in April on the monthly plan.",
        entity: "Acme",
        at: "2026-01-01T00:00:01Z",
      },
      {
        id: "fa-eu",
        scope: `${ROOT_A}.sales.eu`,
        content: "Berlin office handles EU invoices.",
        entity: null,
        at: "2026-01-02T00:00:00Z",
      },
      {
        id: "fa-sibling",
        scope: `${ROOT_A}.sales_eu`,
        content: "Sales EU pipeline is reviewed on Mondays.",
        entity: null,
        at: "2026-01-02T12:00:00Z",
      },
      {
        id: "fa-eng",
        scope: `${ROOT_A}.eng`,
        content: "Deploys freeze on Fridays after noon.",
        entity: null,
        at: "2026-01-03T00:00:00Z",
      },
      {
        id: "fa-root",
        scope: null,
        content: "The company was founded in 2021.",
        entity: null,
        at: "2026-01-04T00:00:00Z",
      },
      {
        id: "fa-erased",
        scope: `${ROOT_A}.sales`,
        content: "Jordan Example asked to be removed.",
        entity: null,
        at: "2026-01-05T00:00:00Z",
      },
      {
        id: "fa-long",
        scope: `${ROOT_A}.eng`,
        content: `Runbook: ${"restart the worker then check the queue depth. ".repeat(120)}`,
        entity: null,
        at: "2026-01-06T00:00:00Z",
      },
    ];
    for (const f of facts) {
      await db.$executeRaw`
        INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "entityName", "scopePath",
          "sourceId", "factVersion", embedding, "createdAt")
        VALUES (${f.id}, ${A}, ${f.content}, 'text', 'agent', 'agent-1', ${f.entity}, ${f.scope},
          ${f.id === "fa-acme-1" ? source.id : null}, ${f.entity !== null}, ${`[${embed(f.content).join(",")}]`}::vector, ${new Date(f.at)})`;
    }
    const { embedPassages, insertPassagesSql } = await import("./pgvector-store");
    const { flattenSql } = await import("@/services/access");
    const long = facts.find((f) => f.id === "fa-long")!;
    await db.$executeRaw(...flattenSql(insertPassagesSql(long.id, await embedPassages(long.content))!));
    await db.factEdge.create({
      data: {
        orgId: A,
        fromId: "fa-acme-1",
        toId: "fa-acme-2",
        kind: "supersedes",
        scopePath: `${ROOT_A}.sales`,
        actorType: "agent",
        actorId: "agent-1",
      },
    });
    // From a sales fact to an eng fact: a sales member may not learn the eng fact's id.
    await db.factEdge.create({
      data: {
        orgId: A,
        fromId: "fa-acme-1",
        toId: "fa-eng",
        kind: "dependsOn",
        scopePath: `${ROOT_A}.sales`,
        actorType: "agent",
        actorId: "agent-1",
      },
    });
    await db.convention.create({
      data: {
        id: "cv-1",
        orgId: A,
        scopePath: `${ROOT_A}.sales`,
        kind: "convention",
        subject: "Dedupe",
        text: "Dedupe on email.",
        actorId: "agent-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await db.convention.create({
      data: {
        id: "cv-2",
        orgId: A,
        scopePath: `${ROOT_A}.sales`,
        kind: "convention",
        subject: "Dedupe",
        text: "Dedupe on email and domain.",
        actorId: ADMIN,
        supersedesId: "cv-1",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    });
    await db.convention.create({
      data: {
        id: "cv-erased",
        orgId: A,
        scopePath: `${ROOT_A}.eng`,
        kind: "decision",
        subject: "Owner",
        text: "Jordan owns deploys.",
        actorId: ADMIN,
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    });
    await db.workingNote.create({
      data: {
        orgId: A,
        scopePath: `${ROOT_A}.eng`,
        agentId: "agent-1",
        task: "release",
        kind: "claim",
        body: "Cutting the release.",
        expiresAt: new Date("2026-01-01T04:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await db.brief.create({
      data: {
        orgId: A,
        type: "handoff",
        scopePath: `${ROOT_A}.sales`,
        title: "Acme handoff",
        summary: "Where Acme stands.",
        sections: [{ heading: "Renewal", body: "Renews in March." }],
        citations: {
          create: [{ sectionIndex: 0, factId: "fa-acme-1", factText: "Acme renews in March on the annual plan." }],
        },
        provenance: { create: { sourceIds: [source.id] } },
        retirements: { create: [{ sourceId: source.id, reason: "source file changed" }] },
      },
    });
    const { recordErasedVersions, recordErasedRules } = await import("./erasure-suppression");
    await db.$transaction((tx) => recordErasedVersions(tx, A, "erasure-1", ["fa-erased"]));
    await db.$transaction((tx) => recordErasedRules(tx, A, "erasure-1", ["cv-erased"]));

    exported = await collect(person(A, ADMIN));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await reset();
    await db.$disconnect();
  });

  it("writes a manifest first and an end record whose counts match the records", () => {
    const all = records(exported);
    expect(all[0]).toMatchObject({
      type: "manifest",
      format: "willder-export",
      schemaVersion: 2,
      coverage: "org",
      scopes: [""],
    });
    const end = all.at(-1)!;
    expect(end.type).toBe("end");
    const counted: Record<string, number> = {};
    for (const r of all.slice(1, -1)) counted[r.type] = (counted[r.type] ?? 0) + 1;
    expect(end.counts).toMatchObject(counted);
    expect(counted).toMatchObject({ scope: 5, source: 1, fact: 7, convention: 2, working_note: 1, brief: 1, edge: 2 });
    expect(counted.audit).toBeGreaterThan(0);
  });

  it("names no org outside the audit log: scopes are relative to the root, and no credential or embedding is written", () => {
    const text = exported.join("\n");
    // Audit rows are history and keep their targets as written; every other record is portable.
    const data = exported.filter((l) => !l.startsWith('{"type":"audit"'));
    expect(data.join("\n")).not.toContain(A);
    expect(text).not.toContain("secret-token-ciphertext");
    expect(text).not.toContain("embedding");
    const facts = records(exported).filter((r) => r.type === "fact");
    expect(facts.map((f) => f.scope).sort()).toEqual(
      [null, "eng", "eng", "sales", "sales", "sales.eu", "sales_eu"].sort(),
    );
  });

  it("leaves out a fact and a rule an erasure removed", () => {
    const text = exported.join("\n");
    expect(text).not.toContain("fa-erased");
    expect(text).not.toContain("Jordan");
  });

  it("imports into an empty org, where every kind counts the same and the same searches answer the same", async () => {
    const receipt = await importMemory(person(B, ADMIN), stream(exported));
    expect(receipt).toMatchObject({
      skippedEdges: 0,
      erased: { fact: 0, convention: 0, working_note: 0, brief: 0 },
      imported: { fact: 7, convention: 2, working_note: 1, brief: 1, edge: 2, source: 1, scope: 4 },
    });

    const before = await countsOf(A);
    const after = await countsOf(B);
    // A holds the erased fact and rule, which the export left out on purpose.
    expect(after).toEqual({ ...before, facts: before.facts - 1, conventions: before.conventions - 1 });
    expect(after.passages).toBeGreaterThan(0);

    for (const query of [
      "When does Acme renew?",
      "Who handles EU invoices?",
      "When are deploys frozen?",
      "When was the company founded?",
      "queue depth",
    ]) {
      const inA = await answers(A, query);
      expect(inA.length).toBeGreaterThan(0);
      expect(await answers(B, query)).toEqual(inA.filter((text) => !text.includes("Jordan")));
    }
    // The version that lost its race is still hidden behind the winner in B.
    expect(await answers(B, "When does Acme renew?")).not.toContain("Acme renews in April on the monthly plan.");

    const rule = await db.convention.findFirst({
      where: { orgId: B, text: "Dedupe on email and domain." },
      include: { supersedes: true },
    });
    expect(rule?.supersedes?.text).toBe("Dedupe on email.");
    const brief = await db.brief.findFirst({
      where: { orgId: B },
      include: { citations: true, provenance: true, retirements: true },
    });
    const cited = await db.memoryChunk.findUnique({ where: { id: brief!.citations[0]!.factId } });
    expect(cited).toMatchObject({ orgId: B, content: "Acme renews in March on the annual plan." });
    const importedSource = await db.source.findFirst({ where: { orgId: B } });
    expect(importedSource).toMatchObject({
      status: "disconnected",
      encryptedTokens: null,
      scopePath: `${ROOT_B}.sales`,
    });
    expect(brief!.provenance!.sourceIds).toEqual([importedSource!.id]);
    expect(cited!.sourceId).toBe(importedSource!.id);
    expect(brief!.retirements).toMatchObject([{ sourceId: importedSource!.id, reason: "source file changed" }]);
  });

  it("re-exports the imported org to the same records, ids aside", async () => {
    /** A record with every id field removed: ids are new in the target org, by design. */
    const withoutIds = (record: Record<string, unknown>): Record<string, unknown> => {
      const {
        id: _id,
        fromId: _from,
        toId: _to,
        sourceId: _source,
        sourceIds: _sources,
        supersedesId: _supersedes,
        ...rest
      } = record;
      if (rest.type !== "brief") return rest;
      const citations = rest.citations as { factId: string }[];
      const retirements = rest.retirements as { sourceId: string }[];
      return {
        ...rest,
        citations: citations.map(({ factId: _fact, ...c }) => c),
        retirements: retirements.map(({ sourceId: _retiredBy, ...r }) => r),
      };
    };
    // The target's root scope existed before the import, so it is the one record that differs.
    const comparable = (lines: string[]) =>
      records(lines)
        .filter((r) => !["manifest", "end", "audit"].includes(r.type) && !(r.type === "scope" && r.path === ""))
        .map(withoutIds);
    expect(comparable(await collect(person(B, ADMIN)))).toEqual(comparable(exported));
  });

  it("a member exports only the scopes they can read, with no audit log", async () => {
    const all = records(await collect(person(A, SALES_MEMBER)));
    expect(all[0]).toMatchObject({ coverage: "scopes", scopes: ["sales"] });
    const facts = all.filter((r) => r.type === "fact").map((r) => r.scope);
    expect(facts.sort()).toEqual(["sales", "sales", "sales.eu"]);
    expect(
      all
        .filter((r) => r.type === "scope")
        .map((r) => r.path)
        .sort(),
    ).toEqual(["sales", "sales.eu"]);
    // The supersedes edge stays inside sales; the edge to the eng fact is left out.
    expect(all.filter((r) => r.type === "edge").map((r) => r.kind)).toEqual(["supersedes"]);
    expect(JSON.stringify(all)).not.toContain("fa-eng");
    expect(all.some((r) => r.type === "audit" || r.type === "working_note")).toBe(false);
    expect(all.filter((r) => r.type === "convention").map((r) => r.scope)).toEqual(["sales", "sales"]);
  });

  it("refuses an agent, and records the refusal", async () => {
    const agent: AccessContext = {
      orgId: A,
      actor: { type: "agent", id: "agent-1", capabilityToken: "wcap_none" },
      origin: "mcp",
    } as AccessContext;
    await expect(collect(agent)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(importMemory({ ...agent, orgId: FULL }, stream(exported))).rejects.toBeInstanceOf(AccessDeniedError);
    const refusals = await db.auditLog.count({
      where: { orgId: A, actorId: "agent-1", decision: "deny", target: `${ROOT_A}:export` },
    });
    expect(refusals).toBe(1);
  });

  it("refuses an agent that can read a scope, for being an agent, not for lacking access", async () => {
    const access = await import("@/services/access");
    const token = access.generateCapabilityToken();
    const sales = await db.scope.findUniqueOrThrow({ where: { orgId_path: { orgId: A, path: `${ROOT_A}.sales` } } });
    await db.grant.create({
      data: { orgId: A, scopeId: sales.id, granteeType: "agent", granteeId: "agent-reader", permission: "read" },
    });
    await db.capability.create({
      data: {
        orgId: A,
        agentId: "agent-reader",
        tokenHash: access.hashCapabilityToken(token),
        scopePath: `${ROOT_A}.sales`,
        permission: "read",
        expiresAt: new Date(Date.now() + 86_400_000),
        createdBy: ADMIN,
      },
    });
    const agent: AccessContext = {
      orgId: A,
      actor: { type: "agent", id: "agent-reader", capabilityToken: token },
      origin: "mcp",
    };
    expect((await access.check(agent, { action: "memory.read", scope: `${ROOT_A}.sales` })).allowed).toBe(true);
    await expect(collect(agent)).rejects.toThrow(/Agent tokens cannot export memory/);
  });

  it("refuses an import into an org that holds memory, and into an org the caller does not administer", async () => {
    await expect(importMemory(person(B, ADMIN), stream(exported))).rejects.toBeInstanceOf(ImportRefusedError);
    await expect(importMemory(person(FULL, SALES_MEMBER), stream(exported))).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await db.memoryChunk.count({ where: { orgId: FULL } })).toBe(0);
  });

  it("refuses a cut-short or tampered file and leaves the org as it was", async () => {
    const before = await countsOf(FULL);
    await expect(importMemory(person(FULL, ADMIN), stream(exported.slice(0, -1)))).rejects.toThrow(/cut short/);
    const tampered = [...exported.slice(0, -2), exported.at(-1)!];
    await expect(importMemory(person(FULL, ADMIN), stream(tampered))).rejects.toThrow(/holds .* records but held/);
    const escaping = exported.map((l) => l.replace('"scope":"sales.eu"', '"scope":"sales..eu"'));
    await expect(importMemory(person(FULL, ADMIN), stream(escaping))).rejects.toBeInstanceOf(ImportRefusedError);
    // `sales-eu` and `sales.eu` would read alike, so the record format refuses a dashed label.
    const dashed = exported.map((l) => l.replace('"scope":"sales.eu"', '"scope":"sales-eu"'));
    await expect(importMemory(person(FULL, ADMIN), stream(dashed))).rejects.toThrow(
      /is not a valid record: scope: a scope relative to the org root/,
    );
    // A scope name past the limit every path that names a scope holds to (services/access/scope-name.ts).
    const longName = exported.map((l) =>
      (JSON.parse(l) as { type?: string }).type === "scope" && l.includes('"name":"sales"')
        ? l.replace('"name":"sales"', `"name":"${"s".repeat(201)}"`)
        : l,
    );
    expect(longName).not.toEqual(exported);
    await expect(importMemory(person(FULL, ADMIN), stream(longName))).rejects.toThrow(/at most 200 characters/);
    expect(await countsOf(FULL)).toEqual(before);
  });
});
