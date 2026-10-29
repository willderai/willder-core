// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// What the task-start block costs, against a real database. Wall-clock time is too noisy to assert on, so these tests pin the shape of
// the work instead: how many statements the block sends, and how many it has in
// flight at once. Each statement is a network round trip in production, and each
// statement in flight beside another needs its own pooled connection, which a cold
// serverless instance has to open first. The block is held to one connection.
//
// The reads were folded into one statement for that reason, and the first test here
// proves the fold changed nothing about what is served: it compares the reader with
// the three separate queries it replaced, row for row, on a seeded scope tree.
//
// Set QA_DATABASE_URL to an ISOLATED test database, never the inherited DATABASE_URL,
// which may point at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
// Leaf modules, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { TaskStartContext } from "@/services/memory/task-start";
// Pure, so importing it builds no database client.
import {
  holdsATaskTerm,
  isAboutTheTask,
  namesIn,
  rankByRelevance,
  rankedText,
  termCountsOf,
  termsOf,
  weighTaskTerms,
} from "@/services/memory/relevance";
import { citedNames, orderRules } from "@/services/memory/rule-order";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-task-start-latency";
const OTHER_ORG = "org-qa-task-start-latency-other";
const ROOT = "org_1";
const AGENT = "agent-latency";

/** Every statement the pg driver sends, and the most it had in flight at once. */
const wire = { statements: 0, inFlight: 0, maxInFlight: 0 };
function resetWire(): void {
  wire.statements = 0;
  wire.maxInFlight = 0;
}

