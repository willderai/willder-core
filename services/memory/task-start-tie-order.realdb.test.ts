// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The task-start read breaks a tie between records written at the same instant by their ids,
// in byte order, whatever collation the database was created with. Production's database is
// C.UTF-8, which compares bytes; CI's test server is en_US.utf8, which ignores punctuation at
// first, so `rule-7-v2` sorts above `rule-70-v2` there and below it in production. Left to the
// database default, the same store would serve a different block on each, and a test's
// reference in code would agree with only one of them.
//
// To catch that on any server, this file gives the id columns the read ties on a collation
// that ignores punctuation, as en_US does, and restores them afterwards. Each test then seeds
// one more record than its section serves, all at one instant, with ids whose byte order and
// punctuation-blind order disagree both on which ids are served and in what order.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_taskStartTieOrder";
const SCOPE = `org_${ORG}.team`;
const READER = "agent-reader";
const TASK = "importer-retries";

/** The tables whose ids the read breaks ties on, and the collation that ignores punctuation. */
const TIED_TABLES = ["conventions", "memory_chunks", "working_notes"] as const;
const PUNCTUATION_BLIND = "qa_punctuation_blind";

/** How many records each section serves (services/memory/task-start.ts). */
const RULES_READ = 100;
const TASK_DECISIONS_SERVED = 20;
const TASK_FACTS_SERVED = 20;
const NOTES_SERVED = 3;

/**
 * `count` ids, `<prefix>-1-x` to `<prefix>-<count>-x`. Byte order puts `-` before a digit, so
 * `p-1-x` < `p-10-x`; ignoring punctuation compares `p1x` with `p10x`, and a digit comes before
 * a letter, so the order flips.
 */
const tiedIds = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}-x`);

/** `ids` in descending byte order: the order the read serves records written at one instant. */
const byteOrderDescending = (ids: readonly string[]) =>
  [...ids].sort((a, b) => Buffer.compare(Buffer.from(b), Buffer.from(a)));

describe.skipIf(!QA_URL)("the task-start read's tie order, against a real database", () => {
  let db: PrismaClient;
  let readTaskStartUnchecked: (typeof import("./task-start"))["readTaskStartUnchecked"];
  const instant = new Date(Date.UTC(2026, 9, 1, 12));

  async function cleanup(): Promise<void> {
    await db.workingNote.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  async function reader(): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: READER,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: READER, capabilityToken: token }, origin: "mcp" };
  }

  /** The task's own write of a record, as the MCP write path logs it. */
  async function taskWrite(seq: number, recordType: "convention" | "fact", recordId: string): Promise<void> {
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(seq),
        scopePath: SCOPE,
        recordType,
        recordId,
        op: "create",
        actorId: "agent-author",
        actorType: "agent",
        origin: "mcp",
        summary: recordId,
        task: TASK,
        createdAt: instant,
      },
    });
  }

  /**
   * The served order the test expects, after checking the seed can tell it apart: the order
   * the database's punctuation-blind collation gives must differ, or a read that fell back to
   * it would still pass.
   */
  async function expectedOrder(ids: readonly string[], served: number): Promise<string[]> {
    const expected = byteOrderDescending(ids).slice(0, served);
    const blind = await db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM unnest($1::text[]) AS t(id) ORDER BY id COLLATE ${PUNCTUATION_BLIND} DESC LIMIT ${served}`,
      ids,
    );
    expect(blind.map(({ id }) => id)).not.toEqual(expected);
    expect(new Set(blind.map(({ id }) => id))).not.toEqual(new Set(expected));
    return expected;
  }

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    await db.$executeRawUnsafe(
      `CREATE COLLATION IF NOT EXISTS ${PUNCTUATION_BLIND} (provider = icu, locale = 'en-US-u-ka-shifted')`,
    );
    for (const table of TIED_TABLES) {
      await db.$executeRawUnsafe(`ALTER TABLE "${table}" ALTER COLUMN "id" TYPE text COLLATE ${PUNCTUATION_BLIND}`);
    }
    ({ readTaskStartUnchecked } = await import("./task-start"));
  });

  beforeEach(async () => {
    await cleanup();
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    for (const table of TIED_TABLES) {
      await db.$executeRawUnsafe(`ALTER TABLE "${table}" ALTER COLUMN "id" TYPE text COLLATE "default"`);
    }
    await db.$disconnect();
  });

  it("reads the scope's newest rules, and serves them, in byte order of id among rules written at one instant", async () => {
    const ids = tiedIds("rule", RULES_READ + 1);
    await db.convention.createMany({
      data: ids.map((id) => ({
        id,
        orgId: ORG,
        scopePath: SCOPE,
        kind: "convention" as const,
        subject: `Rule ${id}`,
        text: "Quote in the customer's currency.",
        actorId: "agent-author",
        createdAt: instant,
      })),
    });
    const expected = await expectedOrder(ids, RULES_READ);
    const { context } = await readTaskStartUnchecked(await reader(), SCOPE, "");
    expect(context.rules.map((rule) => rule.id)).toEqual(expected);
  });

  it("serves the task's decisions written at one instant in byte order of id", async () => {
    const ids = tiedIds("decision", TASK_DECISIONS_SERVED + 1);
    await db.convention.createMany({
      data: ids.map((id) => ({
        id,
        orgId: ORG,
        scopePath: SCOPE,
        kind: "decision" as const,
        subject: `Decision ${id}`,
        text: "Retry a page three times.",
        actorId: "agent-author",
        createdAt: instant,
      })),
    });
    for (const [i, id] of ids.entries()) await taskWrite(i + 1, "convention", id);
    const expected = await expectedOrder(ids, TASK_DECISIONS_SERVED);
    const { task } = await readTaskStartUnchecked(await reader(), SCOPE, "", TASK);
    expect(task.decisions.map((decision) => decision.id)).toEqual(expected);
  });

  it("serves the versions of the task's facts written at one instant in byte order of id, after the one the task wrote", async () => {
    const written = "fact-written";
    const ids = tiedIds("fact", TASK_FACTS_SERVED + 1);
    await db.memoryChunk.createMany({
      data: [written, ...ids].map((id) => ({
        id,
        orgId: ORG,
        scopePath: SCOPE,
        entityName: "importer notes",
        content: `Page two retried, per ${id}.`,
        actorType: "agent",
        actorId: "agent-author",
        factVersion: true,
        createdAt: instant,
      })),
    });
    // The task wrote one version; the others are versions of the same fact, read with it.
    await taskWrite(1, "fact", written);
    const expected = [written, ...(await expectedOrder(ids, TASK_FACTS_SERVED - 1))];
    const { task } = await readTaskStartUnchecked(await reader(), SCOPE, "", TASK);
    expect(task.facts.map((fact) => fact.id)).toEqual(expected);
  });

  it("serves the live notes posted at one instant in byte order of id", async () => {
    // Ids 1 to 11 would put 9, 8 and 7 first in either order, so these are chosen to disagree at the top.
    const ids = ["note-7-x", "note-70-x", "note-1-x", "note-10-x"];
    await db.workingNote.createMany({
      data: ids.map((id) => ({
        id,
        orgId: ORG,
        scopePath: SCOPE,
        agentId: "agent-author",
        task: TASK,
        kind: "status" as const,
        body: `Working, ${id}.`,
        expiresAt: new Date(Date.now() + 3_600_000),
        createdAt: instant,
      })),
    });
    const expected = await expectedOrder(ids, NOTES_SERVED);
    const { notes } = await readTaskStartUnchecked(await reader(), SCOPE, "", TASK);
    expect(notes.served.map((note) => note.id)).toEqual(expected);
  });
});
