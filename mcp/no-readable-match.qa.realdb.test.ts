// Database-gated like mcp/no-readable-match.realdb.test.ts,
// whose harness this copies: without QA_DATABASE_URL every test here is skipped.
//
// Attacks on the oracle question: can a reader learn whether a value exists where it cannot
// read, or only in content an erasure suppresses, from the answer, its `_meta`, its revision
// or its time?
//  - rows of about 1 MB holding the value, in a sibling, a prefix sibling, a `_` sibling,
//    another org under the reader's own path and the untagged rows, as versions, rules and
//    live notes: the answer is the same to the byte and keeps its note, which it could not if
//    the pattern touched them (a match drops the note, and so does the 1 s timeout their size
//    can cost); removing the scope or org filter, or the `OFFSET 0` fence, fails it;
//  - copies an erasure suppresses, in the reader's own scope: the answer is the same, but the
//    database work was not (measured once: 2 statements never written, 3 with one erased
//    copy, 5 with 260). Such copies come back only with a backup restore, the restore's re-apply removes them, and the
//    check makes no claim until it has run. Pinned below: after the re-apply, 1 and 260 copies
//    cost what never-written costs; before it, no claim and no read; and the residual left;
//  - a value whose parts sit in two readable versions draws the note (behaviour, not a defect).
//
// Real: the hosted MCP endpoint over a socket, check() against live capability tokens,
// memory_ingest's write into Postgres, the vector read and the value check on Postgres. A
// fake memory service answers embeddings with one fixed vector and accepts graph writes.
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
import { specificValuesIn, type SpecificValue } from "@/services/memory/specific-values";
import { deleteOrgsWithRetry } from "@/lib/org-cleanup.testsupport";

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
const ORG = "qanrmoracle";
const OTHER_ORG = "qanrmoracleother";
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

