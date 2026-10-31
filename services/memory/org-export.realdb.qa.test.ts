// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Export and import, beside org-export-roundtrip.realdb.test.ts:
// an edge into a sibling scope whose name extends the member's (`sales_eu` next to
// `sales`), or out of a scope they cannot read into one they can, stays out of a
// member's export; a person who belongs to the target org but
// does not administer it cannot import; and a failed import removes only what the
// import itself wrote, never a row another writer added to the org meanwhile.
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

const SOURCE = "qaxsrc";
const TARGET = "qaxtarget";
const ORGS = [SOURCE, TARGET];
const ROOT_SOURCE = `org_${SOURCE}`;

const ADMIN = "u-qax-admin";
const SALES_READER = "u-qax-sales";
const TARGET_READER = "u-qax-target-reader";

const DIMENSIONS = 384;

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

const person = (orgId: string, id: string): AccessContext => ({
  orgId,
  actor: { type: "human", id, role: "admin" },
  origin: "app",
});

describe.skipIf(!QA_URL)("export and import access, QA, real Postgres", () => {
  let db: PrismaClient;
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let importMemory: (typeof import("./org-import"))["importMemory"];
  let AccessDeniedError: (typeof import("@/services/access"))["AccessDeniedError"];
  let exported: string[] = [];

  async function collect(ctx: AccessContext): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of exportMemory(ctx)) lines.push(line.trimEnd());
    return lines;
  }

  async function reset() {
    await db.factEdge.deleteMany({ where: { orgId: { in: ORGS } } });
    await deleteOrgsWithRetry(db, { where: { id: { in: ORGS } } });
    await db.user.deleteMany({ where: { id: { in: [ADMIN, SALES_READER, TARGET_READER] } } });
  }

  async function insertFact(orgId: string, id: string, scopePath: string | null, content: string) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", embedding)
      VALUES (${id}, ${orgId}, ${content}, 'text', 'agent', 'agent-1', ${scopePath}, ${`[${embed(content).join(",")}]`}::vector)`;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn(embeddingService));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ exportMemory } = await import("./org-export"));
    ({ importMemory } = await import("./org-import"));
    ({ AccessDeniedError } = await import("@/services/access"));
    await reset();

    for (const org of ORGS) {
      await db.org.create({ data: { id: org, name: org } });
      const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
      await db.grant.create({
        data: { orgId: org, scopeId: root.id, granteeType: "role", granteeId: "admin", permission: "admin" },
      });
    }
    for (const org of ORGS) await seedMember(db, { orgId: org, userId: ADMIN, role: "admin" });
    const sales = await db.scope.create({ data: { orgId: SOURCE, path: `${ROOT_SOURCE}.sales`, name: "sales" } });
    await db.scope.create({ data: { orgId: SOURCE, path: `${ROOT_SOURCE}.sales_eu`, name: "sales_eu" } });
    await db.scope.create({ data: { orgId: SOURCE, path: `${ROOT_SOURCE}.ops`, name: "ops" } });
    await seedMember(db, { orgId: SOURCE, userId: SALES_READER, role: "member" });
    await db.grant.create({
      data: { orgId: SOURCE, scopeId: sales.id, granteeType: "user", granteeId: SALES_READER, permission: "read" },
    });

    await insertFact(SOURCE, "qax-sales", `${ROOT_SOURCE}.sales`, "Globex renews in June.");
    await insertFact(SOURCE, "qax-sibling", `${ROOT_SOURCE}.sales_eu`, "Globex EU discount is twelve percent.");
    // From a sales fact into the sibling: the edge's own scope is sales, its target is not.
    await db.factEdge.create({
      data: {
        orgId: SOURCE,
        fromId: "qax-sales",
        toId: "qax-sibling",
        kind: "dependsOn",
        scopePath: `${ROOT_SOURCE}.sales`,
        actorType: "agent",
        actorId: "agent-1",
      },
    });

    // From an ops fact into sales: the target is readable, the edge's own scope is not.
    await insertFact(SOURCE, "qax-ops", `${ROOT_SOURCE}.ops`, "Ops tracks Globex renewal risk.");
    await db.factEdge.create({
      data: {
        orgId: SOURCE,
        fromId: "qax-ops",
        toId: "qax-sales",
        kind: "dependsOn",
        scopePath: `${ROOT_SOURCE}.ops`,
        actorType: "agent",
        actorId: "agent-1",
      },
    });

    // The target org: an admin, and a member who reads the whole org but administers nothing.
    const targetRoot = await db.scope.findFirstOrThrow({ where: { orgId: TARGET, path: `org_${TARGET}` } });
    await seedMember(db, { orgId: TARGET, userId: TARGET_READER, role: "member" });
    await db.grant.create({
      data: {
        orgId: TARGET,
        scopeId: targetRoot.id,
        granteeType: "user",
        granteeId: TARGET_READER,
        permission: "read",
      },
    });

    exported = await collect(person(SOURCE, ADMIN));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await reset();
    await db.$disconnect();
  });

  it("a sales reader's export leaves out an edge into sales_eu and one out of ops, naming neither fact", async () => {
    const lines = await collect(person(SOURCE, SALES_READER));
    const text = lines.join("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ coverage: "scopes", scopes: ["sales"] });
    expect(text).toContain("Globex renews in June.");
    expect(text).not.toContain("qax-sibling");
    expect(text).not.toContain("qax-ops");
    expect(text).not.toContain("twelve percent");
    expect(lines.some((l) => l.startsWith('{"type":"edge"'))).toBe(false);
    expect(lines.some((l) => l.includes('"path":"sales_eu"'))).toBe(false);
  });

  it("the admin's export holds the same edge, so the reader's omission is access, not a missing row", () => {
    const edges = exported.filter((l) => l.startsWith('{"type":"edge"')).map((l) => JSON.parse(l));
    expect(edges).toMatchObject([
      { fromId: "qax-sales", toId: "qax-sibling", scope: "sales" },
      { fromId: "qax-ops", toId: "qax-sales", scope: "ops" },
    ]);
  });

  it("refuses an import by a member of the target org who reads it all but does not administer it", async () => {
    await expect(
      importMemory(
        person(TARGET, TARGET_READER),
        (async function* () {
          yield* exported;
        })(),
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    expect(await db.memoryChunk.count({ where: { orgId: TARGET } })).toBe(0);
    expect(await db.scope.count({ where: { orgId: TARGET } })).toBe(1);
  });

  it("a failed import removes only its own rows, not a fact another writer added meanwhile", async () => {
    // The file is cut short (no end record). While it is read, a connector writes a fact.
    const cutShort = exported.slice(0, -1);
    async function* withConcurrentWrite() {
      for (const [i, line] of cutShort.entries()) {
        if (i === cutShort.length - 1)
          await insertFact(TARGET, "qax-concurrent", `org_${TARGET}`, "Written by a sync during the import.");
        yield line;
      }
    }
    await expect(importMemory(person(TARGET, ADMIN), withConcurrentWrite())).rejects.toThrow(/cut short/);
    const left = await db.memoryChunk.findMany({ where: { orgId: TARGET }, select: { id: true } });
    expect(left.map((r) => r.id)).toEqual(["qax-concurrent"]);
  });

  it("keeps another writer's note, rule, source, brief and edge too, not only its fact", async () => {
    await db.memoryChunk.deleteMany({ where: { orgId: TARGET } });
    const scopePath = `org_${TARGET}`;
    const cutShort = exported.slice(0, -1);
    async function* withConcurrentWrites() {
      for (const [i, line] of cutShort.entries()) {
        if (i === cutShort.length - 1) {
          await insertFact(TARGET, "qax-other-a", scopePath, "Written by a sync during the import.");
          await insertFact(TARGET, "qax-other-b", scopePath, "Also written by that sync.");
          await db.factEdge.create({
            data: {
              id: "qax-other-edge",
              orgId: TARGET,
              fromId: "qax-other-a",
              toId: "qax-other-b",
              kind: "dependsOn",
              scopePath,
              actorType: "agent",
              actorId: "agent-1",
            },
          });
          await db.workingNote.create({
            data: {
              id: "qax-other-note",
              orgId: TARGET,
              scopePath,
              agentId: "agent-1",
              task: "sync",
              kind: "claim",
              body: "Claimed during the import.",
              expiresAt: new Date(Date.now() + 3_600_000),
            },
          });
          await db.convention.create({
            data: {
              id: "qax-other-rule",
              orgId: TARGET,
              scopePath,
              kind: "decision",
              subject: "sync",
              text: "Decided during the import.",
              actorId: "agent-1",
            },
          });
          await db.source.create({
            data: {
              id: "qax-other-source",
              orgId: TARGET,
              type: "website",
              externalId: "qax.example",
              name: "qax",
              scopePath,
            },
          });
          await db.brief.create({
            data: {
              id: "qax-other-brief",
              orgId: TARGET,
              type: "handoff",
              scopePath,
              title: "During the import",
              summary: "Written meanwhile.",
              sections: [],
            },
          });
        }
        yield line;
      }
    }
    await expect(importMemory(person(TARGET, ADMIN), withConcurrentWrites())).rejects.toThrow(/cut short/);

    const where = { orgId: TARGET };
    expect(
      (await db.memoryChunk.findMany({ where, select: { id: true }, orderBy: { id: "asc" } })).map((r) => r.id),
    ).toEqual(["qax-other-a", "qax-other-b"]);
    expect((await db.factEdge.findMany({ where, select: { id: true } })).map((r) => r.id)).toEqual(["qax-other-edge"]);
    expect((await db.workingNote.findMany({ where, select: { id: true } })).map((r) => r.id)).toEqual([
      "qax-other-note",
    ]);
    expect((await db.convention.findMany({ where, select: { id: true } })).map((r) => r.id)).toEqual([
      "qax-other-rule",
    ]);
    expect((await db.source.findMany({ where, select: { id: true } })).map((r) => r.id)).toEqual(["qax-other-source"]);
    expect((await db.brief.findMany({ where, select: { id: true } })).map((r) => r.id)).toEqual(["qax-other-brief"]);
  });
});
