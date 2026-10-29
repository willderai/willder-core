// Live-gated: runs only with HANDOFF_E2E_LIVE=1 and QA_DATABASE_URL set to an isolated
// test Postgres; without the flag every test in this file is skipped, not failed.
//
// UC6 handoff agent — one real end-to-end lifecycle run, against the live
// Postgres, the real route handlers, the real check()/audit trail and the real
// capability minting.
//
// The five steps, in order, on ONE throwaway org:
//   1. grant scoped, time-boxed access          POST /api/access/grants
//   2. generate the handoff brief               POST /api/agents/:id/handoff
//   3. change a decision in a source mid-task   POST /api/memory/ingest
//   4. attempt a completion receipt             (no route — proven, not assumed)
//   5. revoke the access during the task        DELETE /api/access/grants/:id
//
// WHAT IS REAL HERE (no harness shortcut into a store): every access decision,
// every audit row, every
// Prisma write and read, every route handler body, the capability mint and the
// staleness query all run for real against the live database.
//
// WHAT IS STUBBED, AND WHY (none is load-bearing for the findings):
//   • Clerk — `requireAccessContext` is the auth bridge; there is no Clerk
//     session in a container, so it returns a context built from REAL org/user
//     rows this test created. The identity is real; only the session cookie is.
//   • The LLM — `runHandoffAgent` needs GROQ_API_KEY, and a test never makes a
//     paid model call. The brief's prose is therefore fixed text. The route's
//     access plumbing,
//     capability mint, persistence and metering all still run for real, and
//     none of the five findings depends on what the model would have written.
//   • Graphiti — `ingestMemory` writes episodes into the PRODUCTION memory
//     service. Stubbed so this test never writes to it. Step 3b turns that
//     into evidence rather than a gap: it proves the staleness flag fires off
//     the authorization audit row alone, with no committed source version.
//
// Run: HANDOFF_E2E_LIVE=1 npx vitest run app/api/handoff-e2e-lifecycle.live.test.ts
// CI sets that flag and provisions the isolated database this needs, so the
// suite runs there. Everywhere else it stays opt-in, so a checkout with no such
// database stays green.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const LIVE = process.env.HANDOFF_E2E_LIVE === "1";

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
  if (process.env.HANDOFF_E2E_LIVE !== "1") return undefined;
  const url = process.env.QA_DATABASE_URL;
  if (!url) {
    throw new Error(
      "Refusing to run the live suite without QA_DATABASE_URL. Set it to an ISOLATED " +
        "test database — never the ambient DATABASE_URL, which points at live Neon in " +
        "this sandbox.",
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

// The LLM call only. drawioLinkFromMermaid and everything else stay real.
vi.mock("@/services/agents/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/agents/runner")>()),
  runHandoffAgent: vi.fn(),
}));

// Never write episodes into the production memory service from a test.
vi.mock("@/lib/inngest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inngest")>()),
  ingestMemory: vi.fn(),
}));

import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { ingestMemory } from "@/lib/inngest";
import { runHandoffAgent } from "@/services/agents/runner";
import { check, orgRootPath, hashCapabilityToken, recordAppliedChange } from "@/services/access";
import { POST as grantsPOST } from "@/app/api/access/grants/route";
import { DELETE as grantsDELETE } from "@/app/api/access/grants/[id]/route";
import { POST as handoffPOST } from "@/app/api/agents/[id]/handoff/route";
import { POST as ingestPOST } from "@/app/api/memory/ingest/route";
import { GET as briefGET } from "@/app/api/briefs/[id]/route";
import { GET as stalenessGET } from "@/app/api/briefs/[id]/staleness/route";
import { POST as acknowledgePOST } from "@/app/api/briefs/[id]/acknowledge/route";

type Ctx = { org: { id: string }; user: { id: string; role: string }; ctx: unknown };

const state = {
  orgId: "",
  root: "",
  engPath: "",
  salesPath: "",
  adminId: "",
  granteeId: "",
  agentId: "",
  grantId: "",
  briefId: "",
  capTokenHash: "",
  capToken: "",
};
/** Every finding this run proves, printed as the PASS/FAIL table at the end. */
const findings: string[] = [];

