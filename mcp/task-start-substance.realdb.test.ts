// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The task-start block serves what decides a task, by its
// substance, near the top.
//
// The workflow: twenty pull requests' review histories are imported into one scope, each
// comment a fact filed under its pull request and named by its task, up to the reviewer's
// change request that decides it (task-start-review-history.testsupport.ts). The request's defect
// is named a few sentences into a long comment, and some requests were stored in parts. An agent
// then starts each task in a fresh session. Its block must serve the request in the first three
// items, cut at a sentence the task's words name, not at the comment's header, and how the
// session words its task may reorder what it is told the task left but never add or drop a record. A task nothing in the scope is relevant to is
// served nothing more than before, a recent write is found by whole terms within what the block
// could serve, and a record the agent may not read is never served, however new.
//
// Real: Postgres, the capability check, the task-start read and the block as served
// (taskStartNotice). The history is written straight to the tables, as memory_ingest stores a
// fact and its change event; ingest itself is not what is measured here.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withoutSources } from "./task-start-headings";
import { TASK_START_PREMISE_CHECK } from "./task-start-headings";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { reviewHistory, type ReviewRecord } from "./task-start-review-history.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;

/**
 * The 4,000 characters of a fact a block may serve, plus its id, entity name, summary and other
 * short fields: what the task-start read may return for one candidate without reading it whole.
 */
const SERVED_HEAD_WITH_FIELDS = 4_000 + 500;

/** Every character of text in `value`, as a statement returned it: the work a bound on reads counts. */
function charactersIn(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + charactersIn(item), 0);
  if (value !== null && typeof value === "object")
    return Object.values(value).reduce((sum: number, item) => sum + charactersIn(item), 0);
  return 0;
}

const ORG = "qa_taskStartSubstance";
const ROOT = `org_${ORG}`;
const REVIEWS = `${ROOT}.reviews`;
/** A sibling of `reviews`, not a descendant: an unescaped LIKE on the scope would match it. */
const REVIEWS_SIBLING = `${ROOT}.reviews_private`;
/** Holds only rules, for the quiet path. */
const HANDBOOK = `${ROOT}.handbook`;
/** Holds a task whose writer declared roles. */
const CHECKOUT = `${ROOT}.checkout`;
/** Holds writes no task named, found only by their text. */
const OPS = `${ROOT}.ops`;
const READER = "agent-reader";

const history = reviewHistory();

