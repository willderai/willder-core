// Latency bench for the task-start block's latency budget, in process
// against a real database: what the task-start block adds, timed as the measure reads it, each
// fresh session's first call minus its second, nearest-rank p95 over PAIRS sessions.
//
// Skipped unless WILLDER_PERF_TESTS=1 and QA_DATABASE_URL names an isolated, migrated Postgres.
// CI does not set WILLDER_PERF_TESTS: a clock bound fails on its busy shards with the code
// unchanged. The claim without a clock, that a block records only the scopes it showed, is
// pinned in mcp/task-start-latency.realdb.test.ts and runs in every CI shard.
//
// The seed is one scope of synthetic work: CHUNKS fact versions with their change events, half
// as many provenance rows (a quarter flagged), rules, and live notes by other agents, so the
// block shows fact versions and notes and records their scopes for the derived-write rule. The
// bound: an agent id already shown PRIOR scopes (a long-lived agent id; the record never
// expires) is served the block about as fast as a fresh one. Rewriting that whole record on
// every block took the added p95 from about 25 ms to about 160 ms at 10,000 scopes (2026-10-27).
//
// Run on a quiet machine:
//   WILLDER_PERF_TESTS=1 QA_DATABASE_URL=<test database> npx vitest run --project node mcp/task-start-bench.perf.realdb.test.ts
// WILLDER_PERF_CHUNKS (default 5000), WILLDER_PERF_PRIOR (10000) and WILLDER_PERF_PAIRS (40) size the run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const QA_URL = process.env.QA_DATABASE_URL;
const CHUNKS = Number(process.env.WILLDER_PERF_CHUNKS ?? 5000);
const PRIOR = Number(process.env.WILLDER_PERF_PRIOR ?? 10_000);
const PAIRS = Number(process.env.WILLDER_PERF_PAIRS ?? 40);

const ORG = "taskstartbench";
const ROOT = `org_${ORG}`;
const SCOPE = `${ROOT}.crew.work`;
const AGENT = "bench-reader";
const TASK = "Review the open changes and decide what ships in the next release";
const WORDS = [
  "deploy",
  "release",
  "review",
  "migration",
  "pricing",
  "changes",
  "ship",
  "index",
  "cache",
  "auth",
  "billing",
  "schema",
];

/** Nearest-rank percentile, as the measure scores it. */
const percentile = (values: readonly number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * values.length) - 1)]!;