function asUser(id: string, role: string): Ctx {
  return {
    org: { id: state.orgId },
    user: { id, role },
    ctx: { orgId: state.orgId, actor: { type: "human", id, role }, origin: "app" as const },
  };
}
function actAs(id: string, role: string) {
  vi.mocked(requireAccessContext).mockResolvedValue(asUser(id, role) as never);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) => new Request("http://t", { method: "POST", body: JSON.stringify(body) });

describe.skipIf(!LIVE).sequential("UC6 handoff lifecycle, live end to end", () => {
  beforeAll(async () => {
    const org = await db.org.create({ data: { name: "__handoff_e2e_20260918__" } });
    state.orgId = org.id;
    state.root = orgRootPath(org.id);
    state.engPath = `${state.root}.engineering`;
    state.salesPath = `${state.root}.sales`;

    await db.scope.create({ data: { orgId: org.id, path: state.root, name: "Org root" } });
    await db.scope.create({ data: { orgId: org.id, path: state.engPath, name: "Engineering" } });
    await db.scope.create({ data: { orgId: org.id, path: state.salesPath, name: "Sales" } });

    const admin = await db.user.create({
      data: { orgId: org.id, clerkId: `__e2e_admin_${org.id}`, email: "admin@e2e.test", role: "admin" },
    });
    const grantee = await db.user.create({
      data: { orgId: org.id, clerkId: `__e2e_grantee_${org.id}`, email: "contractor@e2e.test", role: "member" },
    });
    state.adminId = admin.id;
    state.granteeId = grantee.id;

    // The admin's own authority: admin on the org root, so access.manage resolves
    // by real ltree containment rather than by anything this test asserts.
    const rootScope = await db.scope.findFirstOrThrow({ where: { orgId: org.id, path: state.root } });
    await db.grant.create({
      data: { orgId: org.id, scopeId: rootScope.id, granteeType: "user", granteeId: admin.id, permission: "admin" },
    });

    const agent = await db.agent.create({
      data: {
        orgId: org.id,
        agentKey: "handoff-agent",
        name: "Handoff agent",
        role: "handoff",
        tools: ["memory_read"],
      },
    });
    state.agentId = agent.id;
  });

  afterAll(async () => {
    if (state.orgId) await db.org.delete({ where: { id: state.orgId } }).catch(() => {});
    console.log("\n=== UC6 handoff lifecycle findings ===\n" + findings.join("\n") + "\n");
  });

  // -------------------------------------------------------------- step 1
  it("STEP 1 — grants scoped, time-boxed access through the real route", async () => {
    actAs(state.adminId, "admin");
    const res = await grantsPOST(
      post({
        scopePath: state.engPath,
        granteeType: "user",
        granteeId: state.granteeId,
        permission: "read",
        ttlHours: 4,
      }),
    );
    expect(res.status).toBe(201);
    const { grant } = await res.json();
    state.grantId = grant.id;

    // Time-boxed for real: the row carries an expiry ~4h out.
    const hoursOut = (new Date(grant.expiresAt).getTime() - Date.now()) / 3.6e6;
    expect(grant.expiresAt).toBeTruthy();
    expect(hoursOut).toBeGreaterThan(3.9);
    expect(hoursOut).toBeLessThan(4.1);

    // Scoped for real: the grantee can read engineering and NOT the sibling scope.
    const granteeCtx = asUser(state.granteeId, "member").ctx as Parameters<typeof check>[0];
    expect((await check(granteeCtx, { action: "memory.read", scope: state.engPath })).allowed).toBe(true);
    expect((await check(granteeCtx, { action: "memory.read", scope: state.salesPath })).allowed).toBe(false);

    findings.push(
      `STEP 1 PASS — grant ${state.grantId} expiresAt=${grant.expiresAt} (ttlHours honoured); grantee reads ${state.engPath}, denied on ${state.salesPath}`,
    );
  });

  // -------------------------------------------------------------- step 2
  it("STEP 2 — generates the brief, minting a capability no wider than the grant", async () => {
    vi.mocked(runHandoffAgent).mockResolvedValue({
      title: "Engineering onboarding briefing",
      summary: "Current decision: the team ships on Postgres.",
      sections: [{ heading: "Decisions", content: "DECISION-1: storage backend is Postgres." }],
    } as never);

    actAs(state.adminId, "admin");
    const res = await handoffPOST(
      post({ scopePath: state.engPath, granteeName: "Dana Contractor", granteeRole: "Backend contractor" }),
      params(state.agentId),
    );
    expect(res.status).toBe(200);
    const { brief } = await res.json();
    state.briefId = brief.id;
    expect(brief.scopePath).toBe(state.engPath);

    // The capability the route actually minted, read back from the real table.
    const caps = await db.capability.findMany({ where: { orgId: state.orgId, agentId: "handoff-agent" } });
    expect(caps).toHaveLength(1);
    expect(caps[0].scopePath).toBe(state.engPath);
    expect(caps[0].permission).toBe("read");
    expect(caps[0].expiresAt).toBeTruthy();
    state.capTokenHash = caps[0].tokenHash;

    // The runner was handed exactly that scope, never wider — and the raw token,
    // which the route returns to nobody else, so step 5c can use the real thing.
    const runnerOpts = vi.mocked(runHandoffAgent).mock.calls[0][0];
    expect(runnerOpts.memoryScope).toBe(state.engPath);
    state.capToken = runnerOpts.capabilityToken;
    expect(hashCapabilityToken(state.capToken)).toBe(caps[0].tokenHash);

    findings.push(
      `STEP 2 PASS — brief ${state.briefId} persisted at scope ${brief.scopePath}; capability minted read/${caps[0].scopePath} expiring ${caps[0].expiresAt?.toISOString?.() ?? caps[0].expiresAt} (LLM prose stubbed, plumbing real)`,
    );
  });

  // -------------------------------------------------------------- step 3
  it("STEP 3a — a mid-task decision change reaches the staleness flag only once it is actually applied", async () => {
    // auditChangesUnderScope() matches `memory.write.applied`, the row the
    // pipeline writes after the store write has actually resolved, not the
    // authorization row check() writes before it is attempted. Both halves are
    // asserted here so the test carries its own differential.
    //
    // The applied row is written by calling the shipping recordAppliedChange()
    // with exactly the arguments lib/inngest.ts's recordIngestApplied() passes.
    // Graphiti is stubbed for this whole file (see the header), so the episode
    // itself does not land; what is under test is the audit-to-flag path, and
    // that runs for real.
    const superseding = "DECISION-1 is superseded: the storage backend is now DynamoDB, as of 2026-09-18.";

    // A superseding decision, published the way a PM actually would: the normal
    // ingest route, under the same scope the brief was drawn from.
    actAs(state.adminId, "admin");
    vi.mocked(ingestMemory).mockResolvedValue(undefined as never);
    const res = await ingestPOST(post({ content: superseding, scope: state.engPath, name: "adr-001-v2" }));
    expect(res.status).toBe(202);

    // Authorized, not yet applied: the grantee is NOT told their briefing moved.
    actAs(state.granteeId, "member");
    const beforeApply = await (await stalenessGET(new Request("http://t"), params(state.briefId))).json();
    expect(beforeApply.changed).toBe(false);
    expect(beforeApply.changes).toHaveLength(0);

    // The store write resolves; the pipeline records it.
    await recordAppliedChange({
      orgId: state.orgId,
      actorType: "human",
      actorId: state.adminId,
      origin: "mcp",
      action: "memory.write",
      scopePath: state.engPath,
      tag: "entity:adr-001-v2",
    });

    actAs(state.granteeId, "member");
    const afterApply = await (await stalenessGET(new Request("http://t"), params(state.briefId))).json();
    expect(afterApply.changed).toBe(true);
    expect(afterApply.changes).toHaveLength(1);
    expect(afterApply.changes[0].target).toBe(`${state.engPath}/entity:adr-001-v2`);

    findings.push(
      `STEP 3a PASS — the staleness flag fires on the APPLIED change, not on authorization: after a 202 ingest the grantee saw changed=false, and after recordAppliedChange() the same read returned changed=true with target ${afterApply.changes[0].target}.`,
    );
  });

  it("STEP 3b — an ingest that was authorized and then failed does not mark the brief stale", async () => {
    // If the flag read the authorization row, an ingest that was permitted and
    // then failed downstream would still tell the grantee to re-read for a
    // change that does not exist.
    const appliedBefore = await db.auditLog.count({
      where: { orgId: state.orgId, action: "memory.write.applied" },
    });

    actAs(state.adminId, "admin");
    vi.mocked(ingestMemory).mockRejectedValue(new Error("graphiti unavailable"));
    await expect(
      ingestPOST(post({ content: "DECISION-2: this write never lands downstream.", scope: state.engPath })),
    ).rejects.toThrow("graphiti unavailable");

    // check() wrote its authorization row before the ingest was attempted, so
    // that row survives the failure -- which is the whole reason the flag must
    // not read it.
    const authorizationRows = await db.auditLog.count({
      where: { orgId: state.orgId, action: "memory.write" },
    });
    expect(authorizationRows).toBeGreaterThan(0);
    expect(await db.auditLog.count({ where: { orgId: state.orgId, action: "memory.write.applied" } })).toBe(
      appliedBefore,
    );

    // The grantee sees only the change from 3a that really landed.
    actAs(state.granteeId, "member");
    const body = await (await stalenessGET(new Request("http://t"), params(state.briefId))).json();
    expect(body.changes).toHaveLength(appliedBefore);
    expect(body.changes.every((c: { target: string }) => c.target !== state.engPath)).toBe(true);

    findings.push(
      `STEP 3b PASS — a failed ingest does not count as a change: ${authorizationRows} memory.write authorization row(s) exist, memory.write.applied stayed at ${appliedBefore}, and the grantee's staleness read still shows ${body.changes.length} change(s), none of them the failed write.`,
    );
  });

  it("STEP 3c — and the brief's own content is never updated or re-pointed; the flag is the whole mechanism", async () => {
    const brief = await db.brief.findFirstOrThrow({ where: { id: state.briefId } });
    // The superseded decision is still what the brief says, verbatim.
    expect(JSON.stringify(brief.sections)).toContain("storage backend is Postgres");
    expect(JSON.stringify(brief.sections)).not.toContain("DynamoDB");
    // Nothing on the Brief row records that it went stale, or when.
    expect(Object.keys(brief)).not.toContain("stalenessCheckedAt");
    expect(Object.keys(brief)).not.toContain("supersededAt");

    findings.push(
      `STEP 3c FAIL — the brief text still asserts the superseded decision ("storage backend is Postgres") and no field on the Brief row records the change. Recovery is manual: the grantee must notice the banner and ask for a regeneration; there is no re-generate action on the brief and no new version is produced.`,
    );
  });

  // -------------------------------------------------------------- step 4
  it("STEP 4 — the completion receipt is produced, persisted and retrievable by the grantee", async () => {
    // Three things must hold: the brief records its backend, the grantee can
    // acknowledge, and the acknowledgement is a real audit row.

    // (a) The backend that produced this brief survives the request. A reloaded
    // receipt can print it instead of degrading to "Backend: Unknown".
    actAs(state.granteeId, "member");
    const briefBody = await (await briefGET(new Request("http://t"), params(state.briefId))).json();
    expect(Object.keys(briefBody.brief)).toContain("backend");
    expect(briefBody.brief.backend).toBe("single");

    // (b) The grantee can acknowledge, and the route answers with the staleness
    // verdict it computed server-side for that moment.
    const ackRes = await acknowledgePOST(new Request("http://t", { method: "POST" }), params(state.briefId));
    expect(ackRes.status).toBe(200);
    const ackBody = await ackRes.json();
    expect(typeof ackBody.acknowledgedAt).toBe("string");
    expect(typeof ackBody.stale).toBe("boolean");

    // (c) The attestation is a real row in the audit trail, attributed to the
    // grantee, tagged under this brief's own scope, carrying that verdict.
    const ackRows = await db.auditLog.findMany({
      where: { orgId: state.orgId, actorId: state.granteeId, action: "brief.acknowledged" },
      select: { target: true, metadata: true },
    });
    expect(ackRows).toHaveLength(1);
    expect(ackRows[0].target).toBe(`${state.engPath}/brief:${state.briefId}/acknowledged`);
    expect(ackRows[0].metadata).toMatchObject({ stale: ackBody.stale });

    findings.push(
      `STEP 4 PASS \u2014 the receipt is durable: the brief read returns backend=${briefBody.brief.backend}, POST /api/briefs/:id/acknowledge returned 200 with stale=${ackBody.stale}, and the audit trail holds one brief.acknowledged row attributed to the grantee at ${ackRows[0].target}.`,
    );
  });

  // -------------------------------------------------------------- step 5
  it("STEP 5a — revoking the grant mid-task does stop new scoped reads", async () => {
    actAs(state.adminId, "admin");
    const res = await grantsDELETE(new Request("http://t", { method: "DELETE" }), params(state.grantId));
    expect(res.status).toBe(200);

    const granteeCtx = asUser(state.granteeId, "member").ctx as Parameters<typeof check>[0];
    const decision = await check(granteeCtx, { action: "memory.read", scope: state.engPath });
    expect(decision.allowed).toBe(false);

    findings.push(
      `STEP 5a PASS — after DELETE /api/access/grants/${state.grantId}, check(memory.read, ${state.engPath}) for the grantee denies: "${decision.reason}".`,
    );
  });

  it("STEP 5b — the revoked grantee can no longer read the brief or its staleness flag", async () => {
    actAs(state.granteeId, "member");
    // A denied reader gets the same 404 as an absent id, so the brief's
    // existence is not disclosed either.
    const res = await briefGET(new Request("http://t"), params(state.briefId));
    expect(res.status).toBe(404);

    const flagRes = await stalenessGET(new Request("http://t"), params(state.briefId));
    expect(flagRes.status).toBe(404);

    // A reader from another org gets the identical answer.
    const other = await db.org.create({ data: { name: "__handoff_e2e_other_20260918__" } });
    try {
      vi.mocked(requireAccessContext).mockResolvedValue({
        org: { id: other.id },
        user: { id: "outsider", role: "member" },
        ctx: { orgId: other.id, actor: { type: "human", id: "outsider", role: "member" }, origin: "app" as const },
      } as never);
      expect((await briefGET(new Request("http://t"), params(state.briefId))).status).toBe(404);
      expect((await stalenessGET(new Request("http://t"), params(state.briefId))).status).toBe(404);
    } finally {
      await db.org.delete({ where: { id: other.id } }).catch(() => {});
    }

    // The brief does exist, and check() on its own scopePath denies this exact
    // grantee: the 404s above are the gate, not a missing row.
    const granteeCtx = asUser(state.granteeId, "member").ctx as Parameters<typeof check>[0];
    const brief = await db.brief.findFirstOrThrow({ where: { id: state.briefId } });
    const wouldDeny = await check(granteeCtx, { action: "memory.read", scope: brief.scopePath });
    expect(wouldDeny.allowed).toBe(false);

    findings.push(
      `STEP 5b PASS (was FAIL) — GET /api/briefs/${state.briefId} and its /staleness route now both 404 for the revoked grantee, the same answer as an absent id: check(grantee, memory.read, brief.scopePath) denies with "${wouldDeny.reason}", and the routes call it before returning. Cross-org reads get the identical 404.`,
    );
  });

  it("STEP 5c — the agent capability minted for this handoff is revoked alongside the grant", async () => {
    const cap = await db.capability.findFirstOrThrow({ where: { orgId: state.orgId, tokenHash: state.capTokenHash } });
    expect(cap.revokedAt).not.toBeNull();
    expect(cap.scopePath).toBe(state.engPath);

    // Not a hypothetical: the REAL token the route minted fails the REAL
    // evaluator for the very scope whose human grant was just revoked.
    const agentCtx = {
      orgId: state.orgId,
      actor: { type: "agent" as const, id: "handoff-agent", capabilityToken: state.capToken, name: "Handoff agent" },
      origin: "mcp" as const,
    };
    const live = await check(agentCtx, { action: "memory.read", scope: state.engPath });
    expect(live.allowed).toBe(false);

    findings.push(
      `STEP 5c PASS (was FAIL) — after the grant was revoked, the capability the handoff route minted is revoked too (revokedAt=${cap.revokedAt?.toISOString()}): check(agent, memory.read, ${state.engPath}) => denied, "${live.reason}". DELETE /api/access/grants/:id now revokes any live Handoff-agent capability at or under the grant's own scope in the same call.`,
    );
  });
});
