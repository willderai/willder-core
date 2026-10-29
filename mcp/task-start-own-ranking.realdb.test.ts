// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The task-start block serves the task's own facts most relevant to
// what the session is doing first, each as a short excerpt, so the deciding review is in the
// first three items even when later comments were written after it.
//
// The workflow: pull request review histories are imported into one scope, each comment a fact
// filed under its pull request and named by the task's short key, as a client's WILLDER_TASK
// names it (task-start-review-history.testsupport.ts). After the deciding review come an
// acknowledgement and a fix note, a long automated review, or three long comments on other
// things. A session then starts each task with the pull request's title as its prompt. The block
// must serve the deciding review in the first three items, its excerpt cut at a sentence the
// prompt's words name, never at the import's header line. Which sentence that is, the defect or
// the review's closing instruction, is the passage's call (services/memory/relevance.ts,
// bestPassage); the line names the fact, and memory_version opens it whole.
//
// What the ranking may never do: reach a record another org wrote under the same task key and
// scope string, a record in a sibling scope (`reviews_private`, or `reviewsx`, which an
// unescaped LIKE on `reviews_` would match), or a record naming a person erased from the org,
// however relevant to the prompt each one is.
//
// Real: Postgres, the capability check, the task-start read and the block as served
// (taskStartNotice). The history is written straight to the tables, as memory_ingest stores a
// fact and its change event.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withoutSources } from "./task-start-headings";
import { TASK_START_PREMISE_CHECK } from "./task-start-headings";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { reviewHistory, type AfterTheDecision, type ReviewRecord } from "./task-start-review-history.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_taskStartOwnRanking";
const OTHER_ORG = "qa_taskStartOwnRankingB";
const ROOT = `org_${ORG}`;
const READER = "agent-reader";
const ERASED = "Orla Vennick";

/** The short key a session names its task by: what WILLDER_TASK holds in a client's config. */
const keyOf = (pr: number) => `PR-${pr}`;
/** What the session was asked to do: the pull request's title, as a prompt. */
const promptOf = (task: string) => task.slice(task.indexOf(": ") + 2);