describe.skipIf(!QA_URL || process.env.WILLDER_PERF_TESTS !== "1")(
  "performance: the task-start block on a seeded scope",
  () => {
    let db: PrismaClient;
    let taskStartNotice: (typeof import("./task-start-notice"))["taskStartNotice"];
    let ctx: AccessContext;

    beforeAll(async () => {
      process.env.DATABASE_URL = QA_URL;
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      ({ taskStartNotice } = await import("./task-start-notice"));
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.org.create({ data: { id: ORG, name: ORG } });

      const scopes = [SCOPE, ...Array.from({ length: 40 }, (_, i) => `${SCOPE}.s${i}`)];
      const base = Date.now() - 20 * 24 * 60 * 60 * 1000;
      const at = (i: number) => new Date(base + i * 60_000);
      const text = (i: number) =>
        `Fact ${i}: the ${WORDS[i % 12]} of ${WORDS[(i * 7) % 12]} uses ${WORDS[(i * 5) % 12]} step ${i % 97} before the next ${WORDS[(i * 3) % 12]}.`;
      const chunks = Array.from({ length: CHUNKS }, (_, i) => ({
        id: `bench-chunk-${i}`,
        orgId: ORG,
        content: text(i),
        scopePath: scopes[i % scopes.length]!,
        actorType: "agent",
        actorId: `bench-writer-${i % 6}`,
        factVersion: true,
        createdAt: at(i),
        entityName: `entity-${i % 50}`,
      }));
      for (let i = 0; i < chunks.length; i += 1000)
        await db.memoryChunk.createMany({ data: chunks.slice(i, i + 1000) });
      const events = chunks.map((c, i) => ({
        orgId: ORG,
        seq: BigInt(i + 1),
        scopePath: c.scopePath,
        recordType: "fact",
        recordId: c.id,
        op: i % 5 === 0 ? ("update" as const) : ("create" as const),
        actorId: c.actorId,
        summary: c.content.slice(0, 80),
        createdAt: c.createdAt,
      }));
      for (let i = 0; i < events.length; i += 1000)
        await db.changeEvent.createMany({ data: events.slice(i, i + 1000) });
      await db.convention.createMany({
        data: Array.from({ length: 20 }, (_, i) => ({
          id: `bench-rule-${i}`,
          orgId: ORG,
          scopePath: scopes[i % scopes.length]!,
          kind: i % 10 === 0 ? ("decision" as const) : ("convention" as const),
          subject: `Rule ${i} ${WORDS[i % 12]}`,
          text: `Rule ${i}: always ${WORDS[i % 12]} before ${WORDS[(i + 3) % 12]}.`,
          actorId: "author",
          createdAt: at(i),
        })),
      });
      await db.factProvenance.createMany({
        data: Array.from({ length: Math.round(CHUNKS / 2) }, (_, i) => ({
          orgId: ORG,
          scopePath: scopes[i % scopes.length]!,
          graphitiFactUuid: i % 2 === 0 ? `bench-chunk-${i}` : `bench-uuid-${i}`,
          sourceType: "file" as const,
          sourceRef: `repo/file-${i % 300}.ts`,
          ownerId: "owner",
          status: i % 4 === 0 ? ("potentially_stale" as const) : ("fresh" as const),
          flaggedAt: i % 4 === 0 ? at(i) : null,
        })),
      });
      await db.workingNote.createMany({
        data: Array.from({ length: 12 }, (_, i) => ({
          orgId: ORG,
          scopePath: scopes[(i * 3) % scopes.length]!,
          agentId: `bench-writer-${i % 6}`,
          task: i % 2 ? "release" : "other",
          kind: "claim" as const,
          body: `Working on the ${WORDS[i % 12]} review for the next release`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })),
      });
      await db.$executeRawUnsafe(`ANALYZE`);

      const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId: ORG,
          agentId: AGENT,
          tokenHash: hashCapabilityToken(token),
          scopePath: SCOPE,
          permission: "read",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      ctx = { orgId: ORG, actor: { type: "agent", id: AGENT, capabilityToken: token }, origin: "mcp" };
    }, 300_000);

    afterAll(async () => {
      if (!db) return;
      await deleteOrgsWithRetry(db, { where: { id: ORG } });
      await db.$disconnect();
    });

    /** The block's added time over PAIRS fresh sessions: p95 of first call minus second. */
    async function addedP95(tag: string): Promise<number> {
      const call = (sessionKey: string) =>
        taskStartNotice(ctx, { scopePath: SCOPE, sessionKey, taskText: TASK, taskKey: TASK });
      for (let w = 0; w < 3; w++) await call(`${tag}-warm-${w}`);
      const added: number[] = [];
      for (let s = 0; s < PAIRS; s++) {
        let started = performance.now();
        const block = await call(`${tag}-${s}`);
        const first = performance.now() - started;
        started = performance.now();
        const again = await call(`${tag}-${s}`);
        const second = performance.now() - started;
        expect(block).not.toBeNull();
        expect(again).toBeNull();
        added.push(first - second);
      }
      return percentile(added, 95);
    }

    it("serves a long-lived agent id the block about as fast as a fresh one", async () => {
      const fresh = await addedP95("fresh");
      const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const rows = Array.from({ length: PRIOR }, (_, i) => ({
        orgId: ORG,
        agentId: AGENT,
        scopePath: `${SCOPE}.past_${i}`,
        lastReadAt: longAgo,
      }));
      for (let i = 0; i < rows.length; i += 1000)
        await db.sessionScopeRead.createMany({ data: rows.slice(i, i + 1000) });
      const longLived = await addedP95("long-lived");
      console.log(
        `task-start bench: ${CHUNKS} fact versions, ${PAIRS} pairs; added p95 ${fresh.toFixed(1)} ms fresh, ${longLived.toFixed(1)} ms with ${PRIOR} scopes already shown`,
      );
      expect(longLived).toBeLessThanOrEqual(1.5 * fresh + 15);
    }, 300_000);
  },
);
