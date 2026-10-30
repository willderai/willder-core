// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// memory_query's no-readable-match note (mcp/read-notes.ts): when the question names a
// specific value that no memory the caller can read holds, the answer says so in one fixed
// sentence (services/memory/readable-values.ts).
//
// The rules under test:
//  - the note is given for a guessed value no readable memory holds, and never repeats it;
//  - a value hidden in another scope, deleted, superseded, erased, written in another org,
//    or never written gives the same answer to the byte, with the same `_meta`, so the note
//    is no oracle for whether a value exists where the caller cannot read;
//  - a value the caller can read anywhere it may (its scope, a scope below it, a rule in
//    force, a live working note, a fact the read served) suppresses it;
//  - a read that could reach graph content no exhaustive search covers makes no claim.
//
// Real: the hosted MCP endpoint over a socket, check() against live capability tokens,
// memory_ingest's write into Postgres, the delete through guardedMemory.removeFact, the
// vector read and the value check on Postgres. A stand-in memory service answers
// embeddings with one fixed vector, accepts every graph write and delete, and serves from
// /search only the graph facts a test seeds.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf modules, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll points DATABASE_URL at the test database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import { NO_READABLE_MATCH_NOTE, UNHELD_VALUES_META_KEY } from "./read-notes";
import { specificValuesIn, textHoldsValue } from "@/services/memory/specific-values";
import { SPELLING_CASES } from "@/services/memory/specific-values.cases.testsupport";

// The stand-in graph's facts here have no stored rows behind them, and this file is about
// the no-readable-match note, not about which facts a stored source supports: the serve-time source check
// (services/memory/graph-fact-sources.ts) supports them all. It is proven against real rows in
// services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
vi.mock("@/services/guardrails", () => ({
  checkEpisodeCap: async () => undefined,
  recordEpisode: async () => undefined,
}));
vi.mock("@/lib/llm", () => ({
  createLLMClient: () => ({
    chat: {
      completions: {
        create: async () => {
          throw new Error("no llm in this test");
        },
      },
    },
  }),
  LLM_MODEL_EXTRACT: "test-model",
  LLM_MODEL_ORCHESTRATOR: "test-model",
}));

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "noreadablematch";
const OTHER_ORG = "noreadablematchother";
const ROOT = `org_${ORG}`;
/** The reader's scope. Its underscore is a LIKE wildcard if left unescaped. */
const PATIENT = `${ROOT}.patient_care`;
const PATIENT_SUB = `${PATIENT}.contacts`;
const PATIENT_FORGET = `${PATIENT}.forget1`;
const CLINICAL = `${ROOT}.clinical`;
/** A sibling whose path starts with the reader's: `patient_care` is not `patient_carex`. */
const PREFIX_SIBLING = `${ROOT}.patient_carex`;
/** What an unescaped `patient_care.%` would also match. */
const WILDCARD_SIBLING = `${ROOT}.patientXcare.inner`;
const OTHER_ROOT = `org_${OTHER_ORG}`;
const OTHER_PATIENT = `${OTHER_ROOT}.patient_care`;

const DIMENSIONS = 384;
const VECTOR = `[${new Array(DIMENSIONS).fill(0.01).join(",")}]`;

const VISIBLE = [
  "[t122 2026-03-01T09:00] Nurse Janelle (nurse): Elena's regular cell is 415-555-0122; portal-only contact is active.",
  "[t175 2026-03-08T09:21] MemCare (agent): Portal-only communication preference remains active after safe-phone deletion.",
];
const GUESSED =
  "[t040 2026-02-20T10:00] Elena Park (patient): Temporary safe number 415-555-0174, do not leave voicemail mentioning pregnancy.";
const GUESS = "Yes or no: did the temporary safe number end in 0174?";
const GUESSED_VALUE = "0174";

/** A memory service on a real socket: a fixed embedding, every graph write and delete accepted, seeded graph facts only. */
class SeededGraphMemoryService {
  private server: Server | null = null;
  readonly graphFacts = new Map<string, string[]>();

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const path = new URL(req.url ?? "/", "http://memory").pathname;
        const body = chunks.length
          ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>)
          : {};
        const send = (status: number, payload: unknown) =>
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
        if (path === "/embed") return send(200, { embedding: new Array(DIMENSIONS).fill(0.01) });
        if (path === "/ingest") return send(200, { episode_id: `ep-${Math.random().toString(36).slice(2)}` });
        if (path === "/search") {
          const facts = (this.graphFacts.get(String(body.group_id)) ?? []).map((fact, i) => ({
            uuid: `graph-${i}`,
            fact,
            valid_at: null,
            actor_type: "agent",
            actor_name: "graph",
            source_id: null,
            chunk_ids: [],
          }));
          return send(200, { facts });
        }
        if (req.method === "DELETE" && path.startsWith("/chunks/"))
          return send(200, { removed_facts: 0, removed_episodes: 0 });
        if (req.method === "DELETE" && path.startsWith("/facts/")) return send(404, { detail: "no such fact" });
        if (path === "/graph") return send(200, { nodes: [], edges: [] });
        return send(404, { detail: `no route ${path}` });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("memory service did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  _meta?: Record<string, unknown>;
}

// Every test here asks through a real MCP session: a client connects, initializes and closes
// for each read, beside the store reads and the check. One test makes a dozen of those, and on
// a loaded CI runner two such tests passed 5 s with the read path unchanged, while the read
// itself stayed under 300 ms. So the tests get room for their round trips, and the read's own latency is held
// by "checks a real org's volume in one pass, at a bounded multiple of hashing its rows" as
// work inside Postgres, not by a timeout, and the whole read's wall-clock is printed.
const ROUND_TRIP_TESTS_TIMEOUT_MS = 30_000;

// The hooks' own ceilings. The describe's timeout covers its tests, not its hooks, which kept
// vitest's 10 s hookTimeout. On a local CI run at 3% free memory the afterEach
// after "reads past any number of suppressed copies" (70,000 restored rows to delete) passed
// 10 s; vitest moved on while it still ran, and the next test's first check read rows the
// cleanup had not deleted yet, in 8 statements instead of 3 ("empty: [8, 3]"). A cleanup that
// finishes, however slowly, keeps every test starting from the baseline. The beforeAll starts
// two servers and seeds through real MCP writes.
const HOOK_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 120_000;