// A hung-test bound, not a claim: each test takes under a second on a quiet machine but can pass
// vitest's 5 s test and 10 s hook defaults under heavy load. Nothing here asserts on time.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe.skipIf(!QA_URL)("the task's own facts, most relevant to the session's prompt first", () => {
  let db: PrismaClient;
  let taskStartNotice: (typeof import("./task-start-notice"))["taskStartNotice"];
  let rankingTextOf: (typeof import("./task-start-notice"))["rankingTextOf"];
  let estimateTokens: (typeof import("./task-start-notice"))["estimateTokens"];
  let TASK_START_TOKEN_BUDGET: number;
  let TASK_START_MAX_TOKENS: number;
  let seq = 0;
  let session = 0;

  async function cleanup(): Promise<void> {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.deleteMany({ where: { id: orgId } });
    }
  }

  /** Store `records` in `scopePath` of `orgId` as memory_ingest does, oldest first, a later part at its write's instant. */
  async function write(
    records: (Omit<ReviewRecord, "task"> & { task: string })[],
    scopePath: string,
    orgId = ORG,
    at?: Date,
  ): Promise<void> {
    const base = Date.UTC(2026, 9, 1);
    let instant = seq;
    const numbered = records.map((record) => {
      const n = ++seq;
      if (!record.sameWriteAsPrevious) instant = n;
      return { record, n, createdAt: at ?? new Date(base + instant * 1000) };
    });
    await db.memoryChunk.createMany({
      data: numbered.map(({ record, createdAt }) => ({
        id: record.id,
        orgId,
        content: record.content,
        entityName: record.entityName,
        scopePath,
        actorType: "agent",
        actorId: "importer",
        factVersion: true,
        createdAt,
      })),
    });
    await db.changeEvent.createMany({
      data: numbered.map(({ record, n, createdAt }) => ({
        orgId,
        seq: BigInt(n),
        scopePath,
        recordType: "fact",
        recordId: record.id,
        op: "create" as const,
        actorId: "importer",
        actorType: "agent",
        origin: "mcp",
        summary: record.content.split("\n", 1)[0]!.slice(0, 200),
        task: record.task,
        createdAt,
      })),
    });
  }

  /** A reader holding read on `scopePath` only. */
  async function readerOn(scopePath: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: READER,
        tokenHash: hashCapabilityToken(token),
        scopePath,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: READER, capabilityToken: token }, origin: "mcp" };
  }

  /** The block a fresh session of the task keyed `taskKey`, prompted with `prompt`, is served. */
  async function blockFor(ctx: AccessContext, scopePath: string, taskKey: string, prompt: string): Promise<string> {
    const block = await taskStartNotice(ctx, {
      scopePath,
      sessionKey: `session-${++session}`,
      taskText: rankingTextOf(taskKey, prompt),
      taskKey,
    });
    if (block === null) throw new Error(`no block for ${taskKey}`);
    return block;
  }

  const itemsOf = (block: string) => block.split("\n").filter((line) => line.startsWith("- "));

  /**
   * Where `block` serves the review `decidingId`, 1-based among its items (0 when it does not),
   * and whether that line's excerpt is cut at a sentence naming the task's changed path rather
   * than at the import's header line.
   */
  function servedReview(block: string, decidingId: string, task: string): { at: number; cutAtPath: boolean } {
    const items = itemsOf(block);
    const at = items.findIndex((line) => line.includes(`[fact ${decidingId}]`));
    const line = items[at] ?? "";
    const excerpt = line.slice(2, line.indexOf(" [fact "));
    const path = /app\/api\/\w+\/route\.ts/.exec(task)![0];
    return { at: at + 1, cutAtPath: excerpt.includes(path) && !excerpt.includes("wrote a comment (") };
  }

  /** The history of `after`, every record keyed by its pull request's short key, in a scope of its own. */
  async function importHistory(after: AfterTheDecision) {
    const scope = `${ROOT}.reviews_${after.replace(/\W+/g, "_")}`;
    const history = reviewHistory(20, 511, after);
    const byTask = new Map(history.tasks.map((t) => [t.task, keyOf(t.pr)]));
    await write(
      history.records.map((r) => ({ ...r, id: `${r.id}-${after}`, task: byTask.get(r.task)! })),
      scope,
    );
    return { scope, history, reader: await readerOn(scope) };
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ taskStartNotice, rankingTextOf, estimateTokens, TASK_START_TOKEN_BUDGET, TASK_START_MAX_TOKENS } = await import(
      "./task-start-notice"
    ));
    await cleanup();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await db.org.create({ data: { id: OTHER_ORG, name: OTHER_ORG } });
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await cleanup();
    await db.$disconnect();
  });

  for (const after of ["acknowledgement", "long automated review"] as const) {
    it(`serves the deciding review in the first three items, cut where the prompt's words are, with ${after} written after it`, async () => {
      const { scope, history, reader } = await importHistory(after);
      const late: number[] = [];
      const cutElsewhere: number[] = [];
      for (const { pr, task, decidingId } of history.tasks) {
        const block = await blockFor(reader, scope, keyOf(pr), promptOf(task));
        // The premise check shows no record, so it is added on top of the records' budget.
        expect(estimateTokens(withoutSources(block.replace(`\n${TASK_START_PREMISE_CHECK}`, "")))).toBeLessThanOrEqual(
          TASK_START_TOKEN_BUDGET,
        );
        expect(estimateTokens(block)).toBeLessThanOrEqual(TASK_START_MAX_TOKENS);
        const { at, cutAtPath } = servedReview(block, `${decidingId}-${after}`, task);
        if (at < 1 || at > 3) late.push(pr);
        if (!cutAtPath) cutElsewhere.push(pr);
      }
      expect({ late, cutElsewhere }).toEqual({ late: [], cutElsewhere: [] });
    });
  }

  it("serves the deciding review in the first three items when three long comments on other things follow it", async () => {
    const after = "nothing";
    const { scope, history, reader } = await importHistory(after);
    // Each about 1,500 characters, on the deploy and the docs: what a busy pull request collects
    // after its review. Serving each write whole, the two newest fill the budget.
    const offTopic = (pr: number, k: number) =>
      `On pull request #${pr} of acme/storefront, builder-b wrote a comment:\n${Array.from(
        { length: 14 },
        (_, s) =>
          `Deploy note ${k}.${s}: the preview build for the docs site finished and the changelog entry reads well.`,
      ).join(" ")}`;
    for (const { pr } of history.tasks) {
      await write(
        [1, 2, 3].map((k) => ({
          id: `pr${pr}-late${k}`,
          entityName: `acme/storefront pull request #${pr}`,
          content: offTopic(pr, k),
          task: keyOf(pr),
        })),
        scope,
      );
    }
    const late: number[] = [];
    const cutElsewhere: number[] = [];
    for (const { pr, task, decidingId } of history.tasks) {
      const block = await blockFor(reader, scope, keyOf(pr), promptOf(task));
      // The premise check shows no record, so it is added on top of the records' budget.
      expect(estimateTokens(withoutSources(block.replace(`\n${TASK_START_PREMISE_CHECK}`, "")))).toBeLessThanOrEqual(
        TASK_START_TOKEN_BUDGET,
      );
      expect(estimateTokens(block)).toBeLessThanOrEqual(TASK_START_MAX_TOKENS);
      const { at, cutAtPath } = servedReview(block, `${decidingId}-${after}`, task);
      if (at < 1 || at > 3) late.push(pr);
      if (!cutAtPath) cutElsewhere.push(pr);
    }
    expect({ late, cutElsewhere }).toEqual({ late: [], cutElsewhere: [] });
  });

  describe("records the ranking must never reach, however relevant to the prompt", () => {
    const TASK = "WEB-412";
    const PROMPT = "Fix the invoices pagination cursor in app/api/invoices/route.ts";
    const scope = `${ROOT}.ledger`;
    /** As relevant to the prompt as a record can be: every term, several times. */
    const bait = (marker: string) =>
      `${marker}: ${"the invoices pagination cursor in app/api/invoices/route.ts. ".repeat(4)}`;
    const own = (id: string, content: string) => ({
      id,
      entityName: "acme/storefront pull request #900",
      content,
      task: TASK,
    });
    let block: string;

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      // The review first: newest first would serve the pull request ahead of it.
      await write(
        [
          own("ledger-review", "Review: the invoices cursor skips a row on page two."),
          own("ledger-pr", "Pull request #900: the ledger page."),
        ],
        scope,
      );
      // The same task key and scope string, in another org.
      await write([{ ...own("other-tenant", bait("OTHER-TENANT")) }], scope, OTHER_ORG);
      // Sibling scopes: one with a longer name, one an unescaped `_` would match.
      await write([{ ...own("sibling-private", bait("SIBLING-PRIVATE")) }], `${scope}_private`);
      await write([{ ...own("sibling-x", bait("SIBLING-X")) }], `${ROOT}.ledgerx`);
      // Written before the erasure of the person it names: an old copy, never served.
      const erasedAt = new Date();
      await write(
        [own("names-erased", `${bait("ERASED-COPY")} Escalated by ${ERASED}.`)],
        scope,
        ORG,
        new Date(erasedAt.getTime() - 60 * 60 * 1000),
      );
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db, ORG, "qa-request", { emails: [], names: [ERASED.toLowerCase()], contactIds: [] });
      block = await blockFor(await readerOn(scope), scope, TASK, PROMPT);
    });

    it("serves the task's own records, the one about the prompt first", () => {
      expect(itemsOf(block).map((line) => line.match(/\[fact (\S+)\]/)?.[1])).toEqual(["ledger-review", "ledger-pr"]);
    });

    it("serves nothing another org wrote under the same task key and scope string", () => {
      expect(block).not.toContain("OTHER-TENANT");
    });

    it("serves nothing from a sibling scope, by a longer name or an unescaped underscore", () => {
      expect(block).not.toContain("SIBLING-PRIVATE");
      expect(block).not.toContain("SIBLING-X");
    });

    it("serves no copy naming a person erased from the org, and no trace of it", () => {
      expect(block).not.toContain("ERASED-COPY");
      expect(block).not.toContain(ERASED);
      expect(block).not.toContain("names-erased");
      expect(block).not.toMatch(/more left out/);
    });
  });
});
