// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test Postgres;
// without it every test in this file is skipped, not failed.
//
// The order the task-start read serves a scope's rules in (services/memory/rule-order.ts),
// against a real database: the rules the task cites first, though they are older than the
// newest the read considers; then the newest; then the rest by relevance. The block's own
// rendering of them is covered in mcp/task-start-notice.test.ts. The last tests read the plan
// Postgres runs: a task that names no rule reads the scope's newest rules by the
// (orgId, createdAt) index and stops there, however many rules the scope holds.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { listAsTheApp } from "@/services/memory/erasure-suppression.testsupport";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_taskStartRuleOrder";
const SCOPE = `org_${ORG}.team`;
const READER = "agent-reader";
const TASK = "importer-retries";

describe.skipIf(!QA_URL)("the task-start read's rule order, against a real database", () => {
  let db: PrismaClient;
  let readTaskStartUnchecked: (typeof import("./task-start"))["readTaskStartUnchecked"];
  let taskStartNotice: (typeof import("@/mcp/task-start-notice"))["taskStartNotice"];
  let NEWEST_RULES_FIRST: number;
  let appDb: (typeof import("@/lib/db"))["db"];
  let session = 0;

  async function cleanup(): Promise<void> {
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await deleteOrgsWithRetry(db, { where: { id: ORG } });
  }

  /** Records `rules` in SCOPE, the first the oldest, a minute apart, ending an hour ago. */
  async function recordRules(rules: { subject: string; text: string }[]): Promise<void> {
    const end = Date.now() - 60 * 60 * 1000;
    await db.convention.createMany({
      data: rules.map((rule, i) => ({
        orgId: ORG,
        scopePath: SCOPE,
        kind: "decision" as const,
        subject: rule.subject,
        text: rule.text,
        actorId: "agent-author",
        createdAt: new Date(end - (rules.length - i) * 60_000),
      })),
    });
  }

  /** `count` rules no task names, each its own, about office matters. */
  const officeRules = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({
      subject: `Office note ${from + i}`,
      text: `Bring a charger on day ${from + i}.`,
    }));

  /** A fact the task's earlier session wrote, as memory_ingest stores it, at `createdAt`. */
  async function taskFact(id: string, content: string, createdAt: Date): Promise<void> {
    await db.memoryChunk.create({
      data: {
        id,
        orgId: ORG,
        content,
        entityName: "importer notes",
        scopePath: SCOPE,
        actorType: "agent",
        actorId: "agent-author",
        factVersion: true,
        createdAt,
      },
    });
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(1),
        scopePath: SCOPE,
        recordType: "fact",
        recordId: id,
        op: "create",
        actorId: "agent-author",
        actorType: "agent",
        origin: "mcp",
        summary: content.slice(0, 200),
        task: TASK,
        createdAt,
      },
    });
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

  const subjectsRead = async (taskText: string, taskKey = "") =>
    (await readTaskStartUnchecked(await reader(), SCOPE, taskText, taskKey)).context.rules.map((rule) => rule.subject);

  beforeAll(async () => {
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL! }) });
    ({ readTaskStartUnchecked } = await import("./task-start"));
    ({ NEWEST_RULES_FIRST } = await import("./rule-order"));
    ({ taskStartNotice } = await import("@/mcp/task-start-notice"));
    ({ db: appDb } = await import("@/lib/db"));
  });

  beforeEach(async () => {
    await cleanup();
    await db.org.create({ data: { id: ORG, name: ORG } });
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.$disconnect();
  });

  it("serves the newest rules first, ahead of an older rule that shares more of the task's words", async () => {
    const relevant = { subject: "Importer retries", text: "The importer retries a failed page three times." };
    await recordRules([relevant, ...officeRules(NEWEST_RULES_FIRST)]);
    const subjects = await subjectsRead("Fix the importer retries for a failed page");
    expect(subjects[0]).toBe(`Office note ${NEWEST_RULES_FIRST - 1}`);
    expect(subjects.slice(0, NEWEST_RULES_FIRST)).toEqual(
      officeRules(NEWEST_RULES_FIRST)
        .map((r) => r.subject)
        .reverse(),
    );
    expect(subjects[NEWEST_RULES_FIRST]).toBe("Importer retries");
  });

  it("ranks the rules past the newest by relevance to the task", async () => {
    const older = [
      { subject: "Importer retries", text: "The importer retries a failed page three times." },
      ...officeRules(3, 100),
    ];
    await recordRules([...older, ...officeRules(NEWEST_RULES_FIRST)]);
    const subjects = await subjectsRead("Fix the importer retries for a failed page");
    expect(subjects[NEWEST_RULES_FIRST]).toBe("Importer retries");
  });

  it("reads and serves first a rule the task names by its subject, though a hundred newer rules leave it out of the newest", async () => {
    await recordRules([
      { subject: "release-gate-20260901", text: "Nothing ships without a green gate." },
      ...officeRules(105),
    ]);
    const subjects = await subjectsRead("Ship the importer, per release-gate-20260901");
    expect(subjects[0]).toBe("release-gate-20260901");
    expect(subjects).toHaveLength(100);
  });

  it("reads and serves first a rule the task names by its id", async () => {
    await recordRules([{ subject: "Release gate", text: "Nothing ships without a green gate." }, ...officeRules(105)]);
    const { id } = (await db.convention.findFirst({ where: { orgId: ORG, subject: "Release gate" } }))!;
    const subjects = await subjectsRead(`Ship the importer, per rule ${id}`);
    expect(subjects[0]).toBe("Release gate");
  });

  it("serves first a rule the task's own earlier session cited, though the task's words do not name it", async () => {
    await recordRules([
      { subject: "retry-budget-20260901", text: "At most three retries per page." },
      ...officeRules(12),
    ]);
    await taskFact(
      "fact-cites",
      "Kept the importer within retry-budget-20260901 while fixing page two.",
      new Date(Date.now() - 30 * 60_000),
    );
    expect((await subjectsRead("Continue the importer work", TASK))[0]).toBe("retry-budget-20260901");
    expect((await subjectsRead("Continue the importer work"))[0]).not.toBe("retry-budget-20260901");
  });

  it("serves first a rule that a decision the task recorded names", async () => {
    await recordRules([
      { subject: "retry-budget-20260901", text: "At most three retries per page." },
      ...officeRules(12),
    ]);
    const decision = await db.convention.create({
      data: {
        orgId: ORG,
        scopePath: SCOPE,
        kind: "decision",
        subject: "Importer approach",
        text: "Retry pages within retry-budget-20260901.",
        actorId: "agent-author",
      },
    });
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(1),
        scopePath: SCOPE,
        recordType: "convention",
        recordId: decision.id,
        op: "create",
        actorId: "agent-author",
        actorType: "agent",
        origin: "mcp",
        summary: "Importer approach",
        task: TASK,
      },
    });
    const read = await readTaskStartUnchecked(await reader(), SCOPE, "Continue the importer work", TASK);
    expect(read.task.decisions.map((d) => d.subject)).toEqual(["Importer approach"]);
    expect(read.context.rules[0]!.subject).toBe("retry-budget-20260901");
  });

  it("takes no citation from a fact due the erased-person check, whose text may be withheld", async () => {
    await recordRules([
      { subject: "retry-budget-20260901", text: "At most three retries per page." },
      ...officeRules(12),
    ]);
    await taskFact(
      "fact-cites",
      "Kept the importer within retry-budget-20260901 while fixing page two.",
      new Date(Date.now() - 30 * 60_000),
    );
    await listAsTheApp(db, { data: { orgId: ORG, kind: "email", digest: "d".repeat(64), requestId: "erasure-1" } });
    expect((await subjectsRead("Continue the importer work", TASK))[0]).not.toBe("retry-budget-20260901");
  });

  it("serves the cited rule first in the block a session is given", async () => {
    await recordRules([
      { subject: "release-gate-20260901", text: "Nothing ships without a green gate." },
      ...officeRules(30),
    ]);
    const block = await taskStartNotice(await reader(), {
      scopePath: SCOPE,
      sessionKey: `s-${++session}`,
      taskText: "Ship the importer, per release-gate-20260901",
    });
    const rules = block!.split("\n").filter((line) => line.startsWith("- [decision"));
    expect(rules[0]).toContain("release-gate-20260901: Nothing ships without a green gate.");
  });
  /**
   * How many rows of the scope's rules (the `conventions` table read as `c`) Postgres reads to
   * answer the task-start statement for `taskText`, from EXPLAIN ANALYZE of the very statement
   * the read sends: the rows each scan returned plus those its filter dropped, over every loop.
   */
  async function ruleRowsScanned(taskText: string): Promise<number> {
    const sent = vi.spyOn(appDb, "$queryRaw");
    await readTaskStartUnchecked(await reader(), SCOPE, taskText);
    const [strings, ...values] = sent.mock.calls[0]! as unknown as [TemplateStringsArray, ...unknown[]];
    sent.mockRestore();
    const explain = [`EXPLAIN (ANALYZE, FORMAT JSON) ${strings[0]}`, ...strings.slice(1)] as string[] & {
      raw: string[];
    };
    explain.raw = [...explain];
    const [{ "QUERY PLAN": plan }] = await db.$queryRaw<{ "QUERY PLAN": { Plan: PlanNode }[] }[]>(
      explain as unknown as TemplateStringsArray,
      ...values,
    );
    let scanned = 0;
    const walk = (node: PlanNode) => {
      if (node["Relation Name"] === "conventions" && node["Alias"] === "c") {
        scanned += (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"];
      }
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plan[0]!.Plan);
    return scanned;
  }

  it("reads only the scope's newest rules, by index, for a task that names no rule", async () => {
    await recordRules(officeRules(2_000));
    await db.$executeRawUnsafe(`ANALYZE "conventions"`);
    // The read considers the 100 newest; a walk of the index stops a row or so past them.
    expect(await ruleRowsScanned("Fix the importer retries for a failed page")).toBeLessThanOrEqual(200);
  });

  it("still reads an old rule the task names, ahead of the newest, when the scope holds many", async () => {
    await recordRules([
      { subject: "release-gate-20260901", text: "Nothing ships without a green gate." },
      ...officeRules(2_000),
    ]);
    await db.$executeRawUnsafe(`ANALYZE "conventions"`);
    const subjects = await subjectsRead("Ship the importer, per release-gate-20260901");
    expect(subjects[0]).toBe("release-gate-20260901");
    expect(subjects.slice(1, 4)).toEqual(["Office note 1999", "Office note 1998", "Office note 1997"]);
    expect(subjects).toHaveLength(100);
  });
});

/** The part of an EXPLAIN (ANALYZE, FORMAT JSON) plan node this file reads. */
interface PlanNode {
  "Relation Name"?: string;
  Alias?: string;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
}