describe.skipIf(!QA_URL)("task-start block cost, against a real database", () => {
  let db: PrismaClient;
  let readTaskStartUnchecked: (typeof import("@/services/memory/task-start"))["readTaskStartUnchecked"];
  /** What the folded statement reads for the scope's rules, writes and stale flags. */
  const readTaskStartContext = async (context: AccessContext, scopePath: string, taskText: string) =>
    (await readTaskStartUnchecked(context, scopePath, taskText)).context;
  let taskStartNotice: (typeof import("./task-start-notice"))["taskStartNotice"];
  let renderTaskStartBlock: (typeof import("./task-start-notice"))["renderTaskStartBlock"];
  let POST: (typeof import("@/app/api/mcp/route"))["POST"];
  let token: string;
  const originalQuery = pg.Client.prototype.query;

  const ctx = (): AccessContext => ({
    orgId: ORG,
    actor: { type: "agent", id: AGENT, capabilityToken: token },
    origin: "mcp",
  });

  /**
   * The reader as three separate queries, ranked in memory: the oracle the folded
   * statement is held to. No fact versions are stored in this seed, so no write carries
   * text, and a write matches the task by its record id and summary alone.
   */
  async function referenceContext(scopePath: string, taskText: string): Promise<TaskStartContext> {
    const terms = [...termsOf(taskText)];
    const named = [...namesIn(taskText)];
    const [pool, recent, stale] = await Promise.all([
      // The rules the task names, however old, then the newest, to 100; served newest first.
      db.$queryRaw<(TaskStartContext["rules"][number] & { createdAt: Date; actorId?: string })[]>`
        SELECT c."id", c."kind", c."subject", c."text", c."createdAt", c."actorId",
               -- Who recorded the rule, as its first create event says; "unknown" when none does.
               COALESCE((SELECT CASE e."actorType" WHEN 'human' THEN 'person' WHEN 'agent' THEN 'agent' ELSE 'unknown' END
                         FROM "change_events" e
                         WHERE e."orgId" = ${ORG} AND e."recordType" = 'convention' AND e."recordId" = c."id" AND e."op" = 'create'
                         ORDER BY e."seq" LIMIT 1), 'unknown') AS "by",
               to_char(c."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "writtenAt"
        FROM "conventions" c
        WHERE c."orgId" = ${ORG} AND c."scopePath"::ltree <@ ${scopePath}::ltree
          AND c."supersededById" IS NULL AND c."retiredAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "conventions" r WHERE r."supersedesId" = c."id")
        ORDER BY (lower(c."id") = ANY (${named}::text[]) OR lower(btrim(c."subject")) = ANY (${named}::text[])) DESC,
                 c."createdAt" DESC, c."id" COLLATE "C" DESC
        LIMIT 100`,
      db.$queryRaw<TaskStartContext["writes"]>`
        SELECT "id", "recordType", "recordId", "op", "actorId", "summary",
               to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "writtenAt"
        FROM "change_events"
        WHERE "orgId" = ${ORG} AND "recordType" <> 'convention' AND "scopePath"::ltree <@ ${scopePath}::ltree
        ORDER BY "seq" DESC LIMIT ${terms.length === 0 ? 3 : 500}`,
      db.$queryRaw<TaskStartContext["stale"]>`
        SELECT "id", "scopePath", "graphitiFactUuid", "sourceType"::text AS "sourceType", "sourceRef", "flaggedAt"
        FROM "fact_provenance"
        WHERE "orgId" = ${ORG} AND "status" = 'potentially_stale' AND "scopePath"::ltree <@ ${scopePath}::ltree
        ORDER BY "flaggedAt" DESC LIMIT 3`,
    ]);
    // Newest first, then id in descending byte order, as the read breaks ties.
    const rules = pool
      .sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
      )
      // Named as the block names a rule's recorder: an agent by its id, a person as "person".
      .map(({ createdAt: _createdAt, ...rule }) => ({
        ...rule,
        writtenBy: rule.by === "agent" ? rule.actorId! : rule.by === "person" ? "person" : "unknown",
      }))
      .map(({ actorId: _actorId, ...rule }) => rule);
    const label = (write: TaskStartContext["writes"][number]) => `${write.recordId} ${write.summary}`;
    // A term matches whole, not inside a longer word.
    const holdsWhole = (text: string, term: string) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(
        text.toLowerCase(),
      );
    const writes =
      terms.length === 0
        ? recent
        : recent.filter((write) => terms.some((term) => holdsWhole(label(write), term))).slice(0, 30);
    const rankedRules = rules.map((rule) => {
      const text = rankedText(rule.text);
      return { item: { ...rule, text }, terms: termCountsOf(`${rule.subject} ${text}`) };
    });
    const rankedWrites = writes.map((write) => ({ item: write, terms: termCountsOf(label(write)) }));
    const weights = weighTaskTerms(
      taskText,
      [...rankedRules, ...rankedWrites].map(({ terms }) => terms),
    );
    return {
      rules: orderRules(rankedRules, weights, citedNames([taskText])),
      writes:
        terms.length === 0
          ? writes
          : rankByRelevance(
              // A passing mention is served from the 200 newest; an older write only when it is about the task.
              rankedWrites.filter(
                ({ item, terms }) =>
                  isAboutTheTask(weights, terms) || (recent.indexOf(item) < 200 && holdsATaskTerm(weights, terms)),
              ),
              weights,
              ({ terms }) => terms,
            ).map(({ item }) => item),
      stale,
      weights,
    };
  }

  /** A scope tree with rules, writes and stale flags at every level, plus noise that must never be served. */
  async function seed(): Promise<void> {
    const base = Date.UTC(2026, 9, 1);
    const at = (minutes: number) => new Date(base + minutes * 60_000);
    const scopes = [
      ROOT,
      `${ROOT}.sales`,
      `${ROOT}.sales.emea`,
      `${ROOT}.sales.emea.deals`,
      `${ROOT}.sales_eu`,
      `${ROOT}.eng`,
    ];
    const rules: Prisma.ConventionCreateManyInput[] = [];
    for (let i = 0; i < 180; i++) {
      rules.push({
        id: `rule-${i}`,
        orgId: i % 17 === 0 ? OTHER_ORG : ORG,
        scopePath: scopes[i % scopes.length]!,
        kind: i % 3 === 0 ? "decision" : "convention",
        subject: `Rule ${i} ${i % 4 === 0 ? "deploy review" : "pricing"}`,
        text: `Rule ${i}: ${i % 5 === 0 ? "run the migration check before a deploy" : "quote in the customer's currency"}.`,
        actorId: "author",
        createdAt: at(i),
        retiredAt: i % 11 === 0 ? at(500) : null,
      });
    }
    await db.convention.createMany({ data: rules });
    // Replace every seventh in-force rule; the replaced one must drop out.
    for (const old of rules.filter((r, i) => i % 7 === 0 && r.orgId === ORG && !r.retiredAt)) {
      await db.convention.create({
        data: { ...old, id: `${old.id}-v2`, text: `${old.text} (v2)`, supersedesId: old.id, createdAt: at(600) },
      });
      await db.convention.update({ where: { id: old.id }, data: { supersededById: `${old.id}-v2` } });
    }
    await db.changeEvent.createMany({
      data: Array.from({ length: 400 }, (_, i) => ({
        orgId: i % 13 === 0 ? OTHER_ORG : ORG,
        seq: BigInt(i + 1),
        scopePath: scopes[i % scopes.length]!,
        recordType: i % 9 === 0 ? "convention" : "fact",
        recordId: `fact-${i}`,
        op: i % 4 === 0 ? ("update" as const) : ("create" as const),
        actorId: `agent-${i % 5}`,
        summary: `Deploy note ${i} for release${i % 20} run state`,
        createdAt: at(i),
      })),
    });
    await db.factProvenance.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        orgId: i % 13 === 0 ? OTHER_ORG : ORG,
        scopePath: scopes[i % scopes.length]!,
        graphitiFactUuid: `uuid-${i}`,
        sourceType: "file" as const,
        sourceRef: `repo/file-${i}`,
        ownerId: "owner",
        status: i % 3 === 0 ? ("potentially_stale" as const) : ("fresh" as const),
        flaggedAt: i % 3 === 0 ? new Date(base + i * 1234) : null,
      })),
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ readTaskStartUnchecked } = await import("@/services/memory/task-start"));
    ({ taskStartNotice, renderTaskStartBlock } = await import("./task-start-notice"));
    ({ POST } = await import("@/app/api/mcp/route"));

    // Counts every statement the app's driver sends. pg.Pool runs each query on a
    // pg.Client, so this sees pooled queries and transactions alike.
    pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
      wire.statements++;
      wire.inFlight++;
      wire.maxInFlight = Math.max(wire.maxInFlight, wire.inFlight);
      const result = (originalQuery as (...a: unknown[]) => unknown).apply(this, args);
      if (result instanceof Promise) {
        return result.finally(() => {
          wire.inFlight--;
        });
      }
      wire.inFlight--;
      return result;
    } as typeof pg.Client.prototype.query;
  });

  afterAll(async () => {
    pg.Client.prototype.query = originalQuery;
    await db.$disconnect();
  });

  beforeEach(async () => {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.convention.deleteMany({ where: { orgId, supersedesId: { not: null } } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.factProvenance.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
    }
    token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        tokenHash: hashCapabilityToken(token),
        scopePath: ROOT,
        permission: "read",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await seed();
  });

  it("serves exactly what the three separate queries served, for every scope and task", async () => {
    const scopes = [
      ROOT,
      `${ROOT}.sales`,
      `${ROOT}.sales.emea`,
      `${ROOT}.sales.emea.deals`,
      `${ROOT}.eng`,
      `${ROOT}.none`,
    ];
    const tasks = ["", "deploy review", "release7 run state", "fact-42", "nothing in common zzz"];
    let compared = 0;
    for (const scope of scopes) {
      for (const task of tasks) {
        const expected = await referenceContext(scope, task);
        const actual = await readTaskStartContext(ctx(), scope, task);
        expect(actual, `${scope} / "${task}"`).toEqual(expected);
        expect(renderTaskStartBlock(actual)).toEqual(renderTaskStartBlock(expected));
        compared++;
      }
    }
    expect(compared).toBe(30);
    // The comparison is only worth something if the seed produced all three sections.
    const full = await readTaskStartContext(ctx(), ROOT, "deploy review release7");
    expect(full.rules.length).toBeGreaterThan(50);
    expect(full.writes.length).toBeGreaterThan(10);
    expect(full.stale).toHaveLength(3);
  });

  it("serves awkward text, every cut boundary and the stored timestamps exactly as the separate queries did", async () => {
    const edge = `${ROOT}.edge`;
    const at = (ms: number) => new Date(Date.UTC(2027, 0, 1) + ms);
    // Text JSON has to escape, or that a codec could mangle: quotes, backslashes, line
    // and paragraph separators, a control character, astral and combining characters,
    // right-to-left script, and one rule far past the rendered cut.
    const awkward = [
      `quote " and backslash \\ and \\u0041 spelled out`,
      "line\nbreak\ttab\r\nCRLF     \u0001 end",
      "emoji 🧪🚀, CJK 規則, RTL قاعدة, combining é vs é",
      "x".repeat(20_000),
      `{"json":"looking",[1,2]}`,
    ];
    // One more in-force rule than the candidate cut, on distinct instants, so the cut
    // decides which rule is left out.
    await db.convention.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        id: `edge-rule-${i}`,
        orgId: ORG,
        scopePath: edge,
        kind: i % 2 === 0 ? ("decision" as const) : ("convention" as const),
        subject: `Edge ${i} ${awkward[i % awkward.length]!.slice(0, 40)}`,
        text: awkward[i % awkward.length]!,
        actorId: "author",
        createdAt: at(i),
      })),
    });
    // One more write than the candidate cut, the same way. The oldest, past the cut, and
    // the next, inside it, each hold a word no other write holds.
    const only = (i: number) => (i === 0 ? " edgeoldest" : i === 1 ? " edgesecond" : "");
    await db.changeEvent.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        orgId: ORG,
        seq: BigInt(10_000 + i),
        scopePath: edge,
        recordType: "fact",
        recordId: `edge-fact-${i}`,
        op: "create" as const,
        actorId: `agent "${i}"`,
        summary: `edge ${awkward[i % awkward.length]!.slice(0, 170)}${only(i)}`,
        createdAt: at(i),
      })),
    });
    // Stale flags at the edges of the millisecond the column keeps, one more than served.
    await db.factProvenance.createMany({
      data: [0, 999, 1, 998].map((ms, i) => ({
        orgId: ORG,
        scopePath: edge,
        graphitiFactUuid: `edge-uuid-${i}`,
        sourceType: "file" as const,
        sourceRef: `repo/${awkward[i]!.slice(0, 60)}`,
        ownerId: "owner",
        status: "potentially_stale" as const,
        flaggedAt: at(i * 1000 + ms),
      })),
    });

    for (const task of ["", "edge", "emoji", "edge-fact-7 quote", "edgeoldest", "edgesecond"]) {
      const expected = await referenceContext(edge, task);
      const actual = await readTaskStartContext(ctx(), edge, task);
      expect(actual, `"${task}"`).toEqual(expected);
      expect(renderTaskStartBlock(actual)).toEqual(renderTaskStartBlock(expected));
      for (const flag of actual.stale) expect(flag.flaggedAt).toBeInstanceOf(Date);
    }
    const all = await readTaskStartContext(ctx(), edge, "edge");
    expect(all.rules).toHaveLength(100);
    expect(all.rules.some((r) => r.id === "edge-rule-0")).toBe(false);
    // Among the 500 newest writes, the 30 newest that match are served.
    expect(all.writes).toHaveLength(30);
    expect(all.writes.at(-1)!.recordId).toBe("edge-fact-471");
    expect((await readTaskStartContext(ctx(), edge, "edgeoldest")).writes).toEqual([]);
    expect((await readTaskStartContext(ctx(), edge, "edgesecond")).writes.map((w) => w.recordId)).toEqual([
      "edge-fact-1",
    ]);
    expect(all.stale.map((f) => f.flaggedAt.toISOString())).toEqual([
      at(3998).toISOString(),
      at(2001).toISOString(),
      at(1999).toISOString(),
    ]);
  });

  it("passes a stale flag with no flaggedAt through as the separate query did, not as 1970", async () => {
    // The app always sets flaggedAt when it flags a row, but the column is nullable and
    // nothing in the database enforces the pair. The reader must not invent an instant.
    const scope = `${ROOT}.unflagged`;
    await db.factProvenance.create({
      data: {
        orgId: ORG,
        scopePath: scope,
        graphitiFactUuid: "uuid-unflagged",
        sourceType: "file",
        sourceRef: "repo/unflagged",
        ownerId: "owner",
        status: "potentially_stale",
        flaggedAt: null,
      },
    });
    expect(await readTaskStartContext(ctx(), scope, "")).toEqual(await referenceContext(scope, ""));
  });

  // Budgets, not exact counts: each statement is a round trip, so one more fails and
  // one fewer is an improvement. A first call needs five: the session check, the one
  // folded read, check()'s decision and its audit row, and the delivery claim. A
  // session already served needs only the session check. "One connection" is the
  // claim itself, so the in-flight count stays exact.
  const FIRST_CALL_STATEMENTS = 5;
  const SERVED_SESSION_STATEMENTS = 1;
  const OVER_BUDGET =
    "The task-start block sent more statements than its budget. Fold the new query into the one read in services/memory/task-start.ts, or raise the budget here and say why";

  it("delivers a block in at most five statements on one connection, and skips a served session in at most one", async () => {
    resetWire();
    const block = await taskStartNotice(ctx(), { scopePath: ROOT, sessionKey: "s-1", taskText: "deploy review" });
    expect(block).toContain("Settled in your scope (rules in force):");
    expect(wire.statements, OVER_BUDGET).toBeLessThanOrEqual(FIRST_CALL_STATEMENTS);
    expect(wire.maxInFlight).toBe(1);

    resetWire();
    expect(await taskStartNotice(ctx(), { scopePath: ROOT, sessionKey: "s-1", taskText: "deploy review" })).toBeNull();
    expect(wire.statements, OVER_BUDGET).toBeLessThanOrEqual(SERVED_SESSION_STATEMENTS);
  });

  // The derived-write record (services/access/derived-writes.ts) keeps every scope an agent id
  // was ever shown, so a block that shows another agent's note must record that note's scope
  // alone: one upsert, whatever the record already holds. Rewriting the whole record on every
  // block doubled 1.5's added latency for a long-lived agent id (2026-10-27).
  it("records the scope a block showed in one statement, leaving the agent's earlier scopes untouched", async () => {
    const PRIOR = 300;
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const noteScope = `${ROOT}.sales`;
    await db.workingNote.deleteMany({ where: { orgId: ORG } });
    await db.sessionScopeRead.deleteMany({ where: { orgId: ORG } });
    try {
      await db.sessionScopeRead.createMany({
        data: Array.from({ length: PRIOR }, (_, i) => ({
          orgId: ORG,
          agentId: AGENT,
          scopePath: `${ROOT}.past_${i}`,
          lastReadAt: longAgo,
        })),
      });
      await db.workingNote.create({
        data: {
          orgId: ORG,
          scopePath: noteScope,
          agentId: "agent-other",
          task: "deploy review",
          kind: "claim",
          body: "Reviewing the deploy.",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      resetWire();
      const block = await taskStartNotice(ctx(), {
        scopePath: ROOT,
        sessionKey: "s-scopes",
        taskText: "deploy review",
        taskKey: "deploy review",
      });
      expect(block).toContain("Reviewing the deploy.");
      expect(wire.statements, OVER_BUDGET).toBeLessThanOrEqual(FIRST_CALL_STATEMENTS);

      const rows = await db.sessionScopeRead.findMany({ where: { orgId: ORG, agentId: AGENT } });
      expect(rows).toHaveLength(PRIOR + 1);
      expect(rows.find((r) => r.scopePath === noteScope)!.lastReadAt.getTime()).toBeGreaterThan(longAgo.getTime());
      expect(
        rows.filter((r) => r.scopePath !== noteScope).every((r) => r.lastReadAt.getTime() === longAgo.getTime()),
      ).toBe(true);
    } finally {
      await db.workingNote.deleteMany({ where: { orgId: ORG } });
      await db.sessionScopeRead.deleteMany({ where: { orgId: ORG } });
    }
  });

  // What a block showed is recorded by the delivery claim's own statement: the fact versions its
  // lines show, as sightings, and the scopes of what it showed, for the derived-write rule. Each
  // was its own statement until 2026-10-28, three round trips more on every block that showed a
  // fact version and another agent's note, which a team's real work always does: at a hosted
  // database's round trip, that kept the task-start latency above its bar on a busy scope. The seeds above show
  // neither, which is why the five-statement budget did not see them.
  it("records a block's sightings and scopes inside the claim: five statements, and nothing when the claim fails", async () => {
    const factScope = `${ROOT}.eng`;
    const noteScope = `${ROOT}.sales`;
    const versionId = "shown-version-1";
    const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const { claimTaskStartDelivery } = await import("@/services/memory/task-start");
    const cleanUp = async () => {
      await db.workingNote.deleteMany({ where: { orgId: ORG } });
      await db.sessionScopeRead.deleteMany({ where: { orgId: ORG } });
      await db.factVersionRead.deleteMany({ where: { orgId: ORG } });
      await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    };
    await cleanUp();
    try {
      // A long-lived agent id: its record already holds other scopes, which must stay as they were.
      await db.sessionScopeRead.createMany({
        data: Array.from({ length: 50 }, (_, i) => ({
          orgId: ORG,
          agentId: AGENT,
          scopePath: `${ROOT}.past_${i}`,
          lastReadAt: longAgo,
        })),
      });
      await db.memoryChunk.create({
        data: {
          id: versionId,
          orgId: ORG,
          scopePath: factScope,
          content: "Zebracheck rollout: run the migration check first.",
          actorType: "agent",
          actorId: "agent-other",
          factVersion: true,
        },
      });
      await db.changeEvent.create({
        data: {
          orgId: ORG,
          seq: BigInt(2_000_000),
          scopePath: factScope,
          recordType: "fact",
          recordId: versionId,
          op: "create",
          actorId: "agent-other",
          actorType: "agent",
          task: "zebracheck rollout",
          summary: "zebracheck rollout checklist",
        },
      });
      await db.workingNote.create({
        data: {
          orgId: ORG,
          scopePath: noteScope,
          agentId: "agent-other",
          task: "zebracheck rollout",
          kind: "claim",
          body: "Reviewing the deploy.",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      let shownIds: readonly string[] = [];
      resetWire();
      const block = await taskStartNotice(ctx(), {
        scopePath: ROOT,
        sessionKey: "s-shown",
        taskText: "zebracheck rollout",
        taskKey: "zebracheck rollout",
        onShown: (ids) => (shownIds = ids),
      });
      expect(block).toContain("Reviewing the deploy.");
      expect(shownIds).toContain(versionId);
      expect(wire.statements, OVER_BUDGET).toBeLessThanOrEqual(FIRST_CALL_STATEMENTS);
      expect(wire.maxInFlight).toBe(1);

      // The same rows the separate statements wrote: a sighting of the version, and the scopes of the version and the note.
      const sightings = await db.factVersionRead.findMany({ where: { orgId: ORG, agentId: AGENT } });
      expect(sightings.map((r) => [r.versionId, r.sightingOnly])).toEqual([[versionId, true]]);
      const rows = await db.sessionScopeRead.findMany({ where: { orgId: ORG, agentId: AGENT } });
      expect(rows).toHaveLength(52);
      for (const path of [factScope, noteScope])
        expect(rows.find((r) => r.scopePath === path)!.lastReadAt.getTime()).toBeGreaterThan(longAgo.getTime());
      expect(
        rows.filter((r) => r.scopePath.includes(".past_")).every((r) => r.lastReadAt.getTime() === longAgo.getTime()),
      ).toBe(true);

      // A claim that fails, here for a session served moments ago, records nothing it would have shown.
      await db.sessionScopeRead.deleteMany({ where: { orgId: ORG } });
      await db.factVersionRead.deleteMany({ where: { orgId: ORG } });
      const delivery = { sessionKey: "s-shown", scopePath: ROOT, taskKey: "zebracheck rollout" };
      const shown = { agentId: AGENT, versionIds: [versionId], scopePaths: [noteScope] };
      expect(await claimTaskStartDelivery(ctx(), delivery, "again", [], shown)).toBe(false);
      expect(await db.factVersionRead.count({ where: { orgId: ORG } })).toBe(0);
      expect(await db.sessionScopeRead.count({ where: { orgId: ORG } })).toBe(0);

      // A claim that succeeds records them, the version's scope and a named scope once each, an id
      // that is no stored version and a path that is no scope skipped, as the separate statements did.
      const fresh = { sessionKey: "s-direct", scopePath: ROOT, taskKey: "" };
      const named = {
        agentId: AGENT,
        versionIds: [versionId, "no-such-version"],
        scopePaths: [factScope, noteScope, "not a scope!"],
      };
      expect(await claimTaskStartDelivery(ctx(), fresh, "r1", [], named)).toBe(true);
      expect((await db.factVersionRead.findMany({ where: { orgId: ORG } })).map((r) => r.versionId)).toEqual([
        versionId,
      ]);
      expect(
        (await db.sessionScopeRead.findMany({ where: { orgId: ORG }, orderBy: { scopePath: "asc" } })).map(
          (r) => r.scopePath,
        ),
      ).toEqual([factScope, noteScope]);
    } finally {
      await cleanUp();
    }
  });

  // The record is part of the claim's statement, so a recording that fails takes the claim, the
  // served log and the sightings down with it: the session was not told the block, and its next
  // call claims and delivers it. Run as separate statements after the claim, a failure left the
  // block claimed and the session's block used up, with nothing recorded.
  it("rolls the claim back when recording what the block showed fails, and the next call delivers the block", async () => {
    const boom = `${ROOT}.boom`;
    const cleanUp = async () => {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "qa_refuse_boom" ON "session_scope_reads"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "qa_refuse_boom"()`);
      await db.workingNote.deleteMany({ where: { orgId: ORG } });
      await db.sessionScopeRead.deleteMany({ where: { orgId: ORG } });
      await db.taskStartServedItem.deleteMany({ where: { orgId: ORG } });
    };
    await cleanUp();
    try {
      await db.workingNote.create({
        data: {
          orgId: ORG,
          scopePath: boom,
          agentId: "agent-other",
          task: "zebracheck rollout",
          kind: "claim",
          body: "Reviewing the rollout.",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      // Recording the note's scope fails, as a write error inside the claim's statement would.
      await db.$executeRawUnsafe(`CREATE FUNCTION "qa_refuse_boom"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."scopePath" = '${boom}' THEN RAISE EXCEPTION 'qa: recording refused'; END IF; RETURN NEW; END $$`);
      await db.$executeRawUnsafe(
        `CREATE TRIGGER "qa_refuse_boom" BEFORE INSERT ON "session_scope_reads" FOR EACH ROW EXECUTE FUNCTION "qa_refuse_boom"()`,
      );

      const request = {
        scopePath: ROOT,
        sessionKey: "s-rollback",
        taskText: "zebracheck rollout",
        taskKey: "zebracheck rollout",
      };
      let shown = 0;
      await expect(taskStartNotice(ctx(), { ...request, onShown: () => shown++ })).rejects.toThrow(
        /qa: recording refused/,
      );
      expect(shown).toBe(0);
      // Nothing of the claim is left: no delivery row, no served log, no record.
      expect(await db.taskStartDelivery.count({ where: { orgId: ORG, sessionKey: "s-rollback" } })).toBe(0);
      expect(await db.taskStartServedItem.count({ where: { orgId: ORG, sessionKey: "s-rollback" } })).toBe(0);
      expect(await db.sessionScopeRead.count({ where: { orgId: ORG } })).toBe(0);

      await db.$executeRawUnsafe(`DROP TRIGGER "qa_refuse_boom" ON "session_scope_reads"`);
      const block = await taskStartNotice(ctx(), request);
      expect(block).toContain("Reviewing the rollout.");
      expect(await db.taskStartDelivery.count({ where: { orgId: ORG, sessionKey: "s-rollback" } })).toBe(1);
      expect(
        (await db.sessionScopeRead.findMany({ where: { orgId: ORG, agentId: AGENT } })).map((r) => r.scopePath),
      ).toEqual([boom]);
      expect(await taskStartNotice(ctx(), request)).toBeNull();
    } finally {
      await cleanUp();
    }
  });

  it("a returning session's block, opening with the since-your-last-session line, stays in the same five statements", async () => {
    // An earlier session two hours ago, and a change by someone else since: this call is a return.
    const lastCallAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await db.taskStartDelivery.create({
      data: {
        orgId: ORG,
        agentId: AGENT,
        sessionKey: "s-earlier",
        scopePath: ROOT,
        taskKey: "",
        revision: "earlier",
        deliveredAt: lastCallAt,
        lastCallAt,
      },
    });
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(1_000_000),
        scopePath: ROOT,
        recordType: "fact",
        recordId: "since-qa",
        op: "create",
        actorId: "agent-other",
        summary: "a change",
      },
    });

    resetWire();
    const block = await taskStartNotice(ctx(), { scopePath: ROOT, sessionKey: "s-return", taskText: "deploy review" });

    expect(block?.split("\n")[1]).toMatch(
      /^Since your last session \(last call .* UTC\): 1 change by 1 other writer in your scope\.$/,
    );
    expect(wire.statements, OVER_BUDGET).toBeLessThanOrEqual(FIRST_CALL_STATEMENTS);
    expect(wire.maxInFlight).toBe(1);
  });

  it("shows a rule written after one session's block in the next session's block", async () => {
    await taskStartNotice(ctx(), { scopePath: ROOT, sessionKey: "before", taskText: "" });
    await db.convention.create({
      data: {
        id: "rule-new",
        orgId: ORG,
        scopePath: `${ROOT}.sales`,
        kind: "convention",
        subject: "Fresh rule",
        text: "Written between two sessions.",
        actorId: "author",
        createdAt: new Date(Date.UTC(2030, 0, 1)),
      },
    });
    const next = await taskStartNotice(ctx(), { scopePath: ROOT, sessionKey: "after", taskText: "" });
    expect(next).toContain("[convention rule-new] Fresh rule: Written between two sessions.");
  });

  /** The task-start entries of a Server-Timing value; the request's own entries (mcp/server-timing.ts) are left out. */
  const taskStartEntries = (header: string | null): string[] =>
    (header ?? "").split(", ").filter((entry) => entry.startsWith("task-start;"));

  it("reports the block's own duration in a Server-Timing header on the hosted endpoint", async () => {
    const call = (id: number, session: string) =>
      POST(
        new Request("http://localhost/api/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "get_my_brief",
              arguments: { briefId: "no-such-brief" },
              _meta: { "willder/session": session, "willder/task": "deploy review" },
            },
          }),
        }),
      );

    const first = await call(1, "timed");
    const body = (await first.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content.some((c) => c.text.startsWith("Before you start"))).toBe(true);
    const timing = taskStartEntries(first.headers.get("server-timing"));
    expect(timing).toHaveLength(1);
    expect(timing[0]).toMatch(/^task-start;dur=\d+(\.\d+)?$/);
    expect(Number(timing[0]!.split("dur=")[1])).toBeGreaterThanOrEqual(0);

    // The second call of the session is timed too: it is the session check alone.
    const second = await call(2, "timed");
    expect(taskStartEntries(second.headers.get("server-timing"))).toEqual([
      expect.stringMatching(/^task-start;dur=\d+(\.\d+)?$/),
    ]);
  });

  it("adds no task-start entry to a request that runs no tool", async () => {
    const response = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("server-timing")).toMatch(/^handler;dur=/);
    expect(taskStartEntries(response.headers.get("server-timing"))).toEqual([]);
  });

  it("gives a batch one Server-Timing entry per tool call and leaves its body whole", async () => {
    const toolCall = (id: number, session: string) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "get_my_brief",
        arguments: { briefId: "no-such-brief" },
        _meta: { "willder/session": session, "willder/task": "deploy review" },
      },
    });
    const response = await POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify([toolCall(1, "batch-a"), toolCall(2, "batch-b")]),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(taskStartEntries(response.headers.get("server-timing"))).toEqual([
      expect.stringMatching(/^task-start;dur=\d+(\.\d+)?$/),
      expect.stringMatching(/^task-start;dur=\d+(\.\d+)?$/),
    ]);
    const results = (await response.json()) as { id: number; result: { content: { text: string }[] } }[];
    expect(results.map((r) => r.id).sort()).toEqual([1, 2]);
    for (const r of results) expect(r.result.content.some((c) => c.text.startsWith("Before you start"))).toBe(true);
  });
});