// The check's own statement timeout (CHECK_TIMEOUT_MS, services/memory/readable-values.ts),
// as it sets it. Past it the check throws and its caller makes no claim (heldNamedValues,
// guarded-store.ts; mcp/no-readable-match.test.ts "makes no claim, and still answers, when
// the check fails"; the QA file's ~1 MB rows). On a machine at load 25-400 a statement that
// takes 300 ms quiet crosses it, and main went red on three tests here that assert what the
// check answers, not how fast, and on a fourth through a spy one of
// them left in place when it threw (restored in finally blocks now). This file lifts it, so each of its
// answers is the check's real answer: never a timeout read as one. The latency claim is held
// as the check's statement time over a plain pass of the same rows, both timed in Postgres.
// Lifted below the 30 s test timeout, so a check gone slow fails its test, not the next one.
const CHECK_TIMEOUT_SETTING = /^SET LOCAL statement_timeout = 1000$/;
const LIFTED_CHECK_TIMEOUT = "SET LOCAL statement_timeout = 20000";
/**
 * The most the 8-value check's stored-version statement over a real org's volume may cost
 * in Postgres, as a multiple of one plain pass hashing the same rows. Measured on Postgres 17
 * (CI runs 16, not measured): p50 7.9-8.3 at load 17-90 and 9.1-10.7 at load 108-207, so about
 * twice the headroom the measure needs; the check without its cheap screen measured 55.
 */
const CHECK_OVER_PLAIN_PASS = 20;

