// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The per-org applied-markers lock
// (erasure-suppression.ts, lockAppliedMarkers) and the migration's backfill by unfinished
// erasures.
//  1. Which locks a statement runs under: a trigger on every table the erasure, re-apply,
//     import and note paths write records whether that statement's session holds the
//     applied-markers lock. Only the suppression tables may be written while it is held, so
//     the lock is last in every marking transaction and alone in a listing, and no wait on the
//     audit chain head, the change feed or the note locks can start while it is held.
//  2. Two orgs whose lock keys collide (hashtext of the id, 32 bits) run erasures, re-applies,
//     imports and note posts at once: they serialize, never deadlock, and neither org's markers
//     touch the other's entries.
//  3. The backfill over one database holding every outcome an erasure can have had when the
//     migration runs: finished, failed before the graph, failed after a committed step,
//     listed again by a later failed erasure, retried, still running, and an unrelated failed
//     erasure that started first. No org that still stores the person reads applied.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { AccessContext } from "@/services/access";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

const graphPlan = vi.fn(async (_input?: unknown) => [] as string[]);
const graphErase = vi.fn(async (_input?: unknown) => ({
  episodes: 0,
  nodes: 0,
  edges: 0,
  summaries: 0,
  episodeIds: [] as string[],
}));
vi.mock("./store", () => ({
  memory: { ingest: vi.fn() },
  graphitiStore: {
    planPersonErasure: (input: unknown) => graphPlan(input),
    erasePerson: (input: unknown) => graphErase(input),
    removeEpisode: async () => ({ removed: true }),
    removeChunkFacts: async () => {},
    removeGroupFacts: async () => ({ removedCount: 0 }),
  },
}));
vi.mock("@/services/guardrails", () => ({ checkEpisodeCap: vi.fn(), recordEpisode: vi.fn() }));

const QA_URL = process.env.QA_DATABASE_URL;
// hashtext('qacoll16411') = hashtext('qacoll396283') = -1208707283 (checked in the test).
const COLLIDING = ["qacoll16411", "qacoll396283"] as const;
const BACKFILL_ORGS = [
  "qabffin",
  "qabfpre",
  "qabfstep",
  "qabfrelist",
  "qabfretry",
  "qabfrunning",
  "qabfother",
] as const;
const ALL_ORGS = [...COLLIDING, ...BACKFILL_ORGS, "qalockorder", "qalockimp"];
const NAME = "Wilhelmina Quarrendon";
const OTHER_NAME = "Barnaby Thistlewood";
const DIMENSIONS = 384;
const LONG_AGO = new Date(Date.now() - 24 * 3600 * 1000);
const LOCK_NAMESPACE = 8_241_006;

const email = (org: string) => `wilhelmina@${org}.example`;
const otherEmail = (org: string) => `barnaby@${org}.example`;
const adminOf = (org: string) => `u-${org}`;
const ctxOf = (org: string): AccessContext => ({
  orgId: org,
  actor: { type: "human", id: adminOf(org), role: "admin" },
  origin: "app",
});

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

function backfillStatement(): string {
  const sql = readFileSync(
    join(process.cwd(), "prisma/migrations/20261016070000_erasure_suppressions_applied/migration.sql"),
    "utf8",
  );
  const start = sql.indexOf('INSERT INTO "erasure_suppressions_applied"');
  return `${sql.slice(start, sql.indexOf(";", start)).trim()} ON CONFLICT DO NOTHING`;
}

/** A rejection that is a lock failure, not a refusal the path is allowed to make. */
const LOCK_FAILURE =
  /deadlock|40P01|P2034|P2028|Transaction (already closed|API error)|expired|timed? ?out|could not serialize/i;