// A hung-test bound, not a claim: these tests and their setup write and read whole review
// histories and 50 KB facts, about 1.5 s each on a quiet machine, and ran past vitest's 5 s test
// and 10 s hook defaults on a loaded one. Nothing here asserts on time.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe.skipIf(!QA_URL)("the task-start block serves the deciding review's substance, first", () => {
  let db: PrismaClient;
  let taskStartNotice: (typeof import("./task-start-notice"))["taskStartNotice"];
  let estimateTokens: (typeof import("./task-start-notice"))["estimateTokens"];
  let TASK_START_TOKEN_BUDGET: number;
  let TASK_START_MAX_TOKENS: number;
  let readTaskStartUnchecked: (typeof import("@/services/memory/task-start"))["readTaskStartUnchecked"];
  let seq = 0;
  let session = 0;

  async function cleanup(): Promise<void> {
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.convention.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  /**
   * Store `records` in `scopePath` as memory_ingest does: a fact version and its create event,
   * oldest first, a later part of one write at that write's instant.
   */
  async function write(
    records: (Omit<ReviewRecord, "task"> & { task?: string; role?: "decision" })[],
    scopePath: string,
  ): Promise<void> {
    const base = Date.UTC(2026, 9, 1);
    let instant = seq;
    const numbered = records.map((record) => {
      const n = ++seq;
      if (!record.sameWriteAsPrevious) instant = n;
      return { record, n, createdAt: new Date(base + instant * 1000) };
    });
    await db.memoryChunk.createMany({
      data: numbered.map(({ record, createdAt }) => ({
        id: record.id,
        orgId: ORG,
        content: record.content,
        entityName: record.entityName,
        role: record.role ?? null,
        scopePath,
        actorType: "agent",
        actorId: "importer",
        factVersion: true,
        createdAt,
      })),
    });
    await db.changeEvent.createMany({
      data: numbered.map(({ record, n, createdAt }) => ({
        orgId: ORG,
        seq: BigInt(n),
        scopePath,
        recordType: "fact",
        recordId: record.id,
        op: "create" as const,
        actorId: "importer",
        actorType: "agent",
        origin: "mcp",
        summary: record.content.split("\n", 1)[0]!.slice(0, 200),
        task: record.task ?? null,
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

  /** The block a fresh session of `task` is served in `scopePath`, or null. */
  async function blockFor(
    ctx: AccessContext,
    scopePath: string,
    task: string,
    taskKey: string | undefined = task,
  ): Promise<string | null> {
    return taskStartNotice(ctx, { scopePath, sessionKey: `session-${++session}`, taskText: task, taskKey });
  }

  /** Store a change event on its own, for a write whose fact text is stored elsewhere or not at all. */
  async function event(
    scopePath: string,
    recordId: string,
    summary: string,
    op: "create" | "supersede" = "create",
  ): Promise<void> {
    const n = ++seq;
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(n),
        scopePath,
        recordType: "fact",
        recordId,
        op,
        actorId: "importer",
        actorType: "agent",
        origin: "mcp",
        summary,
        createdAt: new Date(Date.UTC(2026, 9, 1) + n * 1000),
      },
    });
  }

  /** The block's served items, in order: its lines that show a record. */
  const itemsOf = (block: string) => block.split("\n").filter((line) => line.startsWith("- "));

  let reader: AccessContext;

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ taskStartNotice, estimateTokens, TASK_START_TOKEN_BUDGET, TASK_START_MAX_TOKENS } = await import(
      "./task-start-notice"
    ));
    ({ readTaskStartUnchecked } = await import("@/services/memory/task-start"));
    await cleanup();
    await db.org.create({ data: { id: ORG, name: ORG } });
    await write(history.records, REVIEWS);
    reader = await readerOn(REVIEWS);
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await cleanup();
    await db.$disconnect();
  });

  it("cuts every deciding review at a sentence naming the task's changed path, never at its header", async () => {
    const cutElsewhere: number[] = [];
    for (const { pr, task, decidingId } of history.tasks) {
      const line =
        itemsOf((await blockFor(reader, REVIEWS, task))!).find((item) => item.includes(`[fact ${decidingId}]`)) ?? "";
      const path = /app\/api\/\w+\/route\.ts/.exec(task)![0];
      if (!line.includes(path) || line.includes("wrote a comment (")) cutElsewhere.push(pr);
    }
    expect(cutElsewhere).toEqual([]);
  });

  it("serves the deciding review in the first three items, ahead of every progress note and the comments before it", async () => {
    const late: number[] = [];
    for (const { pr, task, decidingId } of history.tasks) {
      const at =
        itemsOf((await blockFor(reader, REVIEWS, task))!).findIndex((line) => line.includes(`[fact ${decidingId}]`)) +
        1;
      if (at < 1 || at > 3) late.push(pr);
    }
    expect(late).toEqual([]);
  });

  it("serves a review stored in parts on one line, naming its first part, its excerpt cut from any part and their shared header never", async () => {
    const split = history.tasks.filter((t) => t.decidingParts === 3);
    expect(split.length).toBeGreaterThan(5);
    for (const { task, decidingId } of split) {
      const line = itemsOf((await blockFor(reader, REVIEWS, task))!).find((item) =>
        item.includes(`[fact ${decidingId}]`),
      );
      expect(line).toContain(`[fact ${decidingId}] (+2 parts)`);
      // The first part holds only the verdict and filler; the task's words are in the later two.
      expect(line).toMatch(/The defect is in|add a test for/);
      expect(line).not.toContain("wrote a comment (");
    }
  });

  it("chooses the task's own records by its identity alone: other words for the same task reorder them, never add or drop one", async () => {
    const ownIds = async (taskText: string, taskKey: string) =>
      (await readTaskStartUnchecked(reader, REVIEWS, taskText, taskKey)).task.facts.map((fact) => fact.id).sort();
    for (const { task } of history.tasks) {
      const named = await ownIds(task, task);
      expect(named.length).toBeGreaterThan(0);
      for (const reworded of ["zz9 something else entirely", `${task} cursor defect page limit row`]) {
        expect(await ownIds(reworded, task)).toEqual(named);
      }
    }
  });

  describe("when comments follow the deciding review", () => {
    for (const after of ["nothing", "acknowledgement", "long automated review"] as const) {
      it(`serves it in the first three items, cut where the task's words are, with ${after} written after it`, async () => {
        const scope = `${ROOT}.after_${after.replace(/\W+/g, "_")}`;
        const followed = reviewHistory(20, 511, after);
        await write(
          followed.records.map((record) => ({ ...record, id: `${record.id}-${after}` })),
          scope,
        );
        const followedReader = await readerOn(scope);
        const cutElsewhere: number[] = [];
        const late: number[] = [];
        for (const { pr, task, decidingId } of followed.tasks) {
          const block = (await blockFor(followedReader, scope, task))!;
          const items = itemsOf(block);
          const at = items.findIndex((line) => line.includes(`[fact ${decidingId}-${after}]`)) + 1;
          if (at < 1 || at > 3) late.push(pr);
          // The review's defect or its closing instruction: either names the changed path.
          const path = /app\/api\/\w+\/route\.ts/.exec(task)![0];
          if (!(items[at - 1] ?? "").includes(path) || (items[at - 1] ?? "").includes("wrote a comment ("))
            cutElsewhere.push(pr);
          // The premise check shows no record, so it is added on top of the records' budget.
          expect(
            estimateTokens(withoutSources(block.replace(`\n${TASK_START_PREMISE_CHECK}`, ""))),
          ).toBeLessThanOrEqual(TASK_START_TOKEN_BUDGET);
          expect(estimateTokens(block)).toBeLessThanOrEqual(TASK_START_MAX_TOKENS);
        }
        expect({ cutElsewhere, late }).toEqual({ cutElsewhere: [], late: [] });
      });
    }
  });

  it("keeps every block within its token budget, saying how many records it left out", async () => {
    for (const { task } of history.tasks.slice(0, 5)) {
      const block = (await blockFor(reader, REVIEWS, task))!;
      // The premise check shows no record, so it is added on top of the records' budget.
      expect(estimateTokens(withoutSources(block.replace(`\n${TASK_START_PREMISE_CHECK}`, "")))).toBeLessThanOrEqual(
        TASK_START_TOKEN_BUDGET,
      );
      expect(estimateTokens(block)).toBeLessThanOrEqual(TASK_START_MAX_TOKENS);
      expect(block).toMatch(/\(\d+ more left out: ask memory_query for them\)$/);
    }
  });

  describe("when nothing is relevant", () => {
    beforeAll(async () => {
      if (QA_URL === undefined) return;
      await db.convention.createMany({
        data: Array.from({ length: 4 }, (_, i) => ({
          id: `handbook-rule-${i}`,
          orgId: ORG,
          scopePath: HANDBOOK,
          kind: "convention" as const,
          subject: `Handbook rule ${i}`,
          text: `${"Answer support tickets within one working day, and say who owns the reply. ".repeat(6)}Rule ${i}.`,
          actorId: "author",
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)),
        })),
      });
    });

    it("serves nothing to a task no record mentions, though its words sit inside words the records hold", async () => {
      // "voice" is inside every "invoices", and "ages" inside "pages": a substring is not a term.
      expect(await blockFor(reader, REVIEWS, "voice ages zz9")).toBeNull();
    });

    it("serves a scope's irrelevant rules exactly as it serves them to a session that names no task", async () => {
      const handbookReader = await readerOn(HANDBOOK);
      const unrelated = await blockFor(handbookReader, HANDBOOK, "refactor the invoices pagination cursor", undefined);
      const unnamed = await blockFor(handbookReader, HANDBOOK, "", undefined);
      expect(unrelated).not.toBeNull();
      expect(unrelated).toBe(unnamed);
      expect(itemsOf(unrelated!).every((line) => Array.from(line.split(": ").slice(1).join(": ")).length <= 300)).toBe(
        true,
      );
    });

    it("serves a write whose text is about the task, but not one whose text mentions one of its words in passing", async () => {
      // Neither names a task, and neither's first line, its summary, holds a word of this one.
      const note = (id: string, content: string) => ({ id, entityName: id, content });
      await write(
        [
          note(
            "ops-passing",
            `Weekly notes.\n${"Filler about the canteen menu. ".repeat(10)}The forklift was serviced.`,
          ),
          note(
            "ops-about",
            `Handover.\n${"Filler about the canteen menu. ".repeat(10)}The forklift rota for the north warehouse now has two drivers per shift.`,
          ),
        ],
        OPS,
      );
      const block = (await blockFor(await readerOn(OPS), OPS, "north warehouse forklift rota", undefined))!;
      expect(block).toContain("ops-about");
      expect(block).toContain("The forklift rota for the north warehouse now has two drivers per shift.");
      expect(block).not.toContain("ops-passing");
    });

    it("serves nothing more to a session already served", async () => {
      const [{ task }] = history.tasks;
      const sessionKey = `session-${++session}`;
      expect(
        await taskStartNotice(reader, { scopePath: REVIEWS, sessionKey, taskText: task!, taskKey: task }),
      ).not.toBeNull();
      expect(
        await taskStartNotice(reader, { scopePath: REVIEWS, sessionKey, taskText: task!, taskKey: task }),
      ).toBeNull();
    });
  });

  it("still serves a fact its writer declared decides the task ahead of a more relevant one that declared nothing", async () => {
    const task = "WEB-412 checkout retry";
    const fact = (id: string, content: string, role?: "decision") => ({ id, entityName: id, content, task, role });
    await write(
      [
        fact("checkout-decision", "Ship behind a flag, off by default.", "decision"),
        fact("checkout-note", "WEB-412: the checkout retry fires twice when the gateway times out."),
      ],
      CHECKOUT,
    );
    const block = (await blockFor(await readerOn(CHECKOUT), CHECKOUT, task))!;
    expect(itemsOf(block).map((line) => line.match(/\[fact (\S+)\]/)?.[1])).toEqual([
      "checkout-decision",
      "checkout-note",
    ]);
  });

  describe("which recent writes the read considers", () => {
    const note = (id: string, content: string) => ({ id, entityName: id, content });

    it("serves an older write on the task though forty newer writes hold its words only inside other words", async () => {
      const scope = `${ROOT}.depot`;
      // Found by its text alone, as the newer writes would be by a substring.
      await write([note("depot-early", "Depot note.\nFORKLIFT ROTA: two drivers per shift.")], scope);
      await write(
        Array.from({ length: 40 }, (_, k) =>
          note(`depot-near-${k}`, `Stock note ${k}.\nStock rotation for forklifts, batch ${k}.`),
        ),
        scope,
      );
      const block = (await blockFor(await readerOn(scope), scope, "forklift rota", undefined))!;
      expect(itemsOf(block).map((line) => line.match(/^- create fact (\S+)/)?.[1])).toEqual(["depot-early"]);
    });

    it("serves an older write whose summary is on the task though forty newer writes mention one of its words deep in their text", async () => {
      const scope = `${ROOT}.yard`;
      await write([note("yard-rota", "Yard rota posted for the week.")], scope);
      await write(
        Array.from({ length: 40 }, (_, k) =>
          note(`flood-${k}`, `Weekly notes ${k}.\n${"Filler about the canteen menu. ".repeat(5)}The rota came up.`),
        ),
        scope,
      );
      const block = (await blockFor(await readerOn(scope), scope, "yard rota", undefined))!;
      expect(itemsOf(block).map((line) => line.match(/^- create fact (\S+)/)?.[1])).toEqual(["yard-rota"]);
    });

    it("matches a write's text only on the part the block could serve, its first 4,000 characters", async () => {
      const scope = `${ROOT}.archive`;
      const deep = (k: number) =>
        `Archive note ${k}.\n${"Filler about the canteen menu. ".repeat(140)}The loading dock rota for the north yard.`;
      await write(
        [note("archive-early", "Archive note.\nThe loading dock rota for the north yard: two shifts.")],
        scope,
      );
      // Newer, and about the task only past character 4,000, which the block never serves.
      await write(
        Array.from({ length: 40 }, (_, k) => note(`archive-deep-${k}`, deep(k))),
        scope,
      );
      const block = (await blockFor(await readerOn(scope), scope, "loading dock rota north", undefined))!;
      expect(itemsOf(block).map((line) => line.match(/^- create fact (\S+)/)?.[1])).toEqual(["archive-early"]);
    });

    it("looks past the scope's 200 newest writes, to its 500 newest, only for a summary about the task", async () => {
      const scope = `${ROOT}.ledger`;
      await write(
        [
          note("ledger-by-summary", "Pallet rota for bay nine."),
          note("ledger-by-text", "Ledger entry.\nPallet rota for bay nine, again."),
          note("ledger-in-passing", "Pallet count done."),
        ],
        scope,
      );
      await write(
        Array.from({ length: 200 }, (_, k) => note(`ledger-other-${k}`, `Canteen menu ${k}.`)),
        scope,
      );
      const block = (await blockFor(await readerOn(scope), scope, "pallet rota bay nine", undefined))!;
      expect(itemsOf(block).map((line) => line.match(/^- create fact (\S+)/)?.[1])).toEqual(["ledger-by-summary"]);
    });

    it("serves a write that shares one word of a longer task by its summary line, not by its text", async () => {
      const scope = `${ROOT}.finance`;
      const text = `The ledger export moved to Fridays.\n${"Filler about the canteen menu. ".repeat(20)}`;
      await write([note("finance-weak", text)], scope);
      const block = (await blockFor(
        await readerOn(scope),
        scope,
        "quarterly invoice reconciliation for the finance ledger",
        undefined,
      ))!;
      expect(itemsOf(block).map(withoutSources)).toEqual([
        "- create fact finance-weak by importer: The ledger export moved to Fridays.",
      ]);
    });

    it("reads back a recent write on the task before older passing mentions the ranking would not serve", async () => {
      const scope = `${ROOT}.dock`;
      await write(
        Array.from({ length: 40 }, (_, k) => note(`passing-${k}`, `Rota note ${k}.`)),
        scope,
      );
      await write(
        Array.from({ length: 199 }, (_, k) => note(`canteen-${k}`, `Canteen menu ${k}.`)),
        scope,
      );
      await write([note("handover-recent", "Handover.\nThe north yard dock rota now has two drivers.")], scope);
      const block = (await blockFor(await readerOn(scope), scope, "north yard dock rota", undefined))!;
      expect(itemsOf(block).map((line) => line.match(/^- create fact (\S+)/)?.[1])).toEqual(["handover-recent"]);
    });

    it("never joins a write to fact text stored outside the scope being read", async () => {
      const scope = `${ROOT}.depot2`;
      await event(scope, "cross-scope-fact", "Moved a record");
      await db.memoryChunk.create({
        data: {
          id: "cross-scope-fact",
          orgId: ORG,
          content: "VAULT-ONLY: the forklift rota for the vault.",
          entityName: "vault",
          scopePath: `${ROOT}.vault`,
          factVersion: true,
        },
      });
      const block = await blockFor(await readerOn(scope), scope, "vault forklift rota", undefined);
      expect(block ?? "").not.toContain("VAULT-ONLY");
      expect(block).toBeNull();
    });

    it("reads a fact's text only for the write that created it, not for the supersede that retired it", async () => {
      const scope = `${ROOT}.gate`;
      await write([note("gate-lost", "LOSING-TEXT: east gate rota, Mondays.")], scope);
      await db.factEdge.create({
        data: {
          orgId: ORG,
          fromId: "gate-won",
          toId: "gate-lost",
          kind: "supersedes",
          scopePath: scope,
          actorType: "agent",
          actorId: "importer",
        },
      });
      await event(scope, "gate-lost", "East gate rota superseded", "supersede");
      const { context } = await readTaskStartUnchecked(await readerOn(scope), scope, "east gate rota");
      const supersede = context.writes.find((write) => write.op === "supersede");
      expect(supersede).toBeDefined();
      expect(supersede!.content).toBeUndefined();
    });
  });

  it("reads only the first 4,000 characters of a large fact, whether or not the org has erased anyone", async () => {
    const scope = `${ROOT}.big`;
    const task = "BIG-7 dock rota";
    const content = `Dock rota for BIG-7: two shifts.\n${"Filler about the canteen menu. ".repeat(1_700)}`;
    await write([{ id: "big-fact", entityName: "big", content, task }], scope);
    const { db: appDb } = await import("@/lib/db");
    const shipped = async () => {
      const spy = vi.spyOn(appDb, "$queryRaw");
      try {
        await readTaskStartUnchecked(await readerOn(scope), scope, task, task);
        const [row] = (await spy.mock.results[0]!.value) as {
          taskFacts: { content: string }[];
          writes: { factContent: string | null }[];
        }[];
        return { fact: row!.taskFacts[0]!.content.length, write: row!.writes[0]!.factContent!.length };
      } finally {
        spy.mockRestore();
      }
    };
    expect(content.length).toBeGreaterThan(50_000);
    expect(await shipped()).toEqual({ fact: 4000, write: 4000 });
    const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
    await recordSuppressions(db, ORG, "qa-request", { emails: [], names: ["nobody in this history"], contactIds: [] });
    expect(await shipped()).toEqual({ fact: 4000, write: 4000 });
  });

  describe("in an org that has erased someone", () => {
    const NAME = "Orla Brennick";
    const scope = `${ROOT}.erased_big`;
    const task = "DOCK-12 north yard dock rota";
    // About 50 KB of varied text, so each fact is stored compressed and costs real work to read whole.
    const bulk = (k: number) =>
      Array.from(
        { length: 1_400 },
        (_, i) => `Shift ${k}-${i} logged pallet ${(k * 7919 + i * 104_729) % 99_991} at bay ${i % 37}.`,
      ).join(" ");
    let readerHere: AccessContext;

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      await write(
        [
          ...Array.from({ length: 20 }, (_, k) => ({
            id: `big-task-${k}`,
            entityName: `dock note ${k}`,
            content: `Dock rota note ${k}.\n${bulk(k)}`,
            task,
          })),
          ...Array.from({ length: 30 }, (_, k) => ({
            id: `big-write-${k}`,
            entityName: `yard note ${k}`,
            content: `North yard dock rota, entry ${k}.\n${bulk(100 + k)}`,
          })),
          {
            id: "erased-newest",
            entityName: "yard note erased",
            content: `North yard dock rota, entry from ${NAME}.\n${bulk(999)}`,
          },
          // The task's three newest facts, each naming the person only deep in its text: more
          // than one block shows at once, so a replacement must be checked in its turn too.
          ...[0, 1, 2].map((k) => ({
            id: `erased-task-${k}`,
            entityName: `dock note erased ${k}`,
            content: `Dock rota note, erased copy ${k}.\n${bulk(990 + k)} Signed off by ${NAME}.`,
            task,
          })),
        ],
        scope,
      );
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db, ORG, "qa-erasure", { emails: [], names: [NAME.toLowerCase()], contactIds: [] });
      readerHere = await readerOn(scope);
    });

    it("checks only what the block serves, so large facts written before the erasure stay cheap", async () => {
      const { db: appDb } = await import("@/lib/db");
      await blockFor(readerHere, scope, task);
      // A newer suppression entry, naming nobody here, so no remembered verdict applies and
      // the call below checks from cold.
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db, ORG, "qa-cold", { emails: [], names: ["Nobody Anywhere"], contactIds: [] });
      const spy = vi.spyOn(appDb, "$queryRaw");
      try {
        const block = (await blockFor(readerHere, scope, task))!;
        // The whole texts read for the check: one row per fact version checked.
        const wholeTextReads = await Promise.all(
          spy.mock.calls
            .map((call, i) => ({ sql: (call[0] as unknown as string[]).join("?"), result: spy.mock.results[i]!.value }))
            .filter(({ sql }) => sql.includes('FROM "memory_chunks"') && sql.includes('AND "id" = ANY (')),
        );
        const checked = (await Promise.all(wholeTextReads.map(({ result }) => result as Promise<unknown[]>))).flat()
          .length;
        // 54 candidates are due the check; the block shows a few, and three erased ones are replaced.
        const wholeTextsAllowed = itemsOf(block).length + 3;
        // Every candidate here is due the check, so each fact the block shows was read whole: a
        // count of zero would mean the check never ran, not that it was cheap.
        expect(checked).toBeGreaterThanOrEqual(itemsOf(block).length);
        expect(checked).toBeLessThanOrEqual(wholeTextsAllowed);
        // The work, counted rather than timed (reading and checking all 54 whole took 1.7 s on a
        // quiet machine, and a clock bound fails under load): everything the call's statements
        // returned is at most the whole texts it may check plus a served head of each candidate,
        // and it checks in batches, not one statement per fact.
        const [{ candidates, longest }] = await db.$queryRaw<{ candidates: number; longest: number }[]>`
          SELECT count(*)::int AS "candidates", max(length("content"))::int AS "longest"
          FROM "memory_chunks" WHERE "orgId" = ${ORG} AND "scopePath" = ${scope}`;
        const returned = (await Promise.all(spy.mock.results.map(({ value }) => value as Promise<unknown>))).reduce(
          (sum: number, rows) => sum + charactersIn(rows),
          0,
        );
        expect(candidates).toBe(54);
        expect(returned).toBeLessThanOrEqual(wholeTextsAllowed * longest + candidates * SERVED_HEAD_WITH_FIELDS);
        expect(spy.mock.calls.length).toBeLessThan(checked);
      } finally {
        spy.mockRestore();
      }
    });

    it("never serves a task fact naming the erased person, even past what the block shows, and serves the next one in its place", async () => {
      const block = (await blockFor(readerHere, scope, task))!;
      expect(block).not.toContain("erased-task-");
      expect(itemsOf(block)[0]).toContain("[fact big-task-19]");
    });

    it("never serves a write naming the erased person, and serves the next one in its place", async () => {
      const block = (await blockFor(readerHere, scope, "north yard dock rota", undefined))!;
      expect(block).not.toContain(NAME);
      expect(block).not.toContain("erased-newest");
      expect(itemsOf(block)[0]).toContain("big-write-29");
    });
  });

  describe("the erased-person verdicts it remembers", () => {
    // One fact in each scope, so each block shows exactly one fact due the check.
    const scopeA = `${ROOT}.verdicts_a`;
    const scopeB = `${ROOT}.verdicts_b`;
    const scopeC = `${ROOT}.verdicts_c`;
    const restored = "Cara Lindqvist";
    const later = "Brann Okafor";
    const text = (k: number, tail = "") =>
      `Gate rota note ${k}.\n${"Shift logged at the east gate. ".repeat(60)}${tail}`;
    const readers = new Map<string, AccessContext>();

    /** The whole texts the next block in `scope` reads for the check: one row per fact version checked. */
    async function checkedOnNextBlock(
      scope: string,
      taskName: string,
    ): Promise<{ checked: number; block: string | null }> {
      const { db: appDb } = await import("@/lib/db");
      const spy = vi.spyOn(appDb, "$queryRaw");
      try {
        const block = await blockFor(readers.get(scope)!, scope, taskName);
        const reads = spy.mock.calls
          .map((call, i) => ({ sql: (call[0] as unknown as string[]).join("?"), result: spy.mock.results[i]!.value }))
          .filter(({ sql }) => sql.includes('FROM "memory_chunks"') && sql.includes('AND "id" = ANY ('));
        const checked = (await Promise.all(reads.map(({ result }) => result as Promise<unknown[]>))).flat().length;
        return { checked, block };
      } finally {
        spy.mockRestore();
      }
    }

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      await write([{ id: "gate-a", entityName: "gate a", content: text(1), task: "GATE-1 east gate rota" }], scopeA);
      // Names someone who is erased only later in this test, deep in its text.
      await write(
        [
          {
            id: "gate-b",
            entityName: "gate b",
            content: text(2, `Signed off by ${later}.`),
            task: "GATE-2 east gate rota",
          },
        ],
        scopeB,
      );
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db, ORG, "qa-first", { emails: [], names: ["Somebody Else"], contactIds: [] });
      await write(
        [
          {
            id: "gate-c",
            entityName: "gate c",
            content: text(3, `Handed over by ${restored}.`),
            task: "GATE-3 east gate rota",
          },
        ],
        scopeC,
      );
      for (const scope of [scopeA, scopeB, scopeC]) readers.set(scope, await readerOn(scope));
    });

    it("reads a fact whole once, and not again while no newer erasure is recorded", async () => {
      expect((await checkedOnNextBlock(scopeA, "GATE-1 east gate rota")).checked).toBe(1);
      expect((await checkedOnNextBlock(scopeA, "GATE-1 east gate rota")).checked).toBe(0);
    });

    it("keeps each fact version's verdict its own: another fact is still read and checked", async () => {
      const { checked, block } = await checkedOnNextBlock(scopeB, "GATE-2 east gate rota");
      expect(checked).toBe(1);
      expect(block).toContain("[fact gate-b]");
    });

    it("forgets every verdict when the suppression list gains an entry dated before its newest, as a restore can add", async () => {
      expect((await checkedOnNextBlock(scopeC, "GATE-3 east gate rota")).block).toContain("[fact gate-c]");
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      const newest = await db.erasureSuppression.aggregate({ where: { orgId: ORG }, _max: { createdAt: true } });
      await recordSuppressions(db, ORG, "qa-restored", { emails: [], names: [restored], contactIds: [] });
      // Dated after the fact was written, but before the list's newest entry.
      await db.erasureSuppression.updateMany({
        where: { orgId: ORG, requestId: "qa-restored" },
        data: { createdAt: new Date(newest._max.createdAt!.getTime() - 1000) },
      });
      const { checked, block } = await checkedOnNextBlock(scopeC, "GATE-3 east gate rota");
      expect(checked).toBe(1);
      expect(block ?? "").not.toContain("[fact gate-c]");
    });

    it("forgets every verdict when a newer erasure is recorded, so a fact naming the newly erased person is withheld", async () => {
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db, ORG, "qa-second", { emails: [], names: [later], contactIds: [] });
      const { checked, block } = await checkedOnNextBlock(scopeB, "GATE-2 east gate rota");
      expect(checked).toBe(1);
      expect(block ?? "").not.toContain("[fact gate-b]");
      expect(block ?? "").not.toContain(later);
      // Remembered as withheld: the next block neither reads it again nor serves it.
      const again = await checkedOnNextBlock(scopeB, "GATE-2 east gate rota");
      expect(again.checked).toBe(0);
      expect(again.block ?? "").not.toContain("[fact gate-b]");
    });
  });

  describe("a task write stored in parts, one of which names an erased person", () => {
    const NAME = "Ines Varga";
    const scope = `${ROOT}.erased_parts`;
    const task = "BERTH-7 crane lock review";
    let readerHere: AccessContext;

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      await write(
        [
          {
            id: "berth-older",
            entityName: "berth review older",
            content: "Berth review: the crane lock was inspected last week.",
            task,
          },
          {
            id: "berth-head",
            entityName: "berth review",
            content: "Berth review, part one: the crane lock check is missing.",
            task,
          },
          {
            id: "berth-part-2",
            entityName: "berth review",
            content: "Part two: add a test for the lock timeout.",
            task,
            sameWriteAsPrevious: true,
          },
          {
            id: "berth-part-3",
            entityName: "berth review",
            content: `Part three: signed off by ${NAME}.`,
            task,
            sameWriteAsPrevious: true,
          },
        ],
        scope,
      );
      const { recordSuppressions } = await import("@/services/memory/erasure-suppression");
      await recordSuppressions(db, ORG, "qa-parts", { emails: [], names: [NAME.toLowerCase()], contactIds: [] });
      readerHere = await readerOn(scope);
    });

    it("checks every part a line shows, so the part naming the person is withheld and the rest of the write is still served", async () => {
      const block = (await blockFor(readerHere, scope, task))!;
      expect(block).not.toContain(NAME);
      expect(block).not.toContain("Part three");
      const [first] = itemsOf(block);
      expect(first).toContain("[fact berth-head] (+1 parts)");
      expect(first).toContain("add a test for the lock timeout");
    });
  });

  describe("access control", () => {
    const [{ pr, task, decidingId }] = history.tasks;
    const record = (id: string): ReviewRecord => ({
      id,
      entityName: `acme/storefront pull request #${pr}`,
      task: task!,
      // The task's newest writes, on its subject in a reviewer's own words (a write quoting the
      // task's text is served last, services/memory/task-start.ts), and a marker that must never be served.
      content: `UNREADABLE-${id}: ${task!.split(" in ").at(-1)} still reads the pagination cursor after the limit; the fix in this pull request is wrong.`,
    });
    const forbidden = [record("sibling-scope-review"), record("parent-scope-review")];

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      await write([forbidden[0]!], REVIEWS_SIBLING);
      await write([forbidden[1]!], ROOT);
    });

    it("never serves a record from a scope the reader may not read, however relevant, under the same task", async () => {
      const block = (await blockFor(reader, REVIEWS, task!))!;
      expect(block).not.toContain("UNREADABLE");
      expect(block).not.toContain("sibling-scope-review");
      expect(block).not.toContain("parent-scope-review");
      expect(
        itemsOf(block)
          .slice(0, 3)
          .some((line) => line.includes(`[fact ${decidingId}]`)),
      ).toBe(true);
    });

    it("serves those records first to a reader who may read their scopes, so the refusal above is the scope's doing", async () => {
      const block = (await blockFor(await readerOn(ROOT), ROOT, task!))!;
      expect(itemsOf(block).some((line) => /\[fact (sibling|parent)-scope-review\]/.test(line))).toBe(true);
    });
  });
});
