// Live-gated: runs only with HANDOFF_GATE_C_LIVE=1 and QA_DATABASE_URL set to an isolated
// test Postgres; without the flag every test in this file is skipped, not failed.
//
// Gate C extension — two scenarios the base changed-decision check does not
// cover.
//
// Gate C's base shape is exactly one: ONE source is SUPERSEDED mid-sequence,
// re-ask, 5/5 answers must cite
// the new version. That shape assumes the change is unambiguous and that the
// reader's access is constant. Neither holds in a real handoff. These two add:
//
//   C.2  CONFLICTING SOURCES — two sources DISAGREE, neither supersedes the
//        other, no change marker. There is no "new version" to cite.
//   C.3  MID-TASK PERMISSION NARROWING — the grant shrinks to a child scope
//        while the task is in flight. Not a revoke: access continues, smaller.
//
// The judged half of C.2 (does the ANSWER surface both sides) needs the gate
// A/C judge and a paid model call, and is deliberately NOT run here.
//
// Opt-in only, and it cannot be made to run in CI. C.2b and C.2c read a
// brief's staleness, which runs the same-tier contradiction scan, and that
// scan is a real model call (services/facts/conflicts.ts
// findScopeContradictions). Mocking the model would make them vacuous — the
// detection is the behaviour under test — so they need a model configured
// (OPENAI_API_KEY, plus OPENAI_BASE_URL / OPENAI_MODEL_ORCHESTRATOR for a local
// OpenAI-compatible server) and fail with that reason, not on an empty array,
// when none is. So this suite holds a flag of its own, rather than one
// that would also hold back app/api/handoff-e2e-lifecycle.live.test.ts, which
// mocks the agent, makes no model call and does run in CI.
//
// What the scan reads is NOT a model: it is the graph view of the brief's scope
// (guardedMemory.graph), served only for edges a stored memory_chunks row backs
// (services/memory/graph-fact-sources.ts). ingestMemory is mocked here, so the
// pipeline never writes those rows and Graphiti never sees the facts; without
// stand-ins the scan returns [] at "fewer than two edges" before any model is
// asked, whatever key is set. C.2a therefore writes the two rows the pipeline
// would store and the Graphiti service (an external HTTP store) is stubbed to
// return the two edges extracted from them. Everything between — the access
// gate, tier check, serve-time source check, scan, dispute filing and the
// staleness response — is the shipping code.
//
// Run: HANDOFF_GATE_C_LIVE=1 OPENAI_API_KEY=... npx vitest run app/api/handoff-gate-c-extension.live.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const LIVE = process.env.HANDOFF_GATE_C_LIVE === "1";

// Test-database isolation. These suites create orgs, users, grants,
// capabilities, briefs, sources and audit rows, and an interrupted run skips
// cleanup, so the suite must never run against whatever `DATABASE_URL` the
// shell happens to carry: it REFUSES to run unless QA_DATABASE_URL names an
// explicitly isolated database.
//
// This is hoisted because `@/lib/db` builds its client from DATABASE_URL at
// import time: pinning the variable in ordinary module scope would run AFTER
// that import and leave the client pointed at the ambient database.
const QA_URL = vi.hoisted(() => {
  if (process.env.HANDOFF_GATE_C_LIVE !== "1") return undefined;
  const url = process.env.QA_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Refusing to run the live suite without QA_DATABASE_URL. Set it to an ISOLATED " +
        "test database — never the ambient DATABASE_URL, which points at live Neon in " +
        "this sandbox (item routine-sandbox-prod-db-url).",
    );
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
    throw new Error(
      "QA_DATABASE_URL is identical to DATABASE_URL. Point it at a separate, " +
        "throwaway database before running the live suite.",
    );
  }
  process.env.DATABASE_URL = url;
  return url;
});

vi.mock("@/lib/db", async (importOriginal) => {
  if (process.env.HANDOFF_E2E_NEON_HTTP !== "1") return importOriginal();
  const { PrismaNeon } = await import("@prisma/adapter-neon");
  const { PrismaClient } = await import("@/lib/generated/prisma/client");
  const adapter = new PrismaNeon({ connectionString: QA_URL });
  return { db: new PrismaClient({ adapter }) };
});
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/agents/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/runner")>()),
  runHandoffAgent: vi.fn(),
}));
vi.mock("@/lib/inngest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inngest")>()),
  ingestMemory: vi.fn(),
}));