describe.skipIf(!QA_URL)("QA: the applied-markers lock and the backfill, real Postgres", () => {
  let db: PrismaClient;
  let erasePerson: (typeof import("./person-erasure"))["erasePerson"];
  let reapplyErasures: (typeof import("./erasure-reapply"))["reapplyErasures"];
  let erasuresApplied: (typeof import("./erasure-suppression"))["erasuresApplied"];
  let postWorkingNote: (typeof import("./working-notes"))["postWorkingNote"];
  let exportMemory: (typeof import("./org-export"))["exportMemory"];
  let importMemory: (typeof import("./org-import"))["importMemory"];

  async function wipe(org: string) {
    await db.factEdge.deleteMany({ where: { orgId: org } });
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${org}`;
    await db.workingNote.deleteMany({ where: { orgId: org } });
    await db.brief.deleteMany({ where: { orgId: org } });
    await db.convention.deleteMany({ where: { orgId: org } });
    await db.source.deleteMany({ where: { orgId: org } });
    await db.changeEvent.deleteMany({ where: { orgId: org } });
    await db.erasureSuppression.deleteMany({ where: { orgId: org } });
    await db.contact.deleteMany({ where: { orgId: org } });
    await db.auditLog.deleteMany({ where: { orgId: org } });
    await db.grant.deleteMany({ where: { orgId: org } });
    await db.scope.deleteMany({ where: { orgId: org } });
    await db.user.deleteMany({ where: { orgId: org } });
    await deleteOrgsWithRetry(db, { where: { id: org } });
  }
  async function seed(org: string) {
    await db.org.create({ data: { id: org, name: org } });
    const root = await db.scope.create({ data: { orgId: org, path: `org_${org}`, name: "root" } });
    await db.user.create({
      data: { id: adminOf(org), orgId: org, email: `admin@${org}.test`, role: "admin", clerkId: `clerk-${org}` },
    });
    await db.grant.create({
      data: { orgId: org, scopeId: root.id, granteeType: "user", granteeId: adminOf(org), permission: "admin" },
    });
    await db.contact.create({
      data: { id: `${org}-p`, orgId: org, name: NAME, email: email(org), createdAt: LONG_AGO },
    });
    await db.contact.create({
      data: { id: `${org}-q`, orgId: org, name: OTHER_NAME, email: otherEmail(org), createdAt: LONG_AGO },
    });
  }
  async function addChunk(org: string, id: string, content: string, createdAt = new Date()) {
    await db.$executeRaw`
      INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "scopePath", "factVersion", embedding, "createdAt")
      VALUES (${id}, ${org}, ${content}, 'text', 'agent', 'agent-1', ${`org_${org}`}, false, ${`[${embed(content).join(",")}]`}::vector, ${createdAt})`;
  }
  async function addNote(org: string, body: string, createdAt = new Date()) {
    await db.workingNote.create({
      data: {
        orgId: org,
        scopePath: `org_${org}`,
        agentId: "agent-1",
        task: "acme",
        kind: "status",
        body,
        createdAt,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
  }
  /** What of the person `org` still stores: her contact, chunks and notes naming her. */
  async function storesHer(org: string): Promise<number> {
    const contacts = await db.contact.count({ where: { orgId: org, email: email(org) } });
    const chunks = await db.memoryChunk.count({
      where: { orgId: org, OR: [{ content: { contains: email(org) } }, { content: { contains: NAME } }] },
    });
    const notes = await db.workingNote.count({ where: { orgId: org, body: { contains: NAME } } });
    return contacts + chunks + notes;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    vi.stubGlobal("fetch", vi.fn(embeddingService));
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ erasePerson } = await import("./person-erasure"));
    ({ reapplyErasures } = await import("./erasure-reapply"));
    ({ erasuresApplied } = await import("./erasure-suppression"));
    ({ postWorkingNote } = await import("./working-notes"));
    ({ exportMemory } = await import("./org-export"));
    ({ importMemory } = await import("./org-import"));
  });

  beforeEach(async () => {
    graphPlan.mockReset();
    graphPlan.mockResolvedValue([]);
    graphErase.mockReset();
    graphErase.mockResolvedValue({ episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const org of ALL_ORGS) await wipe(org);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    if (!db) return;
    await db.$executeRawUnsafe("DROP TABLE IF EXISTS qa_lock_events");
    await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS qa_lock_probe()");
    for (const org of ALL_ORGS) await wipe(org);
    await db.$disconnect();
  });

  it("no statement other than the suppression tables' runs while the applied-markers lock is held", async () => {
    const org = "qalockorder";
    await seed(org);
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS qa_lock_events (seq bigserial, tx bigint, tbl text, op text, held boolean)`);
    await db.$executeRawUnsafe("TRUNCATE qa_lock_events");
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION qa_lock_probe() RETURNS trigger
      SET search_path = pg_catalog, pg_temp AS $$
      BEGIN
        -- Named by schema: the audit chain heads are written from inside a function pinned
        -- to pg_catalog, pg_temp, whose search_path this trigger then runs under.
        INSERT INTO public.qa_lock_events (tx, tbl, op, held)
        SELECT txid_current(), TG_TABLE_NAME, TG_OP, EXISTS (
          SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
            AND classid = ${LOCK_NAMESPACE} AND objsubid = 2 AND granted);
        RETURN NULL;
      END $$ LANGUAGE plpgsql`);
    const tables = [
      "audit_log",
      "audit_chain_heads",
      "change_events",
      "working_notes",
      "briefs",
      "contacts",
      "memory_chunks",
      "conventions",
      "erasure_suppressions",
      "erasure_suppressions_applied",
    ];
    for (const t of tables) {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qa_lock_probe ON ${t}`);
      await db.$executeRawUnsafe(
        `CREATE TRIGGER qa_lock_probe AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION qa_lock_probe()`,
      );
    }
    try {
      const ctx = ctxOf(org);
      await addChunk(org, "lo-1", `${email(org)} asked for the invoice.`);
      await addNote(org, `Waiting on ${NAME}.`);
      await db.brief.create({
        data: {
          orgId: org,
          type: "handoff",
          scopePath: `org_${org}`,
          title: "Renewal",
          summary: `Call ${NAME}.`,
          sections: [],
        },
      });
      const lines: string[] = [];
      for await (const line of exportMemory(ctx)) lines.push(line.trimEnd());
      await erasePerson(ctx, { contactId: `${org}-p` });
      await postWorkingNote(ctx, {
        scopePath: `org_${org}`,
        task: "renewal",
        kind: "status",
        body: "Renewal is on track.",
      });
      // A restore: her rows back, markers gone, then the re-apply and an import's closing re-apply.
      await addChunk(org, "lo-2", `${email(org)} asked again.`, LONG_AGO);
      await addNote(org, `Still waiting on ${NAME}.`, LONG_AGO);
      await db.erasureSuppressionApplied.deleteMany({ where: { orgId: org } });
      await reapplyErasures(ctx);
      expect(await erasuresApplied(org)).toBe(true);
      // An import into an empty org, with its closing re-apply.
      await seed("qalockimp");
      async function* stream() {
        yield* lines;
      }
      const receipt = await importMemory(ctxOf("qalockimp"), stream());
      expect(receipt.imported.fact).toBeGreaterThan(0);
    } finally {
      for (const t of tables) await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS qa_lock_probe ON ${t}`);
    }
    const events = await db.$queryRawUnsafe<{ tbl: string; op: string; held: boolean }[]>(
      "SELECT tbl, op, held FROM qa_lock_events ORDER BY seq",
    );
    const whileHeld = events.filter((e) => e.held).map((e) => `${e.tbl} ${e.op}`);
    // The lock was taken, by listings and by markers.
    expect(whileHeld).toContain("erasure_suppressions_applied INSERT");
    expect(whileHeld).toContain("erasure_suppressions INSERT");
    // ...and nothing that takes another lock ran under it.
    expect([...new Set(whileHeld)].filter((e) => !e.startsWith("erasure_suppressions"))).toEqual([]);
    // The probe saw the paths that take the other locks.
    const seen = new Set(events.map((e) => e.tbl));
    for (const t of ["audit_chain_heads", "change_events", "working_notes", "briefs", "contacts", "memory_chunks"])
      expect(seen).toContain(t);
  }, 60_000);

  it("two orgs whose lock keys collide run erasures, re-applies, imports and note posts at once without a lock failure", async () => {
    const [{ a, b }] = await db.$queryRaw<
      { a: number; b: number }[]
    >`SELECT hashtext(${COLLIDING[0]}) AS a, hashtext(${COLLIDING[1]}) AS b`;
    expect(a).toBe(b);
    const [A, B] = COLLIDING;
    for (const org of COLLIDING) await seed(org);
    await addChunk(A, "a-c0", `${email(A)} asked for the March invoice.`);
    await addChunk(A, "a-kept", "Acme renews in March.");
    const exported: string[] = [];
    for await (const line of exportMemory(ctxOf(A))) exported.push(line.trimEnd());
    await erasePerson(ctxOf(A), { contactId: `${A}-p` });
    async function* stream() {
      yield* exported;
    }
    let imported = 0;
    for (let round = 0; round < 8; round++) {
      await addChunk(A, `a-r${round}`, `${email(A)} asked for invoice ${round}.`);
      await addNote(A, `Waiting on ${NAME}, round ${round}.`);
      // B empty again, so it can take an import while A erases and B erases too.
      for (const table of [
        "fact_edges",
        "memory_chunks",
        "working_notes",
        "briefs",
        "conventions",
        "sources",
        "change_events",
      ]) {
        await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE "orgId" = '${B}'`);
      }
      if ((await db.contact.count({ where: { id: `${B}-p` } })) === 0) {
        await db.contact.create({ data: { id: `${B}-p`, orgId: B, name: NAME, email: email(B), createdAt: LONG_AGO } });
      }
      const must = [
        erasePerson(ctxOf(A), { email: email(A) }),
        reapplyErasures(ctxOf(A)),
        erasePerson(ctxOf(A), { email: email(A) }),
        reapplyErasures(ctxOf(A)),
        erasePerson(ctxOf(B), { contactId: `${B}-p` }),
        reapplyErasures(ctxOf(B)),
      ];
      const others = [
        importMemory(ctxOf(B), stream()).then((r) => (imported += r.imported.fact)),
        postWorkingNote(ctxOf(A), {
          scopePath: `org_${A}`,
          task: `t${round}`,
          kind: "status",
          body: `Round ${round} note.`,
        }),
        postWorkingNote(ctxOf(B), {
          scopePath: `org_${B}`,
          task: `t${round}`,
          kind: "status",
          body: `Round ${round} note.`,
        }),
        postWorkingNote(ctxOf(A), {
          scopePath: `org_${A}`,
          task: `t${round}`,
          kind: "status",
          body: `Round ${round} renewed.`,
        }),
      ];
      const [mustResults, otherResults] = await Promise.all([Promise.allSettled(must), Promise.allSettled(others)]);
      expect(
        mustResults.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);
      expect(
        otherResults
          .filter((r) => r.status === "rejected" && LOCK_FAILURE.test(String((r as PromiseRejectedResult).reason)))
          .map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);
    }
    expect(imported).toBeGreaterThan(0);
    for (const org of COLLIDING) {
      await reapplyErasures(ctxOf(org));
      expect(await erasuresApplied(org)).toBe(true);
    }
    expect(await db.memoryChunk.count({ where: { orgId: A, content: { contains: email(A) } } })).toBe(0);
    // B's unfinished listing is not marked by anything A does, though they share a lock key.
    graphPlan.mockRejectedValueOnce(new Error("graph store unavailable"));
    await expect(erasePerson(ctxOf(B), { contactId: `${B}-q` })).rejects.toThrow(/graph store unavailable/);
    await erasePerson(ctxOf(A), { contactId: `${A}-q` });
    await reapplyErasures(ctxOf(A));
    expect(await erasuresApplied(A)).toBe(true);
    expect(await erasuresApplied(B)).toBe(false);
  }, 240_000);

  it("the backfill over every outcome: no org that still stores her reads applied", async () => {
    for (const org of BACKFILL_ORGS) {
      await seed(org);
      await addChunk(org, `${org}-c`, `${email(org)} asked for the May invoice.`);
      await addNote(org, `Waiting on ${NAME}.`);
    }
    const ok = (org: string) => erasePerson(ctxOf(org), { contactId: `${org}-p` });
    // Finished.
    await ok("qabffin");
    // Failed before the graph.
    graphPlan.mockRejectedValueOnce(new Error("graph store unavailable"));
    await expect(ok("qabfpre")).rejects.toThrow(/graph/);
    // Failed after a committed step (the graph plan's step row), so its last audit row is later than its listing.
    graphErase.mockRejectedValueOnce(new Error("graph erase failed"));
    await expect(ok("qabfstep")).rejects.toThrow(/graph erase failed/);
    expect(
      await db.auditLog.count({
        where: { orgId: "qabfstep", action: { not: "person.erased" }, target: { contains: "person_erasure:" } },
      }),
    ).toBeGreaterThan(1);
    // Finished, then listed again by a later erasure that failed after a step; a copy written between is stored.
    await ok("qabfrelist");
    await addChunk("qabfrelist", "qabfrelist-c2", `${email("qabfrelist")} asked for the June invoice.`);
    graphErase.mockRejectedValueOnce(new Error("graph erase failed"));
    await expect(erasePerson(ctxOf("qabfrelist"), { email: email("qabfrelist") })).rejects.toThrow(
      /graph erase failed/,
    );
    // Failed after a step, then retried to completion.
    graphErase.mockRejectedValueOnce(new Error("graph erase failed"));
    await expect(ok("qabfretry")).rejects.toThrow(/graph erase failed/);
    await ok("qabfretry");
    // Another person's erasure failed first; hers finished after it.
    graphErase.mockRejectedValueOnce(new Error("graph erase failed"));
    await expect(erasePerson(ctxOf("qabfother"), { contactId: "qabfother-q" })).rejects.toThrow(/graph erase failed/);
    await ok("qabfother");
    // Still running when the migration runs: listed, held in the graph step.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let listed!: () => void;
    const isListed = new Promise<void>((r) => (listed = r));
    graphErase.mockImplementationOnce(async () => {
      listed();
      await held;
      return { episodes: 0, nodes: 0, edges: 0, summaries: 0, episodeIds: [] };
    });
    const running = ok("qabfrunning");
    await isListed;

    // The migration: no markers before it, then the backfill.
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: { in: [...BACKFILL_ORGS] } } });
    await db.$executeRawUnsafe(backfillStatement());

    const report: Record<string, { applied: boolean; stores: number }> = {};
    for (const org of BACKFILL_ORGS)
      report[org] = { applied: await erasuresApplied(org), stores: await storesHer(org) };
    for (const [org, r] of Object.entries(report)) {
      if (r.stores > 0) expect({ org, applied: r.applied }).toEqual({ org, applied: false });
    }
    expect(report.qabffin).toEqual({ applied: true, stores: 0 });
    expect(report.qabfretry).toEqual({ applied: true, stores: 0 });
    expect(report.qabfrelist!.stores).toBeGreaterThan(0);
    expect(report.qabfrunning!.applied).toBe(false);

    // The running erasure finishes after the backfill and marks its own.
    release();
    await running;
    expect(await erasuresApplied("qabfrunning")).toBe(true);
    expect(await storesHer("qabfrunning")).toBe(0);

    // complete-restore's re-apply then leaves every org applied with nothing of hers stored.
    for (const org of BACKFILL_ORGS) {
      await reapplyErasures(ctxOf(org));
      expect({ org, applied: await erasuresApplied(org), stores: await storesHer(org) }).toEqual({
        org,
        applied: true,
        stores: 0,
      });
    }
  }, 120_000);
});
