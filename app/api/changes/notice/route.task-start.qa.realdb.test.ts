// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The task-start block served through GET /api/changes/notice, the route the
// `willder init` hook polls.
//
// The route runs the same read as an MCP tool result, so what it may serve is bounded
// by the token: two tenants, two scopes, the task named by X-Willder-Task, a revoked,
// expired or denied token, a person erased from the org. It also shares the session's
// delivered_to claim with the MCP path, and the last two tests ask what that claim is
// keyed on: a block told once to one session must not silence the block another token,
// or the agent's next task, is owed.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never an inherited DATABASE_URL
// that points at a live database. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// Leaf module, not the `@/services/access` barrel: the barrel builds the `@/lib/db`
// singleton at import time, before beforeAll can point DATABASE_URL at the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue(undefined) }));

const QA_URL = process.env.QA_DATABASE_URL;

const ORG_A = "org-qa-654-a";
const ORG_B = "org-qa-654-b";
// The same scope path in both orgs, so only the org filter keeps them apart.
const WEB = "org_qa654.web";
const BILLING = "org_qa654.billing";
const TASK = "WEB-412";
const BILLING_ONLY_TASK = "BILL-77";
const OTHER_WEB_TASK = "WEB-500";
const ERASED_NAME = "Thessaly Marwick";

const WEB_DECISION = "Case654 web decision: retry Stripe webhooks with backoff, at most five attempts.";
const BILLING_DECISION = "Case654 billing decision: invoices are rounded half to even, never half up.";
const BILLING_ONLY_DECISION = "Case654 billing-only decision: dunning emails stop after the third reminder.";
const OTHER_TENANT_DECISION = "Case654 other tenant decision: webhook retries are disabled in this org.";
const OTHER_WEB_DECISION = "Case654 second web task decision: the checkout button stays disabled until the cart loads.";