describe.skipIf(!QA_URL)("the no-readable-match note is no oracle, at volume", () => {
  const service = new SeededGraphMemoryService();
  let db: PrismaClient;
  let mcpUrl: string;
  let closeMcp: () => Promise<void>;
  let recordSuppressions: (typeof import("@/services/memory/erasure-suppression"))["recordSuppressions"];
  let markApplied: (typeof import("@/services/memory/erasure-suppression"))["markApplied"];
  /** That the erasure `requestId` recorded has been carried out, as a completed erasure request records it. */
  const erasureCompleted = (requestId: string) => markApplied(db, ORG, requestId, { requestIds: [requestId] });
  let completeRestore: (typeof import("@/services/memory/erasure-reapply"))["completeRestore"];
  let readableMemoryHolds: (typeof import("@/services/memory/readable-values"))["readableMemoryHolds"];
  let reader = "";
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
    ({ recordSuppressions, markApplied } = await import("@/services/memory/erasure-suppression"));
    ({ completeRestore } = await import("@/services/memory/erasure-reapply"));
    ({ readableMemoryHolds } = await import("@/services/memory/readable-values"));
    const { startMcpTestServer } = await import("./http-test-server");
    const mcp = await startMcpTestServer();
    mcpUrl = mcp.url;
    closeMcp = mcp.close;

    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
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
    // The admin a restore's re-apply runs as (services/memory/erasure-reapply.ts, completeRestore).
    const root = await db.scope.findFirstOrThrow({ where: { orgId: ORG, path: ROOT } });
    await db.user.create({
      data: {
        id: "qa-nrm-admin",
        orgId: ORG,
        email: "admin@qa-nrm.test",
        role: "admin",
        clerkId: "clerk-qa-nrm-admin",
      },
    });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: "qa-nrm-admin", permission: "admin" },
    });
    for (const content of VISIBLE) baseline.push(await write(ORG, PATIENT, content));
  }, 120_000);

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
  });

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await closeMcp?.();
    await service.stop();
    await deleteOrgsWithRetry(db, { where: { id: { in: [ORG, OTHER_ORG] } } });
    await db.$disconnect();
  });

  /**
   * Rows that would cost the check far more than its 1,000 ms statement timeout if its
   * pattern were ever matched against them: each about 1 MB of near-misses, ending in the
   * guessed value. The check finishing with its note, the same to the byte, shows the
   * pattern never touched them (a timeout would drop the note, and a match would too).
   */
  async function haystack(orgId: string, scopePath: string | null, rows: number, tag: string): Promise<void> {
    await db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","createdAt")
       SELECT 'hay-' || $4 || '-' || g, $1, repeat('415-555-017 9 safe line ', 45000) || $2 || ' ' || g, 'text', 'agent', 'seed', $3, (now() AT TIME ZONE 'UTC')
       FROM generate_series(1, ${rows}) g`,
      orgId,
      GUESSED,
      scopePath,
      tag,
    );
  }

  it("answers the same, with its note, when ~1 MB rows holding the value fill a sibling, a prefix sibling, a `_` sibling, another org and the untagged rows", async () => {
    const neverWritten = await ask();
    expect(textOf(neverWritten)).toContain(NO_READABLE_MATCH_NOTE);
    const t0 = performance.now();
    await ask();
    const baseMs = performance.now() - t0;

    await haystack(ORG, CLINICAL, 120, "sib");
    await haystack(ORG, PREFIX_SIBLING, 60, "pre");
    await haystack(ORG, WILDCARD_SIBLING, 60, "wild");
    await haystack(ORG, null, 60, "untagged");
    await haystack(OTHER_ORG, PATIENT, 120, "other");
    // Rules and live notes too, in a sibling and in another org under the reader's own path.
    for (const [orgId, scopePath] of [
      [ORG, CLINICAL],
      [ORG, PREFIX_SIBLING],
      [OTHER_ORG, PATIENT],
    ] as const) {
      await db.$executeRawUnsafe(
        `INSERT INTO conventions ("id","orgId","scopePath","kind","subject","text","actorId")
         SELECT 'hay-rule-' || $1 || '-' || $2 || '-' || g, $1, $2, 'convention', 'Safe contact ' || g, repeat('415-555-017 9 safe line ', 45000) || $3, 'seed'
         FROM generate_series(1, 40) g`,
        orgId,
        scopePath,
        GUESSED,
      );
      await db.$executeRawUnsafe(
        `INSERT INTO working_notes ("id","orgId","scopePath","agentId","task","kind","body","expiresAt")
         SELECT 'hay-note-' || $1 || '-' || $2 || '-' || g, $1, $2, 'seed', 'callbacks ' || g, 'status', repeat('415-555-017 9 safe line ', 45000) || $3, (now() AT TIME ZONE 'UTC') + interval '1 hour'
         FROM generate_series(1, 40) g`,
        orgId,
        scopePath,
        GUESSED,
      );
    }
    // The same rows read in full by a reader who may read them: they cost the check its timeout.
    const [value] = specificValuesIn(GUESS);
    const t1 = performance.now();
    const asRoot = await readableMemoryHolds({ orgId: ORG, scope: undefined, includeUntagged: true }, [value!]).catch(
      () => "threw",
    );
    const rootMs = performance.now() - t1;

    const t2 = performance.now();
    const withHay = await ask();
    const hayMs = performance.now() - t2;
    process.stderr.write(
      `[qa-nrm] reader ask: ${baseMs.toFixed(0)} ms before, ${hayMs.toFixed(0)} ms with 660 hidden ~1 MB rows; ` +
        `the root check over them: ${rootMs.toFixed(0)} ms -> ${JSON.stringify(asRoot)}\n`,
    );
    expect(own(withHay)).toBe(own(neverWritten));
    expect(textOf(withHay)).not.toContain(GUESSED_VALUE);
    await db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" IN (${ORG}, ${OTHER_ORG}) AND id LIKE 'hay-%'`;
  }, 600_000);

  /** The work of one check of `rows` for `value`: statements issued, and time. */
  async function measureWork(
    rows: { orgId: string; scope: string; includeUntagged: boolean },
    value: SpecificValue,
    expected: boolean[] | null,
    runs = 15,
  ) {
    const { db: appDb } = await import("@/lib/db");
    const results: { statements: number; ms: number }[] = [];
    for (let run = 0; run < runs; run++) {
      const tx = vi.spyOn(appDb, "$transaction");
      const erasures = vi.spyOn(appDb.erasureSuppression, "findMany");
      // Restored even when the check fails, so the next spyOn starts from no calls.
      try {
        const started = performance.now();
        expect(await readableMemoryHolds(rows, [value])).toEqual(expected);
        results.push({
          statements: tx.mock.calls.length + erasures.mock.calls.length,
          ms: performance.now() - started,
        });
      } finally {
        tx.mockRestore();
        erasures.mockRestore();
      }
    }
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    return { statements: results[0]!.statements, p50: ms[Math.floor(ms.length / 2)]! };
  }

  /** `count` copies naming the erased person and holding the value, written before the erasure: what a restore puts back. */
  const putBack = (count: number, tag: string) =>
    db.$executeRawUnsafe(
      `INSERT INTO memory_chunks ("id","orgId","content","source","actorType","actorName","scopePath","embedding","createdAt")
       SELECT 'c-qa-' || $5 || '-' || g, $1, $2, 'text', 'agent', 'seed', $3, $4::vector, $6::timestamp FROM generate_series(1, ${count}) g`,
      ORG,
      `Dana Whitfield's backup line: ${GUESSED}`,
      PATIENT,
      VECTOR,
      tag,
      new Date(Date.now() - 60_000).toISOString().replace("Z", ""),
    );

  /**
   * A restore from a backup taken before the erasure: the copies come back, and so do the
   * applied markers as they stood then, which hold none for the entries the restore procedure
   * copies back.
   */
  async function restoreFromBefore(count: number, tag: string) {
    await putBack(count, tag);
    await db.erasureSuppressionApplied.deleteMany({ where: { orgId: ORG } });
  }

  it("does the same database work whether the value is never written or held only by erased copies, once the restore's re-apply has run", async () => {
    const [value] = specificValuesIn(GUESS);
    const rows = { orgId: ORG, scope: PATIENT, includeUntagged: false };
    await recordSuppressions(db, ORG, "erasure-request-qa", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    await erasureCompleted("erasure-request-qa");
    const never = await measureWork(rows, value!, [false]);

    const afterRestore = async (count: number, tag: string) => {
      await restoreFromBefore(count, tag);
      const completions = await completeRestore();
      expect(completions.find((c) => c.orgId === ORG)).toMatchObject({ applied: true, adminUserId: "qa-nrm-admin" });
      return measureWork(rows, value!, [false]);
    };
    const one = await afterRestore(1, "one");
    const many = await afterRestore(260, "many");
    process.stderr.write(
      `[qa-nrm] erased copies after the re-apply: never written ${never.statements} statements p50 ${never.p50.toFixed(1)} ms; ` +
        `1 copy restored ${one.statements} p50 ${one.p50.toFixed(1)} ms; 260 copies restored ${many.statements} p50 ${many.p50.toFixed(1)} ms\n`,
    );
    expect({ one: one.statements, many: many.statements }).toEqual({ one: never.statements, many: never.statements });
    expect(await db.memoryChunk.count({ where: { orgId: ORG, id: { startsWith: "c-qa-" } } })).toBe(0);
  }, 600_000);

  it("before the restore's re-apply, makes no claim and reads no memory, however many restored copies hold the value", async () => {
    const [value] = specificValuesIn(GUESS);
    const rows = { orgId: ORG, scope: PATIENT, includeUntagged: false };
    await recordSuppressions(db, ORG, "erasure-request-qa", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    await restoreFromBefore(0, "none");
    const none = await measureWork(rows, value!, null);
    await putBack(1, "one");
    const one = await measureWork(rows, value!, null);
    await putBack(259, "many");
    const many = await measureWork(rows, value!, null);
    process.stderr.write(
      `[qa-nrm] before the re-apply: no copies ${none.statements} statements p50 ${none.p50.toFixed(1)} ms; ` +
        `1 copy ${one.statements} p50 ${one.p50.toFixed(1)} ms; 260 copies ${many.statements} p50 ${many.p50.toFixed(1)} ms\n`,
    );
    expect([none.statements, one.statements, many.statements]).toEqual([0, 0, 0]);
  }, 600_000);

  it("does not call a restore complete when an erasure lands after its re-apply: the org is read again, not assumed", async () => {
    await recordSuppressions(db, ORG, "erasure-request-qa", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    await restoreFromBefore(1, "one");
    // An erasure that records its entries just as the re-apply marks its own applied, as one
    // running at the same time can: its entries are not the re-apply's to mark.
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION qa_nrm_late_erasure() RETURNS trigger AS $$
      BEGIN
        PERFORM set_config('app.erasure_listing', 'on', true);
        INSERT INTO erasure_suppressions (id, "orgId", kind, digest, "requestId", "createdAt")
        VALUES ('qa-nrm-late', NEW."orgId", 'text_name', 'late-digest', 'late-request', now() + interval '1 second')
        ON CONFLICT DO NOTHING;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER qa_nrm_late_erasure AFTER INSERT ON erasure_suppressions_applied
      FOR EACH ROW WHEN (NEW."orgId" = '${ORG}' AND NEW.by LIKE 'reapply:%') EXECUTE FUNCTION qa_nrm_late_erasure()`);
    try {
      const completions = await completeRestore();
      expect(completions.find((c) => c.orgId === ORG)).toMatchObject({ applied: false, adminUserId: "qa-nrm-admin" });
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS qa_nrm_late_erasure ON erasure_suppressions_applied");
      await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS qa_nrm_late_erasure()");
    }
  });

  it("does not mark an erasure that lists its entries while the re-apply is running: that erasure's own completion does", async () => {
    await recordSuppressions(db, ORG, "erasure-request-qa", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    await restoreFromBefore(1, "one");
    // An erasure that lists a person while the re-apply is deleting restored copies.
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION qa_nrm_concurrent_erasure() RETURNS trigger AS $$
      BEGIN
        PERFORM set_config('app.erasure_listing', 'on', true);
        INSERT INTO erasure_suppressions (id, "orgId", kind, digest, "requestId", "createdAt")
        VALUES ('qa-nrm-concurrent', OLD."orgId", 'text_name', 'concurrent-digest', 'concurrent-request', now())
        ON CONFLICT DO NOTHING;
        RETURN OLD;
      END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER qa_nrm_concurrent_erasure AFTER DELETE ON memory_chunks
      FOR EACH ROW WHEN (OLD."orgId" = '${ORG}') EXECUTE FUNCTION qa_nrm_concurrent_erasure()`);
    try {
      const completions = await completeRestore();
      expect(completions.find((c) => c.orgId === ORG)).toMatchObject({ applied: false });
      await erasureCompleted("concurrent-request");
      expect(await db.erasureSuppression.count({ where: { orgId: ORG } })).toBe(
        await db.erasureSuppressionApplied.count({ where: { orgId: ORG } }),
      );
    } finally {
      await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS qa_nrm_concurrent_erasure ON memory_chunks");
      await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS qa_nrm_concurrent_erasure()");
    }
  });

  it("residual, accepted: copies known only by name, standing while the org reads as applied, still cost more work at 50 or more", async () => {
    // A restore cannot produce this state: it brings back the applied markers as they stood
    // before the erasure, so the org reads as not applied until the re-apply removes the copies
    // (the tests above). Only a direct write of old-dated rows, or copying the applied markers
    // back along with the suppression list, which the restore procedure does not do, can. Kept to pin
    // the accepted residual: a copy
    // known by its id costs nothing extra even then (mcp/no-readable-match.realdb.test.ts); one
    // known only by the name it holds is read past in rounds.
    const [value] = specificValuesIn(GUESS);
    const rows = { orgId: ORG, scope: PATIENT, includeUntagged: false };
    await recordSuppressions(db, ORG, "erasure-request-qa", { emails: [], names: ["Dana Whitfield"], contactIds: [] });
    await erasureCompleted("erasure-request-qa");
    const never = await measureWork(rows, value!, [false]);
    await putBack(49, "under");
    const under = await measureWork(rows, value!, [false]);
    await putBack(211, "over");
    const over = await measureWork(rows, value!, [false]);
    process.stderr.write(
      `[qa-nrm] residual, copies written directly: never ${never.statements} statements p50 ${never.p50.toFixed(1)} ms; ` +
        `49 copies ${under.statements} p50 ${under.p50.toFixed(1)} ms; 260 copies ${over.statements} p50 ${over.p50.toFixed(1)} ms\n`,
    );
    expect(under.statements).toBe(never.statements);
    expect(over.statements).toBe(never.statements + 2);
  }, 600_000);

  it("gives the note when the value's parts sit in two readable versions but no one version holds it whole", async () => {
    const first = await write(
      ORG,
      PATIENT,
      "[t050 2026-02-21T10:00] Nurse Janelle (nurse): Backup area code and exchange 415-555, rest pending.",
    );
    const second = await write(
      ORG,
      PATIENT,
      "[t051 2026-02-21T10:05] Nurse Janelle (nurse): The line suffix on file is 0174 for the clinic fax.",
    );
    const result = await ask("Was the safe number 415-555-0174?");
    // 4155550174 is held by no single version; its parts are. The note is about whole values.
    expect(result._meta?.[UNHELD_VALUES_META_KEY]).toEqual([0]);
    expect(textOf(result)).toContain(NO_READABLE_MATCH_NOTE);
    await removeChunk(first);
    await removeChunk(second);
  });
});