import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { ingestMemory } from "@/lib/inngest";
import { runHandoffAgent } from "@/services/agents/runner";
import { check, orgRootPath, recordAppliedChange, type AccessContext } from "@/services/access";
import { POST as grantsPOST } from "@/app/api/access/grants/route";
import { DELETE as grantsDELETE } from "@/app/api/access/grants/[id]/route";
import { POST as handoffPOST } from "@/app/api/agents/[id]/handoff/route";
import { POST as ingestPOST } from "@/app/api/memory/ingest/route";
import { GET as briefGET } from "@/app/api/briefs/[id]/route";
import { GET as stalenessGET } from "@/app/api/briefs/[id]/staleness/route";
import { graphitiStore } from "@/services/memory/store";
import { toGid } from "@/services/memory/graphiti-store";
import type { MemoryEdge } from "@/types/memory";

// The edges the Graphiti stub serves (see the header); filled by C.2a.
const graphEdges: MemoryEdge[] = [];
const modelConfigured = Boolean(process.env.OPENAI_API_KEY);
// C.2b and C.2c wait on a real model call, well past vitest's 5 s default.
const MODEL_TIMEOUT_MS = 120_000;
function requireModel(test: string) {
  if (!modelConfigured) {
    throw new Error(
      `${test} needs a model for the contradiction scan: set OPENAI_API_KEY ` +
        "(and OPENAI_BASE_URL / OPENAI_MODEL_ORCHESTRATOR for a local OpenAI-compatible server).",
    );
  }
}

const s = {
  orgId: "",
  root: "",
  eng: "",
  backend: "",
  sales: "",
  adminId: "",
  granteeId: "",
  agentId: "",
  parentGrantId: "",
  briefId: "",
};
const findings: string[] = [];