describe.skipIf(!QA_URL)("QA: the hook route's task-start block stays inside what the token may read", () => {
  let db: PrismaClient;
  let GET: (typeof import("./route"))["GET"];
  let recordConvention: (typeof import("@/services/memory/conventions"))["recordConvention"];
  let recordSuppressions: (typeof import("@/services/memory/erasure-suppression"))["recordSuppressions"];

  async function mint(
    orgId: string,
    agentId: string,
    scopePath: string,
    opts: { permission?: "read" | "write"; expiresAt?: Date; revokedAt?: Date; grantGoverned?: boolean } = {},
  ): Promise<string> {
    const raw = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId,
        agentId,
        tokenHash: hashCapabilityToken(raw),
        scopePath,
        permission: opts.permission ?? "read",
        grantGoverned: opts.grantGoverned ?? false,
        expiresAt: opts.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: opts.revokedAt ?? null,
      },
    });
    return raw;
  }

  const ctxFor = (orgId: string, agentId: string, token: string): AccessContext => ({
    orgId,
    actor: { type: "agent", id: agentId, capabilityToken: token },
    origin: "mcp",
  });

  async function decide(orgId: string, scopePath: string, task: string, text: string): Promise<void> {
    const author = `author-${scopePath.replace(/\W/g, "-")}`;
    const token = await mint(orgId, author, scopePath, { permission: "write" });
    await recordConvention(ctxFor(orgId, author, token), {
      kind: "decision",
      subject: "Case654",
      text,
      scopePath,
      task,
    });
  }

  async function poll(token: string, task?: string): Promise<{ status: number; notice: string | null }> {
    const res = await GET(
      new Request("https://willder.test/api/changes/notice", {
        headers: { authorization: `Bearer ${token}`, ...(task === undefined ? {} : { "x-willder-task": task }) },
      }),
    );
    const body = (await res.json()) as { notice?: string | null };
    return { status: res.status, notice: body.notice ?? null };
  }

  const deliveriesFor = (orgId: string, agentId: string) => db.taskStartDelivery.count({ where: { orgId, agentId } });

  async function cleanup(): Promise<void> {
    for (const orgId of [ORG_A, ORG_B]) {
      await db.taskStartDelivery.deleteMany({ where: { orgId } });
      await db.convention.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.memoryChunk.deleteMany({ where: { orgId } });
      await db.erasureSuppression.deleteMany({ where: { orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
      await db.grant.deleteMany({ where: { orgId } });
      await db.scope.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GET } = await import("./route"));
    ({ recordConvention } = await import("@/services/memory/conventions"));
    ({ recordSuppressions } = await import("@/services/memory/erasure-suppression"));
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    for (const orgId of [ORG_A, ORG_B])
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });

    await decide(ORG_A, WEB, TASK, WEB_DECISION);
    await decide(ORG_A, WEB, OTHER_WEB_TASK, OTHER_WEB_DECISION);
    await decide(ORG_A, BILLING, TASK, BILLING_DECISION);
    await decide(ORG_A, BILLING, BILLING_ONLY_TASK, BILLING_ONLY_DECISION);
    await decide(ORG_B, WEB, TASK, OTHER_TENANT_DECISION);

    // A fact the task wrote, naming a person the org erased afterwards: an old copy the
    // erasure removed, which no path may serve again.
    const writtenAt = new Date(Date.now() - 60 * 60 * 1000);
    await db.memoryChunk.create({
      data: {
        id: "case654-erased-fact",
        orgId: ORG_A,
        entityName: "case654-erased-fact",
        scopePath: WEB,
        content: `${ERASED_NAME} asked for the webhook retries to be turned off.`,
        createdAt: writtenAt,
      },
    });
    await db.changeEvent.create({
      data: {
        orgId: ORG_A,
        seq: BigInt(9_000_001),
        scopePath: WEB,
        recordType: "fact",
        recordId: "case654-erased-fact",
        op: "create",
        actorId: "author-erased",
        summary: "Webhook retry request",
        task: TASK,
        createdAt: writtenAt,
      },
    });
    await recordSuppressions(db, ORG_A, "case654-erasure", {
      emails: [],
      names: [ERASED_NAME.toLowerCase()],
      contactIds: [],
    });
  });

  it("serves the task's decision from the token's own org and scope, and nothing from the other scope, the other org or the erased person", async () => {
    const token = await mint(ORG_A, "reader-web", WEB);

    const { status, notice } = await poll(token, TASK);

    expect(status).toBe(200);
    expect(notice).toContain("Leads to verify (earlier sessions left these; memory_version opens a fact whole):");
    expect(notice).toContain(WEB_DECISION);
    expect(notice).not.toContain(BILLING_DECISION);
    expect(notice).not.toContain(BILLING_ONLY_DECISION);
    expect(notice).not.toContain(OTHER_TENANT_DECISION);
    expect(notice).not.toContain(ERASED_NAME);
    // The block withholds the erased copy; the change feed after it may still list the write by
    // its summary, which an erasure blanks when it names the person.
    expect(notice!.slice(0, notice!.indexOf("Changed in your scope"))).not.toContain("case654-erased-fact");
  });

  it("the other tenant's reader of the same scope path and task gets only its own org's decision", async () => {
    const token = await mint(ORG_B, "reader-web", WEB);

    const { notice } = await poll(token, TASK);

    expect(notice).toContain(OTHER_TENANT_DECISION);
    expect(notice).not.toContain(WEB_DECISION);
    expect(notice).not.toContain(BILLING_DECISION);
  });

  it("a task that exists only in a scope the token cannot read answers exactly as a task that exists nowhere", async () => {
    const elsewhere = await poll(await mint(ORG_A, "reader-1", WEB), BILLING_ONLY_TASK);
    const nowhere = await poll(await mint(ORG_A, "reader-2", WEB), "NO-SUCH-TASK-1");

    expect(elsewhere.status).toBe(nowhere.status);
    expect(elsewhere.notice).not.toContain(BILLING_ONLY_DECISION);
    expect(elsewhere.notice).toBe(nowhere.notice);
  });

  it("a task header that spells another scope's path reads nothing from that scope", async () => {
    for (const named of [BILLING, `${BILLING}.*`, "org_qa654", "*"]) {
      const { notice } = await poll(
        await mint(ORG_A, `reader-path-${named.length}-${named.charCodeAt(0)}`, WEB),
        named,
      );

      expect(notice).not.toContain(BILLING_DECISION);
      expect(notice).not.toContain(BILLING_ONLY_DECISION);
    }
  });

  it("a revoked or expired token is refused before anything is read, and claims no delivery", async () => {
    const revoked = await mint(ORG_A, "reader-revoked", WEB, { revokedAt: new Date(Date.now() - 1000) });
    const expired = await mint(ORG_A, "reader-expired", WEB, { expiresAt: new Date(Date.now() - 1000) });

    for (const token of [revoked, expired]) {
      const { status, notice } = await poll(token, TASK);
      expect(status).toBe(401);
      expect(notice).toBeNull();
    }
    expect(await deliveriesFor(ORG_A, "reader-revoked")).toBe(0);
    expect(await deliveriesFor(ORG_A, "reader-expired")).toBe(0);
  });

  it("a token denied its own scope hears nothing and claims no delivery, so the block still arrives once it is granted", async () => {
    const token = await mint(ORG_A, "reader-denied", WEB, { grantGoverned: true });

    expect(await poll(token, TASK)).toEqual({ status: 200, notice: null });
    expect(await deliveriesFor(ORG_A, "reader-denied")).toBe(0);

    const scope = await db.scope.upsert({
      where: { orgId_path: { orgId: ORG_A, path: WEB } },
      update: {},
      create: { orgId: ORG_A, path: WEB, name: "web" },
    });
    await db.grant.create({
      data: { orgId: ORG_A, scopeId: scope.id, granteeType: "agent", granteeId: "reader-denied", permission: "read" },
    });

    expect((await poll(token, TASK)).notice).toContain(WEB_DECISION);
  });

  it("one agent's served session never silences another agent's block, nor the same agent id in another org", async () => {
    expect((await poll(await mint(ORG_A, "reader-shared-id", WEB), TASK)).notice).toContain(WEB_DECISION);

    expect((await poll(await mint(ORG_A, "reader-other", WEB), TASK)).notice).toContain(WEB_DECISION);
    expect((await poll(await mint(ORG_B, "reader-shared-id", WEB), TASK)).notice).toContain(OTHER_TENANT_DECISION);
  });

  // Keyed on (org, agent, session) alone, with no session named, every token of one agent
  // shared one claim: a block served for one scope silenced the block owed for another
  // scope the same agent holds a token on. The claim is now keyed on the scope too.
  it("an agent's token on one scope does not use up the block its token on another scope is owed", async () => {
    const webToken = await mint(ORG_A, "reader-two-scopes", WEB);
    const billingToken = await mint(ORG_A, "reader-two-scopes", BILLING);

    expect((await poll(webToken, TASK)).notice).toContain(WEB_DECISION);

    const billing = await poll(billingToken, TASK);
    expect(billing.notice).toContain(BILLING_DECISION);
    expect(billing.notice).not.toContain(WEB_DECISION);
  });

  // The hook polls on every prompt and after every tool call, and each poll keeps the
  // claim's 30-minute idle window open. An agent that finishes one task and starts the
  // next session for another task (a new WILLDER_TASK) within that window must still be
  // served the new task's block, so the claim is keyed on the task too.
  it("a later session that names another task is served that task's block", async () => {
    const token = await mint(ORG_A, "reader-next-task", WEB);

    expect((await poll(token, TASK)).notice).toContain(WEB_DECISION);
    expect((await poll(token, TASK)).notice).toBeNull();

    const next = await poll(token, OTHER_WEB_TASK);
    expect(next.notice).toContain("Leads to verify (earlier sessions left these; memory_version opens a fact whole):");
    expect(next.notice).toContain(OTHER_WEB_DECISION);
  });
});