describe.skipIf(!QA_URL)(
  "memory_query's no-readable-match note, on a real read",
  { timeout: ROUND_TRIP_TESTS_TIMEOUT_MS },
  () => {
    const service = new SeededGraphMemoryService();
    let db: PrismaClient;
    let mcpUrl: string;
    let closeMcp: () => Promise<void>;
    let guardedMemory: (typeof import("@/services/memory"))["guardedMemory"];
    let recordSuppressions: (typeof import("@/services/memory/erasure-suppression"))["recordSuppressions"];
    let recordErasedVersions: (typeof import("@/services/memory/erasure-suppression"))["recordErasedVersions"];
    let markApplied: (typeof import("@/services/memory/erasure-suppression"))["markApplied"];
    let listEntriesAsOf: (typeof import("@/services/memory/erasure-suppression"))["listEntriesAsOf"];
    /** That the erasures recorded so far have been carried out, as a completed erasure request records it. */
    const erasuresCompleted = async () =>
      markApplied(db, ORG, "test", { entries: (await listEntriesAsOf(ORG)).entries });
    let readableMemoryHolds: (typeof import("@/services/memory/readable-values"))["readableMemoryHolds"];
    /** How many of the check's statements ran with its timeout lifted. */
    let checkTimeoutsLifted = 0;
    let reader = "";
    let rootReader = "";
    const writers = new Map<string, string>();
    /** The visible versions every test starts from. */
    const baseline: string[] = [];

    async function mint(
      orgId: string,
      agentId: string,
      scopePath: string,
      permission: "read" | "write",
    ): Promise<string> {
      const token = `wcap_test_${agentId}_${Math.random().toString(36).slice(2)}`;
      await db.capability.create({
        data: {
          orgId,
          agentId,
          tokenHash: hashCapabilityToken(token),
          scopePath,
          permission,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      return token;
    }

    async function call(token: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
      const client = new Client({ name: "willder-test", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      try {
        return (await client.callTool({ name, arguments: args })) as ToolResult;
      } finally {
        await client.close();
      }
    }

    /**
     * Write `content` into `scopePath` through memory_ingest, as a writer whose token is on
     * that scope (so its session has read nothing elsewhere), and return the stored version's id.
     */
    async function write(orgId: string, scopePath: string, content: string): Promise<string> {
      if (!writers.has(scopePath)) writers.set(scopePath, await mint(orgId, `writer-${scopePath}`, scopePath, "write"));
      const name = `turns ${Math.random().toString(36).slice(2)}`;
      const written = await call(writers.get(scopePath)!, "memory_ingest", { content, scopePath, name });
      expect(written.isError, JSON.stringify(written.content)).toBeFalsy();
      const row = await db.memoryChunk.findFirstOrThrow({
        where: { orgId, scopePath, content },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      return row.id;
    }

    async function insertChunk(
      orgId: string,
      scopePath: string | null,
      content: string,
      createdAt?: Date,
    ): Promise<string> {
      const id = `c-${Math.random().toString(36).slice(2)}`;
      await db.$executeRawUnsafe(
        `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
       VALUES ($1, $2, $3, 'text', 'agent', 'seed', $4, $5::vector, $6::timestamp)`,
        id,
        orgId,
        content,
        scopePath,
        VECTOR,
        (createdAt ?? new Date()).toISOString().replace("Z", ""),
      );
      return id;
    }

    const removeChunk = (id: string) =>
      db.$executeRaw`DELETE FROM memory_chunks WHERE id = ${id} AND "orgId" IN (${ORG}, ${OTHER_ORG})`;

    /** memory_query's own answer, the revision included and the change notices after it left out, with its `_meta`. */
    function own(result: ToolResult): string {
      const end = result.content.findIndex((c) => c.text?.startsWith("revision: "));
      expect(end, JSON.stringify(result.content)).toBeGreaterThanOrEqual(0);
      return JSON.stringify({ content: result.content.slice(0, end + 1), meta: result._meta ?? null });
    }

    const textOf = (result: ToolResult) => result.content.map((c) => c.text ?? "").join("\n");

    async function ask(question = GUESS, token = reader, scopePath = PATIENT): Promise<ToolResult> {
      const result = await call(token, "memory_query", { query: question, scopePath, limit: 20 });
      expect(result.isError, textOf(result)).toBeFalsy();
      return result;
    }

    beforeAll(async () => {
      if (QA_URL === undefined) return;
      if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
      process.env.DATABASE_URL = QA_URL;
      process.env.GRAPHITI_SERVICE_URL = await service.start();
      process.env.GRAPHITI_SERVICE_API_KEY = "test-key";
      db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
      const inngestModule = await import("@/lib/inngest");
      vi.spyOn(inngestModule.inngest, "send").mockImplementation((async () => ({ ids: ["job"] })) as never);
      const { db: appDb } = await import("@/lib/db");
      const executeRawUnsafe = appDb.$executeRawUnsafe.bind(appDb);
      vi.spyOn(appDb, "$executeRawUnsafe").mockImplementation(((query: string, ...values: unknown[]) => {
        if (!CHECK_TIMEOUT_SETTING.test(query)) return executeRawUnsafe(query, ...values);
        checkTimeoutsLifted++;
        return executeRawUnsafe(LIFTED_CHECK_TIMEOUT);
      }) as never);
      ({ guardedMemory } = await import("@/services/memory"));
      ({ recordSuppressions, recordErasedVersions, markApplied, listEntriesAsOf } = await import(
        "@/services/memory/erasure-suppression"
      ));
      ({ readableMemoryHolds } = await import("@/services/memory/readable-values"));
      const { startMcpTestServer } = await import("./http-test-server");
      const mcp = await startMcpTestServer();
      mcpUrl = mcp.url;
      closeMcp = mcp.close;

      await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
      for (const [orgId, paths] of [
        [
          ORG,
          [
            ROOT,
            PATIENT,
            PATIENT_SUB,
            PATIENT_FORGET,
            CLINICAL,
            PREFIX_SIBLING,
            `${ROOT}.patientXcare`,
            WILDCARD_SIBLING,
          ],
        ],
        [OTHER_ORG, [OTHER_ROOT, OTHER_PATIENT]],
      ] as const) {
        await db.org.create({ data: { id: orgId, name: orgId } });
        for (const path of paths) await db.scope.create({ data: { orgId, path, name: path.split(".").at(-1)! } });
      }
      reader = await mint(ORG, "patient-reader", PATIENT, "read");
      rootReader = await mint(ORG, "root-reader", ROOT, "read");
      for (const content of VISIBLE) baseline.push(await write(ORG, PATIENT, content));
    }, SETUP_TIMEOUT_MS);

    /** Every test starts from the two visible versions alone, whatever an earlier one left on a failure. */
    afterEach(async () => {
      if (QA_URL === undefined) return;
      service.graphFacts.clear();
      for (const orgId of [ORG, OTHER_ORG]) {
        await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId} AND id <> ALL (${baseline}::text[])`;
        await db.factEdge.deleteMany({ where: { orgId, kind: "supersedes" } });
        await db.convention.deleteMany({ where: { orgId } });
        await db.workingNote.deleteMany({ where: { orgId } });
        await db.source.deleteMany({ where: { orgId } });
        await db.erasureSuppression.deleteMany({ where: { orgId } });
        await db.erasureSuppressionApplied.deleteMany({ where: { orgId } });
      }
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      if (QA_URL === undefined) return;
      await closeMcp?.();
      await service.stop();
      await db.org.deleteMany({ where: { id: { in: [ORG, OTHER_ORG] } } });
      await db.$disconnect();
    }, HOOK_TIMEOUT_MS);

    it("gives the note for a guessed value no readable memory holds, and never repeats the value", async () => {
      const result = await ask();
      const text = textOf(result);
      expect(text).toContain(NO_READABLE_MATCH_NOTE);
      expect(result._meta?.[UNHELD_VALUES_META_KEY]).toEqual([0]);
      expect(text).not.toContain(GUESSED_VALUE);
      // The visible page is still served: the note is beside the facts, not instead of them.
      expect(text).toContain("415-555-0122");
      expect(NO_READABLE_MATCH_NOTE).not.toMatch(/0174|delet|eras|remov|hidden|access/i);
    });

    it("answers the same, to the byte, for a value hidden, deleted, superseded, erased, in another org, or never written", async () => {
      const neverWritten = own(await ask());
      const answers = new Map<string, string>();

      // Hidden: in a sibling scope, a sibling sharing the reader's prefix, and one an unescaped `_` would match.
      for (const scope of [CLINICAL, PREFIX_SIBLING, WILDCARD_SIBLING]) {
        const id = await write(ORG, scope, GUESSED);
        const result = await ask();
        answers.set(`hidden in ${scope}`, own(result));
        expect(textOf(result)).not.toContain(GUESSED_VALUE);
        await removeChunk(id);
      }

      // In another org, in a scope of the same name.
      const otherId = await write(OTHER_ORG, OTHER_PATIENT, GUESSED);
      answers.set("in another org", own(await ask()));
      await removeChunk(otherId);

      // In another org under the reader's own scope path: only the org id tells these rows apart.
      const crossTenant = await insertChunk(OTHER_ORG, PATIENT, GUESSED);
      const crossRule = await db.convention.create({
        data: {
          orgId: OTHER_ORG,
          scopePath: PATIENT,
          kind: "convention",
          subject: "Safe contact",
          text: "Use the line ending 0174.",
          actorId: "seed",
        },
      });
      const crossNote = await db.workingNote.create({
        data: {
          orgId: OTHER_ORG,
          scopePath: PATIENT,
          agentId: "seed",
          task: "callbacks",
          kind: "status",
          body: "Calling 415-555-0174.",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      answers.set("in another org, under the same scope path", own(await ask()));
      await removeChunk(crossTenant);
      await db.convention.delete({ where: { id: crossRule.id } });
      await db.workingNote.delete({ where: { id: crossNote.id } });

      // Untagged: a bare-org row, which only a reader covering org root may read.
      const untaggedId = await insertChunk(ORG, null, GUESSED);
      answers.set("untagged", own(await ask()));
      await removeChunk(untaggedId);

      // Deleted through the product's delete. The control first: before the delete the reader can read it.
      const deletedId = await write(ORG, PATIENT_FORGET, GUESSED);
      const beforeDelete = await ask();
      expect(textOf(beforeDelete)).not.toContain(NO_READABLE_MATCH_NOTE);
      expect(beforeDelete._meta?.[UNHELD_VALUES_META_KEY]).toEqual([]);
      const deleter = {
        orgId: ORG,
        actor: {
          type: "agent" as const,
          id: `writer-${PATIENT_FORGET}`,
          capabilityToken: writers.get(PATIENT_FORGET)!,
        },
        origin: "mcp" as const,
      };
      const removal = await guardedMemory.removeFact(deleter, { groupId: ORG, factId: deletedId }, PATIENT_FORGET);
      expect(removal.removed).toBe(true);
      const afterDelete = await ask();
      answers.set("deleted", own(afterDelete));
      expect(textOf(afterDelete)).not.toContain(GUESSED_VALUE);

      // Erased: a restored copy of a row an erasure removed, which every read leaves out.
      const erasedId = await insertChunk(
        ORG,
        PATIENT,
        `Dana Whitfield's backup line: ${GUESSED}`,
        new Date(Date.now() - 60_000),
      );
      await recordSuppressions(db, ORG, "erasure-request-1", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
      await erasuresCompleted();
      answers.set("erased", own(await ask()));
      await removeChunk(erasedId);

      // Erased at volume: more suppressed copies than the check's first rounds read.
      const copies = Array.from({ length: 260 }, (_, i) => `c-erased-${i}`);
      await db.$executeRawUnsafe(
        `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
       SELECT 'c-erased-' || g, $1, $2, 'text', 'agent', 'seed', $3, $4::vector, $5::timestamp FROM generate_series(0, 259) g`,
        ORG,
        `Dana Whitfield's backup line: ${GUESSED}`,
        PATIENT,
        VECTOR,
        new Date(Date.now() - 60_000).toISOString().replace("Z", ""),
      );
      answers.set("erased, 260 copies", own(await ask()));
      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id = ANY (${copies}::text[])`;
      await db.erasureSuppression.deleteMany({ where: { orgId: ORG } });

      for (const [state, answer] of answers) expect(answer, state).toBe(neverWritten);
    });

    it("reads past any number of suppressed copies to a readable one, and makes no claim past the check's last round", async () => {
      const rows = { orgId: ORG, scope: PATIENT, includeUntagged: false };
      const [value] = specificValuesIn(GUESS);
      const restored = (count: number) =>
        db.$executeRawUnsafe(
          `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
         SELECT 'c-restored-' || g, $1, $2, 'text', 'agent', 'seed', $3, $4::vector, $5::timestamp FROM generate_series(1, ${count}) g`,
          ORG,
          `Dana Whitfield's backup line: ${GUESSED}`,
          PATIENT,
          VECTOR,
          new Date(Date.now() - 60_000).toISOString().replace("Z", ""),
        );
      await restored(300);
      await recordSuppressions(db, ORG, "erasure-request-2", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
      await erasuresCompleted();
      expect(await readableMemoryHolds(rows, [value!])).toEqual([false]);
      // Written after the erasure, so a deliberate new write, not a restored copy.
      await insertChunk(ORG, PATIENT, `Dana Whitfield's new line: ${GUESSED}`);
      expect(await readableMemoryHolds(rows, [value!])).toEqual([true]);

      await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id <> ALL (${baseline}::text[])`;
      await restored(70_000);
      // Every round runs to its end (the timeout is lifted, above), so this null is the check
      // giving up past its last round, not its last round timing out.
      const lifted = checkTimeoutsLifted;
      expect(await readableMemoryHolds(rows, [value!])).toBeNull();
      expect(
        checkTimeoutsLifted - lifted,
        "the check's statement timeout was not lifted: CHECK_TIMEOUT_SETTING no longer matches readable-values.ts",
      ).toBeGreaterThan(0);
    }, 120_000);

    it("does the same database work for restored copies an erasure removed by id as for a value never written", async () => {
      // An erasure records the id of every version it removes (services/memory/erasure-lineage.ts),
      // so a copy a restored backup puts back is known by its id. The check leaves such copies
      // out in SQL, before their text is read: however many hold the value, they cost a statement
      // nothing, and the time of the answer cannot say whether they exist.
      const { db: appDb } = await import("@/lib/db");
      const rows = { orgId: ORG, scope: PATIENT, includeUntagged: false };
      const [value] = specificValuesIn(GUESS);
      const work = async () => {
        const transactions = vi.spyOn(appDb, "$transaction");
        const erasureLists = vi.spyOn(appDb.erasureSuppression, "findMany");
        // Restored even when the check fails: a spy left in place is the one the next test's
        // spyOn returns, with this test's calls already on it.
        try {
          const started = performance.now();
          expect(await readableMemoryHolds(rows, [value!])).toEqual([false]);
          const ms = performance.now() - started;
          return { statements: transactions.mock.calls.length + erasureLists.mock.calls.length, ms };
        } finally {
          transactions.mockRestore();
          erasureLists.mockRestore();
        }
      };
      const measure = async () => {
        const runs = [];
        for (let run = 0; run < 15; run++) runs.push(await work());
        const ms = runs.map((r) => r.ms).sort((a, b) => a - b);
        return { statements: [...new Set(runs.map((r) => r.statements))], p50: ms[7]! };
      };
      const writtenAt = new Date(Date.now() - 60_000).toISOString().replace("Z", "");
      const OTHER_TEXT = "Backup line on file: 415-555-0199, do not leave voicemail mentioning pregnancy.";
      const restore = async (count: number, tag: string, content: string) => {
        await db.$executeRawUnsafe(
          `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
         SELECT 'c-byid-' || $5 || '-' || g, $1, $2, 'text', 'agent', 'seed', $3, $4::vector, $6::timestamp FROM generate_series(1, ${count}) g`,
          ORG,
          content,
          PATIENT,
          VECTOR,
          tag,
          writtenAt,
        );
        await db.$transaction((tx) =>
          recordErasedVersions(
            tx,
            ORG,
            "erasure-request-byid",
            Array.from({ length: count }, (_, i) => `c-byid-${tag}-${i + 1}`),
          ),
        );
        await erasuresCompleted();
      };
      const removeRestored = (tag: string) =>
        db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${ORG} AND id LIKE ${`c-byid-${tag}-%`}`;

      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "erasure-request-byid", ["c-some-other-version"]));
      await erasuresCompleted();
      const empty = await measure();
      // The same 260 restored copies each time; only how many of them hold the value changes.
      await restore(260, "other", OTHER_TEXT);
      const never = await measure();
      await removeRestored("other");
      await restore(259, "other", OTHER_TEXT);
      await restore(1, "one", `Backup line on file: ${GUESSED}`);
      const one = await measure();
      await removeRestored("other");
      await restore(259, "many", `Backup line on file: ${GUESSED}`);
      const many = await measure();
      process.stderr.write(
        `[no-readable-match] 260 copies erased by id: none holds the value ${never.statements} statements p50 ${never.p50.toFixed(1)} ms; ` +
          `1 holds it ${one.statements} p50 ${one.p50.toFixed(1)} ms; all 260 hold it ${many.statements} p50 ${many.p50.toFixed(1)} ms ` +
          `(no copies: ${empty.statements} p50 ${empty.p50.toFixed(1)} ms)\n`,
      );
      expect({ one: one.statements, many: many.statements, empty: empty.statements }).toEqual({
        one: never.statements,
        many: never.statements,
        empty: never.statements,
      });

      // A copy whose id no erasure recorded, known only by the name it holds: the suppression
      // list is read whether or not a version matched, so one such copy issues no statement more.
      await removeRestored("one");
      await removeRestored("many");
      await recordSuppressions(db, ORG, "erasure-request-byname", {
        emails: [],
        names: ["Dana Whitfield"],
        contactIds: [],
      });
      await erasuresCompleted();
      const nameBaseline = await measure();
      await insertChunk(ORG, PATIENT, `Dana Whitfield's backup line: ${GUESSED}`, new Date(Date.now() - 60_000));
      const byName = await measure();
      process.stderr.write(
        `[no-readable-match] 1 copy erased by name only: ${byName.statements} statements p50 ${byName.p50.toFixed(1)} ms (none: ${nameBaseline.statements} p50 ${nameBaseline.p50.toFixed(1)} ms)\n`,
      );
      expect(byName.statements).toEqual(nameBaseline.statements);
      expect(never.statements).toHaveLength(1);
    }, 120_000);

    it("makes no claim, and reads no memory, while the org's erasures are not recorded as applied", async () => {
      // A restore that put the suppression list back over older content leaves the list with no
      // receipt until the re-apply runs (services/memory/erasure-reapply.ts, completeRestore).
      const { db: appDb } = await import("@/lib/db");
      const rows = { orgId: ORG, scope: PATIENT, includeUntagged: false };
      const [value] = specificValuesIn(GUESS);
      expect(await readableMemoryHolds(rows, [value!])).toEqual([false]);
      await recordSuppressions(db, ORG, "erasure-request-restored", {
        emails: [],
        names: ["Dana Whitfield"],
        contactIds: [],
      });
      const transactions = vi.spyOn(appDb, "$transaction");
      try {
        expect(transactions).not.toHaveBeenCalled();
        expect(await readableMemoryHolds(rows, [value!])).toBeNull();
        expect(transactions).not.toHaveBeenCalled();
      } finally {
        transactions.mockRestore();
      }
      const answer = await ask();
      expect(textOf(answer)).not.toContain(NO_READABLE_MATCH_NOTE);
      expect(answer._meta?.[UNHELD_VALUES_META_KEY]).toBeUndefined();
      await erasuresCompleted();
      expect(await readableMemoryHolds(rows, [value!])).toEqual([false]);
      // Applied entries cover only themselves: one more entry, put back by a restore, is not covered.
      await recordSuppressions(db, ORG, "erasure-request-restored-2", {
        emails: [],
        names: ["Elena Park"],
        contactIds: [],
      });
      expect(await readableMemoryHolds(rows, [value!])).toBeNull();
    });

    it("reads a version written after its id went on the suppression list, as the read paths do", async () => {
      const rows = { orgId: ORG, scope: PATIENT, includeUntagged: false };
      const [value] = specificValuesIn(GUESS);
      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "erasure-request-later", ["c-written-later"]));
      await erasuresCompleted();
      await db.$executeRawUnsafe(
        `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
       VALUES ('c-written-later', $1, $2, 'text', 'agent', 'seed', $3, $4::vector, $5::timestamp)`,
        ORG,
        GUESSED,
        PATIENT,
        VECTOR,
        new Date(Date.now() + 60_000).toISOString().replace("Z", ""),
      );
      expect(await readableMemoryHolds(rows, [value!])).toEqual([true]);
      await db.$executeRaw`UPDATE memory_chunks SET "createdAt" = "createdAt" - interval '1 day' WHERE "orgId" = ${ORG} AND id = 'c-written-later'`;
      expect(await readableMemoryHolds(rows, [value!])).toEqual([false]);
    });

    it("looks each version up in the suppression list's unique index, one probe per version", async () => {
      const { erasedByVersionDigestSql, versionIdDigestSql } = await import("@/services/memory/erasure-suppression");
      const { Prisma } = await import("@/lib/generated/prisma/client");
      const { flattenSql } = await import("@/services/access/scope-containment");
      const ids = Array.from({ length: 300 }, (_, i) => `c-planned-${i}`);
      await db.$executeRawUnsafe(
        `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
       SELECT 'c-planned-' || g, $1, 'restored', 'text', 'agent', 'seed', $2, $3::vector, (now() AT TIME ZONE 'UTC') - interval '1 hour' FROM generate_series(0, 299) g`,
        ORG,
        PATIENT,
        VECTOR,
      );
      await db.$transaction((tx) => recordErasedVersions(tx, ORG, "erasure-request-planned", ids));
      await erasuresCompleted();
      // Plan against statistics that describe the list as it now stands. Autovacuum analyzes the
      // list whenever earlier tests' writes cross its threshold, so without this the plan read
      // whatever size the list had then: statistics taken while it held a few rows put it on one
      // page, and a probe per version became a Seq Scan of that page, which the planner rightly
      // prices below an index probe (a local CI run on 2026-10-29, "Seq Scan: "). Reproduced:
      // stats from 3 rows, then these 300 written, plans a Seq Scan; analyzed at 300, an Index Scan
      // (cost 8.3 against 11.1 for the scan). The OFFSET 0 is what keeps the lookup per version
      // whatever the statistics say; the index probe follows once they are current.
      await db.$executeRaw`ANALYZE erasure_suppressions`;
      const query = Prisma.sql`EXPLAIN (FORMAT JSON) SELECT v.id FROM (
        SELECT memory_chunks.id, memory_chunks."createdAt" AS created_at,
               ${versionIdDigestSql(ORG, Prisma.sql`memory_chunks.id`)} AS version_digest
        FROM memory_chunks WHERE memory_chunks."orgId" = ${ORG} OFFSET 0
      ) v WHERE NOT ${erasedByVersionDigestSql(ORG, Prisma.sql`v.version_digest`, Prisma.sql`v.created_at`)}`;
      const [plan] = await db.$queryRaw<{ "QUERY PLAN": unknown }[]>(...flattenSql(query));
      const lookups: string[] = [];
      // `perVersion`: the node runs inside a SubPlan, once per version, never in a join over the list.
      const walk = (node: unknown, perVersion: boolean): void => {
        if (Array.isArray(node)) return node.forEach((n) => walk(n, perVersion));
        if (node === null || typeof node !== "object") return;
        const fields = node as Record<string, unknown>;
        const inSubPlan = perVersion || fields["Parent Relationship"] === "SubPlan";
        if (fields["Relation Name"] === "erasure_suppressions")
          lookups.push(`${inSubPlan ? "per version" : "joined"} ${fields["Node Type"]}: ${fields["Index Cond"] ?? ""}`);
        Object.values(fields).forEach((v) => walk(v, inSubPlan));
      };
      walk(plan!["QUERY PLAN"], false);
      expect(lookups).toHaveLength(1);
      expect(lookups[0]).toMatch(/^per version Index (Only )?Scan: .*digest = v\.version_digest/);
    });

    it("answers the same for a superseded version as for the version that replaced it alone", async () => {
      const replacement = "[t176 2026-03-08T10:00] Elena Park (patient): Use the portal only from now on.";
      const replacementId = await write(ORG, PATIENT_SUB, replacement);
      const alone = own(await ask());
      const oldId = await insertChunk(ORG, PATIENT_SUB, GUESSED);
      await db.factEdge.create({
        data: {
          orgId: ORG,
          kind: "supersedes",
          fromId: replacementId,
          toId: oldId,
          scopePath: PATIENT_SUB,
          actorType: "agent",
          actorId: "seed",
        },
      });
      const superseded = await ask();
      // The same facts and the same note. Only the order may move: the superseded version's
      // place goes to the version that replaced it (services/memory/current-versions.ts).
      const lines = (answer: string) =>
        (JSON.parse(answer) as { content: { text?: string }[] }).content
          .map((c) => c.text ?? "")
          .join("\n")
          .split("\n")
          .filter((line) => !line.startsWith("revision: "))
          .sort();
      expect(lines(own(superseded))).toEqual(lines(alone));
      // The revision is a digest of the answer's text, so it moves with the order; the note's own field does not.
      const unheld = (answer: string) =>
        (JSON.parse(answer) as { meta: Record<string, unknown> }).meta[UNHELD_VALUES_META_KEY];
      expect(unheld(own(superseded))).toEqual(unheld(alone));
      expect(textOf(superseded)).toContain(NO_READABLE_MATCH_NOTE);
      await db.factEdge.deleteMany({ where: { orgId: ORG, toId: oldId } });
      await removeChunk(oldId);
      await removeChunk(replacementId);
    });

    it("gives no note when the reader can read the value: in its scope, below it, in a rule, in a live note, or on the page", async () => {
      const held = async (state: string) => {
        const result = await ask();
        expect(textOf(result), state).not.toContain(NO_READABLE_MATCH_NOTE);
        expect(result._meta?.[UNHELD_VALUES_META_KEY], state).toEqual([]);
      };

      for (const scope of [PATIENT, PATIENT_SUB]) {
        const id = await write(ORG, scope, GUESSED);
        await held(`a stored version in ${scope}`);
        await removeChunk(id);
      }

      const rule = await db.convention.create({
        data: {
          orgId: ORG,
          scopePath: PATIENT,
          kind: "convention",
          subject: "Safe contact",
          text: "Use the temporary line ending 0174 for callbacks.",
          actorId: "seed",
        },
      });
      await held("a rule in force");
      await db.convention.delete({ where: { id: rule.id } });

      const note = await db.workingNote.create({
        data: {
          orgId: ORG,
          scopePath: PATIENT_SUB,
          agentId: "seed",
          task: "callbacks",
          kind: "status",
          body: "Calling 415-555-0174 next.",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      await held("a live working note");
      await db.workingNote.delete({ where: { id: note.id } });

      // A graph fact this read served, with no stored version behind it.
      const { toGid } = await import("@/services/memory/graphiti-store");
      service.graphFacts.set(toGid(PATIENT), ["Elena's temporary safe line ended in 0174."]);
      const onPage = await ask();
      expect(textOf(onPage)).toContain("ended in 0174");
      expect(textOf(onPage)).not.toContain(NO_READABLE_MATCH_NOTE);
      expect(onPage._meta?.[UNHELD_VALUES_META_KEY]).toEqual([]);
      service.graphFacts.clear();
    });

    it("does not count a rule or note the reader cannot see: retired, replaced, elsewhere, expired or released", async () => {
      const baseline = own(await ask());
      const text = "Use the temporary line ending 0174 for callbacks.";
      const rules = [
        { scopePath: PATIENT, retiredAt: new Date() },
        { scopePath: CLINICAL },
        { scopePath: PREFIX_SIBLING },
      ];
      for (const rule of rules) {
        const row = await db.convention.create({
          data: { orgId: ORG, kind: "convention", subject: "Safe contact", text, actorId: "seed", ...rule },
        });
        expect(own(await ask()), JSON.stringify(rule)).toBe(baseline);
        await db.convention.delete({ where: { id: row.id } });
      }
      const replaced = await db.convention.create({
        data: { orgId: ORG, scopePath: PATIENT, kind: "convention", subject: "Safe contact", text, actorId: "seed" },
      });
      const replacing = await db.convention.create({
        data: {
          orgId: ORG,
          scopePath: PATIENT,
          kind: "convention",
          subject: "Safe contact",
          text: "Portal only.",
          actorId: "seed",
          supersedesId: replaced.id,
        },
      });
      const withReplacement = await ask();
      expect(textOf(withReplacement)).toContain(NO_READABLE_MATCH_NOTE);
      await db.convention.delete({ where: { id: replacing.id } });
      await db.convention.delete({ where: { id: replaced.id } });

      const notes = [
        { scopePath: PATIENT, expiresAt: new Date(Date.now() - 60_000) },
        { scopePath: PATIENT, expiresAt: new Date(Date.now() + 60 * 60 * 1000), releasedAt: new Date() },
        { scopePath: CLINICAL, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      ];
      for (const note of notes) {
        const row = await db.workingNote.create({
          data: {
            orgId: ORG,
            agentId: "seed",
            task: "callbacks",
            kind: "status",
            body: "Calling 415-555-0174 next.",
            ...note,
          },
        });
        expect(own(await ask()), JSON.stringify(note)).toBe(baseline);
        await db.workingNote.delete({ where: { id: row.id } });
      }
    });

    it("names which values are unheld when the question names several, and gives no note for a question naming none", async () => {
      const several = await ask("I still have 415-555 written down. Was the deleted rest 0174?");
      expect(several._meta?.[UNHELD_VALUES_META_KEY]).toEqual([1]);
      expect(textOf(several)).toContain(NO_READABLE_MATCH_NOTE);

      const none = await ask("What contact preference is active for Elena?");
      expect(none._meta?.[UNHELD_VALUES_META_KEY]).toEqual([]);
      expect(textOf(none)).not.toContain(NO_READABLE_MATCH_NOTE);
    });

    it("makes no claim when the read could reach graph content no exhaustive search covers", async () => {
      // A connector in the reader's scope writes items to the graph store only.
      const source = await db.source.create({
        data: { orgId: ORG, type: "slack", externalId: "C-NRM", name: "#care", scopePath: PATIENT_SUB },
      });
      const withConnector = await ask();
      expect(textOf(withConnector)).not.toContain(NO_READABLE_MATCH_NOTE);
      expect(withConnector._meta?.[UNHELD_VALUES_META_KEY]).toBeUndefined();
      await db.source.delete({ where: { id: source.id } });

      // A connector in another org, under the reader's own scope path, changes nothing.
      const otherOrgSource = await db.source.create({
        data: { orgId: OTHER_ORG, type: "slack", externalId: "C-NRM3", name: "#care", scopePath: PATIENT_SUB },
      });
      expect(textOf(await ask())).toContain(NO_READABLE_MATCH_NOTE);
      await db.source.delete({ where: { id: otherOrgSource.id } });

      // A connector somewhere the reader cannot read changes nothing.
      const elsewhere = await db.source.create({
        data: { orgId: ORG, type: "slack", externalId: "C-NRM2", name: "#clinic", scopePath: CLINICAL },
      });
      expect(textOf(await ask())).toContain(NO_READABLE_MATCH_NOTE);
      await db.source.delete({ where: { id: elsewhere.id } });

      // A reader covering org root reaches the entity seeds written under the bare org id.
      const fromRoot = await ask(GUESS, rootReader, ROOT);
      expect(textOf(fromRoot)).not.toContain(NO_READABLE_MATCH_NOTE);
      expect(fromRoot._meta?.[UNHELD_VALUES_META_KEY]).toBeUndefined();
    });

    it("applies the same rule in Postgres as in JavaScript", async () => {
      const cases: [string, string][] = [
        ["direct mobile 415-555-0161 only", "Was it 415-something?"],
        ["direct mobile 415-555-0161 only", "Was it 415-555-0188?"],
        ["current cell 617-555-0104", "Did it start with 617-555-01?"],
        ["(415) 555-0174", "did it end in 4155550174?"],
        ["415,555,0174", "did it end in 4155550174?"],
        ["415    555    0174", "did it end in 4155550174?"],
        ["room 01, bed 74", "did it end in 0174?"],
        ["the HARBOR\n  house desk", "Was it at Harbor House?"],
        ["Harbor, House", "Was it at Harbor House?"],
        ["Harbor Housekeeping", "Was it at Harbor House?"],
        ["Note: call (ext. 4)+ [desk] $5 a|b ^c? \\d* today", 'Did it say "call (ext. 4)+ [desk] $5 a|b ^c? \\d*"?'],
        ["call ext 4 desk 5 ab c d", 'Did it say "call (ext. 4)+ [desk] $5 a|b ^c? \\d*"?'],
        ["CAFÉ ROSA", "Was it Café Rosa?"],
        ["415–555–0174", "did it end in 4155550174?"],
        ["415\u00a0555\u00a00174", "did it end in 4155550174?"],
        ["Harbor\u00a0House", "Was it at Harbor House?"],
        ["Monday, October 5", "Was it Monday October?"],
        ["x\ufffdy", 'Was it "x\ud800y"?'],
      ];
      for (const [text, question] of cases) {
        const [value] = specificValuesIn(question);
        const [row] = await db.$queryRawUnsafe<{ holds: boolean }[]>(
          "SELECT $1::text ~ $2::text AS holds",
          text,
          value!.pattern,
        );
        expect(row!.holds, `${question} in ${text}`).toBe(textHoldsValue(text, value!));
      }
    });

    it("holds every spelling in the case table in Postgres as JavaScript does, as a stored version and as a rule", async () => {
      const rows = { orgId: ORG, scope: PATIENT, includeUntagged: false };
      for (const { name, question, stored, holds } of SPELLING_CASES) {
        const values = specificValuesIn(question);
        const inJavaScript = values.map((value) => textHoldsValue(stored, value));
        expect(inJavaScript.every(Boolean), name).toBe(holds);
        const id = await insertChunk(ORG, PATIENT, stored);
        expect(await readableMemoryHolds(rows, values), `${name}, as a version`).toEqual(inJavaScript);
        await removeChunk(id);
        const rule = await db.convention.create({
          data: { orgId: ORG, scopePath: PATIENT, kind: "convention", subject: "Rule", text: stored, actorId: "seed" },
        });
        expect(await readableMemoryHolds(rows, values), `${name}, as a rule`).toEqual(inJavaScript);
        await db.convention.deleteMany({ where: { orgId: ORG, id: rule.id } });
      }
    }, 120_000);

    // Spellings beyond the case table, held and not held,
    // through the Postgres check as a stored version, against JavaScript's answer.
    it("QA: answers the extra spellings in Postgres as JavaScript does", async () => {
      const rows = { orgId: ORG, scope: PATIENT, includeUntagged: false };
      const cases: [string, string][] = [
        ["Did Maya Bennett call?", "Bennett, Maya called at 4."],
        ["Did Maya Bennett call?", "[Maya](mailto:m@x.io) Bennett called."],
        ["Did Maya Bennett call?", "Bennett M called."],
        ["Was it Jean-Luc Picard?", "JeanLuc Picard signed."],
        ["Was it Siobhan O'Brien?", "Siobhan O\u2019Brien signed."],
        ["Was it Jose Garcia?", "JOS\u00c9 GARC\u00cdA signed."],
        ["Was it Johann Strauss?", "JOHANN STRAU\u1e9e"],
        ["Was it Istanbul Office?", "\u0130STANBUL OFFICE"],
        [
          'Was it "\u039f\u03b4\u03c5\u03c3\u03c3\u03ad\u03b1\u03c2 \u0395\u03bb\u03cd\u03c4\u03b7\u03c2"?',
          "\u039f\u0394\u03a5\u03a3\u03a3\u0395\u0391\u03a3 \u0395\u039b\u03a5\u03a4\u0397\u03a3",
        ],
        ["Was it Nguyen Van An?", "Nguye\u0302\u0303n Va\u0306n An"],
        ["Was it Lukasz Nowak?", "\u0141ukasz Nowak"],
        ["Was the deal 1,500,000?", "The deal was 1\u202f500\u202f000."],
        ["Was the deal 1,500,000?", "The deal was 15,00,000."],
        ["Was the deal 1,500,000?", "The deal was $1.5M."],
        ["Was it 10/15/2026?", "On 15.10.2026 we met."],
        ["Was it 10/15/2026?", "On Oct 15, 2026 we met."],
        ["Was it 415-555-0174?", "415\u2212555\u22120174"],
        ["Was it 415-555-0174?", "415\u3000555\u30000174"],
        ["Did room 312 flood?", "Room \u2462\u2460\u2461 flooded"],
        ["Did room 312 flood?", "Room \u00b3\u00b9\u00b2 flooded"],
        ['Did it say "fiscal"?', "\ufb01scal"],
        ["Did Maya Bennett call?", "Mayan bennettite"],
        ["Was it Cedar Bridge?", "cedar wood bridge"],
      ];
      for (const [question, stored] of cases) {
        const values = specificValuesIn(question);
        const inJavaScript = values.map((value) => textHoldsValue(stored, value));
        const id = await insertChunk(ORG, PATIENT, stored);
        expect(await readableMemoryHolds(rows, values), `${question} in ${stored}`).toEqual(inJavaScript);
        await removeChunk(id);
      }
    }, 120_000);

    it("checks a real org's volume in one pass, at a bounded multiple of hashing its rows", async () => {
      // A real org's row counts on 2026-10-15: 9,637 stored versions, 150 rules, 1,804 working notes.
      const VOLUME_ORG = "noreadablematchvolume";
      const VOLUME_ROOT = `org_${VOLUME_ORG}`;
      const VOLUME_SCOPE = `${VOLUME_ROOT}.eng`;
      await db.org.deleteMany({ where: { id: VOLUME_ORG } });
      await db.org.create({ data: { id: VOLUME_ORG, name: VOLUME_ORG } });
      await db.scope.create({ data: { orgId: VOLUME_ORG, path: VOLUME_ROOT, name: "root" } });
      await db.scope.create({ data: { orgId: VOLUME_ORG, path: VOLUME_SCOPE, name: "eng" } });
      const words = "the review found a rework on PR merge item ada builder reviewer board scope test fix deploy".split(
        " ",
      );
      const sentence = (i: number) =>
        Array.from({ length: 160 }, (_, k) =>
          k % 23 === 0 ? `#${(i * 7919 + k) % 1000}` : words[(i + k) % words.length],
        ).join(" ");
      await db.$executeRawUnsafe(
        `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","scopePath","embedding","createdAt")
       SELECT 'vol-' || g, $1, $2 || ' ' || g, 'text', 'agent', $3, $4::vector, (now() AT TIME ZONE 'UTC') FROM generate_series(1, 9637) g`,
        VOLUME_ORG,
        sentence(1),
        VOLUME_SCOPE,
        VECTOR,
      );
      await db.convention.createMany({
        data: Array.from({ length: 150 }, (_, i) => ({
          orgId: VOLUME_ORG,
          scopePath: VOLUME_SCOPE,
          kind: "convention" as const,
          subject: `Rule ${i}`,
          text: sentence(i),
          actorId: "seed",
        })),
      });
      await db.workingNote.createMany({
        data: Array.from({ length: 1804 }, (_, i) => ({
          orgId: VOLUME_ORG,
          scopePath: VOLUME_SCOPE,
          agentId: "seed",
          task: `task ${i}`,
          kind: "status" as const,
          body: sentence(i).slice(0, 280),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        })),
      });
      // Eight values none of those rows holds: every one is a full scan, the worst case.
      const values = specificValuesIn(
        "Was it 415-555-0174, 0186, 617-555-0140, Cedar Bridge Recovery House, Harbor Light Center, Juniper House, “ask for Nia”, or 97531?",
      );
      expect(values).toHaveLength(8);
      const rows = { orgId: VOLUME_ORG, scope: VOLUME_SCOPE, includeUntagged: false };
      const median = (ms: number[]) => [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)]!;
      const { db: appDb } = await import("@/lib/db");
      type Statement = [TemplateStringsArray, ...unknown[]];
      const statement = (strings: TemplateStringsArray, ...values: unknown[]): Statement => [strings, ...values];
      /** One check of `values` over `rows`, with what it sent: its batches, its lifted timeouts and its stored-version statements. */
      const checkOnce = async () => {
        const transactions = vi.spyOn(appDb, "$transaction");
        const raws = vi.spyOn(appDb, "$queryRaw");
        const liftedBefore = checkTimeoutsLifted;
        try {
          expect(await readableMemoryHolds(rows, values)).toEqual(new Array(8).fill(false));
          const versions = raws.mock.calls.filter(
            ([strings]) => Array.isArray(strings) && strings.join("$").includes("AS match_text"),
          ) as unknown as Statement[];
          return { batches: transactions.mock.calls.length, lifted: checkTimeoutsLifted - liftedBefore, versions };
        } finally {
          transactions.mockRestore();
          raws.mockRestore();
        }
      };
      /** How long Postgres took to run `sql` (EXPLAIN ANALYZE's Execution Time, per-node timing off): no round trip and no client in it. */
      const serverMs = async ([strings, ...values]: Statement) => {
        const prefixed = [
          `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${strings[0]}`,
          ...strings.slice(1),
        ] as string[] & { raw: readonly string[] };
        prefixed.raw = [...prefixed];
        const [row] = await db.$queryRaw<{ "QUERY PLAN": unknown }[]>(
          prefixed as unknown as TemplateStringsArray,
          ...values,
        );
        const plan = row!["QUERY PLAN"];
        return ((typeof plan === "string" ? JSON.parse(plan) : plan) as { "Execution Time": number }[])[0]![
          "Execution Time"
        ];
      };
      // A plain pass: every row of the org read and hashed once.
      const plainPass = statement`SELECT sum(length(md5(content))) FROM memory_chunks WHERE "orgId" = ${VOLUME_ORG}`;
      /**
       * The check's stored-version statement over a plain pass, both timed inside Postgres and
       * taken in turns, so both see the same load. Wall-clock is not a measure here: at load
       * 25-400 the same check took 300 ms to past its 1 s statement timeout, and its five round
       * trips and the client's work grow with load where one plain pass does not (client-side
       * ratio 8.9 at load 25, 26-37 at load 150-280). Also pins the shape: one stored-version
       * statement and one for rules and notes, however many values, each under the lifted timeout.
       */
      const measure = async (runs: number) => {
        const ratios: number[] = [];
        const wall: number[] = [];
        for (let run = 0; run < runs; run++) {
          const started = performance.now();
          const sent = await checkOnce();
          wall.push(performance.now() - started);
          expect(
            { batches: sent.batches, versionStatements: sent.versions.length },
            "the check is one stored-version statement and one for rules and notes",
          ).toEqual({ batches: 2, versionStatements: 1 });
          expect(
            sent.lifted,
            "the check's statement timeout was not lifted on both statements: CHECK_TIMEOUT_SETTING no longer matches readable-values.ts",
          ).toBe(2);
          ratios.push((await serverMs(sent.versions[0]!)) / (await serverMs(plainPass)));
        }
        return { ratios, ratio: median(ratios), wall: median(wall), worstWall: Math.max(...wall) };
      };
      await checkOnce();
      await serverMs(plainPass);
      const visible = await measure(15);
      process.stderr.write(
        `[no-readable-match] real-org volume, 8 unheld values: wall p50 ${visible.wall.toFixed(0)} ms, max ${visible.worstWall.toFixed(0)} ms; ` +
          `stored-version statement over a plain pass, in Postgres: p50 ${visible.ratio.toFixed(1)}, runs ${visible.ratios.map((r) => r.toFixed(1)).join(" ")}\n`,
      );
      expect(visible.ratio).toBeLessThan(CHECK_OVER_PLAIN_PASS);
      // The tail too: a check that is slow on some calls only (a plan that flips, a list
      // reloaded every other call) fails here, while four load spikes in fifteen do not (at
      // load 108-207, 1-2 of 15 runs went over).
      expect(visible.ratios.filter((r) => r >= CHECK_OVER_PLAIN_PASS).length).toBeLessThanOrEqual(4);

      // The whole read, with and without the check: it starts beside the store reads.
      const token = await mint(VOLUME_ORG, "volume-reader", VOLUME_SCOPE, "read");
      const ctx = {
        orgId: VOLUME_ORG,
        actor: { type: "agent" as const, id: "volume-reader", capabilityToken: token },
        origin: "mcp" as const,
      };
      const question =
        "Was it 415-555-0174, 0186, 617-555-0140, Cedar Bridge Recovery House, Harbor Light Center, Juniper House, “ask for Nia”, or 97531?";
      const read = async (checkNamedValues: boolean) => {
        const started = performance.now();
        await guardedMemory.retrieve(ctx, { groupId: VOLUME_ORG, query: question, limit: 10 }, VOLUME_SCOPE, {
          checkNamedValues,
        });
        return performance.now() - started;
      };
      await read(true);
      const withCheck: number[] = [];
      const without: number[] = [];
      for (let run = 0; run < 9; run++) {
        withCheck.push(await read(true));
        without.push(await read(false));
      }
      process.stderr.write(
        `[no-readable-match] real-org volume, whole read: p50 ${median(withCheck).toFixed(0)} ms with the check, ${median(without).toFixed(0)} ms without\n`,
      );
      const one = specificValuesIn(GUESS);
      const single: number[] = [];
      for (let run = 0; run < 9; run++) {
        const started = performance.now();
        await readableMemoryHolds(rows, one);
        single.push(performance.now() - started);
      }
      process.stderr.write(
        `[no-readable-match] real-org volume, 1 unheld value: p50 ${median(single).toFixed(0)} ms\n`,
      );

      // The same rows in a scope the reader cannot read cost the check almost nothing: the
      // pattern is matched only against what the reader may see. Measured the same way, in turns.
      const HIDDEN = `${VOLUME_ROOT}.elsewhere`;
      await db.scope.create({ data: { orgId: VOLUME_ORG, path: HIDDEN, name: "elsewhere" } });
      await db.$executeRaw`UPDATE memory_chunks SET "scopePath" = ${HIDDEN} WHERE "orgId" = ${VOLUME_ORG}`;
      const hidden = await measure(9);
      process.stderr.write(
        `[no-readable-match] real-org volume in a hidden scope, 8 values: wall p50 ${hidden.wall.toFixed(0)} ms; over a plain pass, in Postgres: p50 ${hidden.ratio.toFixed(1)}\n`,
      );
      expect(hidden.ratio).toBeLessThan(visible.ratio / 2);
      await db.org.deleteMany({ where: { id: VOLUME_ORG } });
    }, 120_000);
  },
);