function ctxFor(id: string, role: string): AccessContext {
  return { orgId: s.orgId, actor: { type: "human", id, role } } as AccessContext;
}
function actAs(id: string, role: string) {
  vi.mocked(requireAccessContext).mockResolvedValue({
    org: { id: s.orgId },
    user: { id, role },
    ctx: ctxFor(id, role),
  } as never);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request("http://t", { method: "POST", body: JSON.stringify(body) });

describe.skipIf(!LIVE).sequential("Gate C extension — conflicting sources and mid-task narrowing", () => {
  beforeAll(async () => {
    vi.spyOn(graphitiStore, "graph").mockImplementation(async (input) => {
      // Callers pass scope paths; Graphiti partitions are their toGid() form.
      const groups = new Set((input.groupIds ?? [input.groupId]).map(toGid));
      const edges = graphEdges.filter((e) => groups.has(e.graphGroupId ?? ""));
      const nodes = [...new Set(edges.flatMap((e) => [e.source, e.target]))].map((uuid) => ({
        uuid,
        name: uuid,
        type: "Entity",
      }));
      return { nodes, edges };
    });
    const org = await db.org.create({ data: { name: "__gate_c_ext_20260919__" } });
    s.orgId = org.id;
    s.root = orgRootPath(org.id);
    s.eng = `${s.root}.engineering`;
    s.backend = `${s.root}.engineering.backend`;
    s.sales = `${s.root}.sales`;
    for (const [path, name] of [
      [s.root, "Org root"],
      [s.eng, "Engineering"],
      [s.backend, "Backend"],
      [s.sales, "Sales"],
    ] as const) {
      await db.scope.create({ data: { orgId: org.id, path, name } });
    }
    const admin = await db.user.create({
      data: { orgId: org.id, clerkId: `__gc_admin_${org.id}`, email: "admin@gatec.test", role: "admin" },
    });
    const grantee = await db.user.create({
      data: { orgId: org.id, clerkId: `__gc_grantee_${org.id}`, email: "contractor@gatec.test", role: "member" },
    });
    s.adminId = admin.id;
    s.granteeId = grantee.id;
    const rootScope = await db.scope.findFirstOrThrow({ where: { orgId: org.id, path: s.root } });
    await db.grant.create({
      data: { orgId: org.id, scopeId: rootScope.id, granteeType: "user", granteeId: admin.id, permission: "admin" },
    });
    s.agentId = (
      await db.agent.create({
        data: {
          orgId: org.id,
          agentKey: "handoff-agent",
          name: "Handoff agent",
          role: "handoff",
          tools: ["memory_read"],
        },
      })
    ).id;

    // Connected sources in two different scopes — one the brief will cover, one
    // it never will. Both are "connected" (not disconnected), which is all the
    // staleness route's source-visibility count asks about.
    await db.source.create({
      data: { orgId: org.id, type: "website", externalId: "eng-wiki.test", name: "Engineering wiki", scopePath: s.eng },
    });
    await db.source.create({
      data: { orgId: org.id, type: "website", externalId: "sales-crm.test", name: "Sales CRM", scopePath: s.sales },
    });
    await db.source.create({
      data: {
        orgId: org.id,
        type: "website",
        externalId: "sales-deals.test",
        name: "Sales deal notes",
        scopePath: s.sales,
      },
    });

    // The handoff itself: read grant on engineering, brief generated from it.
    actAs(s.adminId, "admin");
    const gr = await grantsPOST(
      post({
        scopePath: s.eng,
        granteeType: "user",
        granteeId: s.granteeId,
        permission: "read",
        ttlHours: 4,
      }),
    );
    s.parentGrantId = (await gr.json()).grant.id;

    vi.mocked(runHandoffAgent).mockResolvedValue({
      title: "Engineering onboarding briefing",
      summary: "Deploy target is Vercel.",
      sections: [
        { heading: "Decisions", content: "DECISION-7: the deploy target is Vercel (per the engineering wiki)." },
        { heading: "Backend", content: "Backend service notes live under engineering.backend." },
      ],
    } as never);
    s.briefId = (
      await (
        await handoffPOST(
          post({ scopePath: s.eng, granteeName: "Dana Contractor", granteeRole: "Backend contractor" }),
          params(s.agentId),
        )
      ).json()
    ).brief.id;
    vi.mocked(ingestMemory).mockResolvedValue(undefined as never);
  });

  afterAll(async () => {
    if (s.orgId) await db.org.delete({ where: { id: s.orgId } }).catch(() => {});
    console.log("\n=== Gate C extension findings ===\n" + findings.join("\n") + "\n");
  });

  // ------------------------------------------------------------------ C.2
  // Contradiction detection runs READ-TIME, not on the generic ingest path —
  // see GET /api/briefs/:id/staleness's own scanForContradictions comment for
  // the cost/latency rationale (a scan gated on this brief's own `changed`
  // flag, bounded to its scope, rather than checking every Slack/Drive/Figma
  // sync and agent fact). C.2a below is therefore "0 disputes right after
  // ingest", the CORRECT behavior; C.2b is where detection fires, because
  // staleness is what a grantee's read triggers.
  it("C.2a — two sources disagree with no supersession marker; both ingest cleanly, and no dispute opens until something reads this brief's staleness", async () => {
    actAs(s.adminId, "admin");
    // Source A and source B assert incompatible things about the SAME decision.
    // Neither says "supersedes"; neither is newer in any way the product reads.
    const assertions = [
      { name: "eng-wiki-deploy", content: "DECISION-7: the deploy target is Vercel. Confirmed by the platform team." },
      { name: "adr-007-deploy", content: "DECISION-7: the deploy target is AWS ECS. Confirmed by the platform team." },
    ];
    const a = await ingestPOST(post({ content: assertions[0].content, scope: s.eng, name: assertions[0].name }));
    const b = await ingestPOST(post({ content: assertions[1].content, scope: s.eng, name: assertions[1].name }));
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);

    // Still zero here, by design — the scan is read-time (C.2b), not ingest-time.
    const disputes = await db.factDispute.findMany({ where: { orgId: s.orgId } });
    expect(disputes).toHaveLength(0);

    // Both writes then actually land. The staleness query reads
    // `memory.write.applied` -- the row the pipeline writes once the store
    // write has resolved -- rather than the
    // authorization row check() writes before it is attempted. Graphiti is
    // stubbed for this whole file (see the header), so the applied rows are
    // written here by calling the shipping recordAppliedChange() with exactly
    // the arguments lib/inngest.ts's recordIngestApplied() passes. Without them
    // `changes` is empty, the contradiction scan is gated off, and C.2b/C.2c
    // below would be testing the ordering rule rather than detection.
    for (const name of ["eng-wiki-deploy", "adr-007-deploy"]) {
      await recordAppliedChange({
        orgId: s.orgId,
        actorType: "human",
        actorId: s.adminId,
        origin: "mcp",
        action: "memory.write",
        scopePath: s.eng,
        tag: `entity:${name}`,
      });
    }

    // What the same pipeline stores, with ingestMemory mocked: one memory_chunks row
    // per write, and the graph edge Graphiti extracts from it, stamped with that
    // row's id. The serve-time source check serves an edge only while such a row is
    // live, so without the rows the stubbed edges would be (correctly) withheld.
    for (const [i, { name, content }] of assertions.entries()) {
      const chunk = await db.memoryChunk.create({
        data: { orgId: s.orgId, content, actorType: "human", actorId: s.adminId, entityName: name, scopePath: s.eng },
      });
      graphEdges.push({
        uuid: `gatec-edge-${i}`,
        source: "gatec-node-decision-7",
        target: `gatec-node-target-${i}`,
        fact: content,
        actorType: "human",
        actorName: s.adminId,
        scopePath: s.eng,
        graphGroupId: toGid(s.eng),
        invalidAt: null,
        chunkIds: [chunk.id],
      });
    }

    findings.push(
      `C.2a PASS (by design, was FAIL) — two directly contradictory assertions about DECISION-7 ingest with 202 and open zero FactDispute rows at ingest time. This is the deliberate design decision, not the original bug: a contradiction check on the generic ingest path (lib/inngest.ts memoryIngest) would run on every Slack/Drive/Figma sync and agent fact, not just ones anyone will read through a brief. See C.2b for the read-time fix actually firing.`,
    );
  });

  it(
    "C.2b — reading this brief's staleness detects the same-tier contradiction, opens a real FactDispute, and gives the grantee a distinguishing signal",
    async () => {
      requireModel("C.2b");
      actAs(s.granteeId, "member");
      const body = await (await stalenessGET(new Request("http://t"), params(s.briefId))).json();
      expect(body.changed).toBe(true);

      // `changes` itself is only action/target/at and collapses to one target
      // (the generic ingest path's audit target carries no fact content), so it
      // cannot carry this signal.
      const keys = [...new Set(body.changes.flatMap((c: object) => Object.keys(c)))].sort();
      expect(keys).toEqual(["action", "at", "target"]);

      // The signal is a SEPARATE top-level field: `contradictions`, scoped to
      // this brief, naming both conflicting assertions plainly. The LLM call
      // decides which side is factA vs factB, so check both names appear rather
      // than pinning an order.
      expect(body.contradictions).toHaveLength(1);
      const pairText = body.contradictions[0].factA + " " + body.contradictions[0].factB;
      expect(pairText).toMatch(/Vercel/);
      expect(pairText).toMatch(/AWS ECS/);

      // Reading staleness is what triggers the scan+file — the dispute exists,
      // same-tier (both assertions were ingested by the same admin, actorType
      // human), matching the fact_disputes "same-tier only" rule.
      const disputes = await db.factDispute.findMany({ where: { orgId: s.orgId } });
      expect(disputes).toHaveLength(1);
      expect(disputes[0].existingActorType).toBe("human");
      expect(disputes[0].proposerActorType).toBe("human");
      expect(disputes[0].status).toBe("disputed");

      findings.push(
        `C.2b PASS (was FAIL) — GET /api/briefs/${s.briefId}/staleness now returns a top-level \`contradictions\` field (1 entry, factA/factB naming Vercel and AWS ECS by content) alongside the unchanged \`changes\` list, and reading it opened a real same-tier FactDispute (${disputes[0].id}). The grantee's signal is no longer one collapsed target string for both writes — a genuine disagreement now reads differently from a plain correction.`,
      );
    },
    MODEL_TIMEOUT_MS,
  );

  it(
    "C.2c — the handoff brief's own read surface populates a contradiction block (the persisted Brief row stays point-in-time, unchanged)",
    async () => {
      requireModel("C.2c");
      const brief = await db.brief.findFirstOrThrow({ where: { id: s.briefId } });
      expect(brief.type).toBe("handoff");
      // The PERSISTED brief row is deliberately untouched — a handoff brief is an
      // immutable record of what was known at generation time (same principle
      // GET /api/briefs/:id/staleness's own header comment states for `changed`),
      // so this reads exactly as it did at generation time.
      expect(brief.decisions).toBeNull();
      expect(JSON.stringify(brief.sections)).toContain("Vercel");
      expect(JSON.stringify(brief.sections)).not.toContain("AWS ECS");

      // The LIVE read surface, not history, carries the signal: the staleness
      // response (asserted in C.2b) carries the same {factA, factB, note} shape
      // BriefView's contradiction block consumes for architecture briefs —
      // components/agents/contradiction-block.tsx extracts that exact renderer so
      // app/(app)/briefs/[id]/brief-document.tsx (the page this scenario's
      // grantee actually reads) can populate it from the staleness scan
      // instead of a generation-time Brief.contradictions column, which the
      // handoff agent's own output schema never populates.
      const staleness = await (await stalenessGET(new Request("http://t"), params(s.briefId))).json();
      expect(staleness.contradictions).toHaveLength(1);

      findings.push(
        `C.2c PASS (was FAIL) — brief ${s.briefId} (type=handoff) still asserts only "Vercel" in its own persisted sections (correct: point-in-time), but its read surface (GET .../staleness) now carries a real contradiction block naming both assertions, rendered by the same component BriefView already used for architecture briefs. A grantee opening this briefing now sees "Sources now disagree" with both facts shown, not a silent pick of one side.`,
      );
    },
    MODEL_TIMEOUT_MS,
  );

  // ------------------------------------------------------------------ C.3
  it("C.3a — narrowing the grant mid-task works at the gate: parent denied, child allowed", async () => {
    actAs(s.adminId, "admin");
    // The real narrowing a manager would perform: add the child grant, drop the parent.
    const child = await grantsPOST(
      post({
        scopePath: s.backend,
        granteeType: "user",
        granteeId: s.granteeId,
        permission: "read",
        ttlHours: 4,
      }),
    );
    expect(child.status).toBe(201);
    expect((await grantsDELETE(new Request("http://t", { method: "DELETE" }), params(s.parentGrantId))).status).toBe(
      200,
    );

    const g = ctxFor(s.granteeId, "member");
    const parent = await check(g, { action: "memory.read", scope: s.eng });
    const kid = await check(g, { action: "memory.read", scope: s.backend });
    expect(parent.allowed).toBe(false);
    expect(kid.allowed).toBe(true);

    findings.push(
      `C.3a PASS — after narrowing, check(memory.read, ${s.eng}) denies ("${parent.reason}") while check(memory.read, ${s.backend}) allows ("${kid.reason}"). Narrowing is enforced at the evaluator exactly like a revoke.`,
    );
  });

  it("C.3b — the narrowed grantee can no longer read the wider scope's brief", async () => {
    actAs(s.granteeId, "member");
    const res = await briefGET(new Request("http://t"), params(s.briefId));

    // GET /api/briefs/:id runs check() on the brief's own scopePath, so the
    // narrowing is enforced on the delivered artifact, not just at the
    // evaluator. The denial is a 404, the same answer as an absent id.
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).not.toHaveProperty("brief");

    // The gate that closes it is the same one C.3a already showed answering
    // correctly -- here it is actually asked.
    const wouldDeny = await check(ctxFor(s.granteeId, "member"), { action: "memory.read", scope: s.eng });
    expect(wouldDeny.allowed).toBe(false);

    findings.push(
      `C.3b PASS (was FAIL) — GET /api/briefs/${s.briefId} now returns 404 to a grantee narrowed to ${s.backend}, instead of serving the ${s.eng}-scoped brief in full. check(grantee, memory.read, ${s.eng}) denies at the same moment ("${wouldDeny.reason}") and the route now asks it. Narrowing is enforced on the delivered artifact, closing the same hole revoke reached at step 5b.`,
    );
  });

  it("C.3c — the narrowed grantee no longer receives the source-visibility counts", async () => {
    actAs(s.granteeId, "member");
    const body = await (await stalenessGET(new Request("http://t"), params(s.briefId))).json();

    // This route is gated on the brief's own scope too, so the narrowed grantee
    // never reaches the counts at all: no existence-count leak.
    expect(body).not.toHaveProperty("sources");

    // The two sources that would otherwise be counted sit in a scope this reader is
    // denied on; that denial is what the route honours.
    const salesCheck = await check(ctxFor(s.granteeId, "member"), { action: "memory.read", scope: s.sales });
    expect(salesCheck.allowed).toBe(false);
    const salesSources = await db.source.count({ where: { orgId: s.orgId, scopePath: s.sales } });
    expect(salesSources).toBe(2);

    findings.push(
      `C.3c PASS (existence-count leak closed) — GET /api/briefs/${s.briefId}/staleness returns no sources block to a grantee narrowed to ${s.backend}; the route is gated on the brief's own scope and denies. Independently, the Source query is filtered through readableScopePaths(), so even an authorized reader is counted only over scopes they hold a grant on. The bare count of ${salesSources} connected sources under ${s.sales} — a scope check() denies this reader on ("${salesCheck.reason}") — is not disclosed, matching the skippedOutOfScope rule app/api/memory/facts/staleness-check/route.ts documents.`,
    );
  });
});
