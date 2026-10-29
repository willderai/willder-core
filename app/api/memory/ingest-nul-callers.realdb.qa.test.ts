// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// QA for "every ingestMemory caller refuses a NUL up front, naming the field". The
// builder's tests mock check() and the database, so they show the 400 and that the mocks
// were not called; they cannot show that no audit, account, contact or fact row lands in
// a real database. Each case here sends one NUL in one field through the real route and
// the real check(), then counts rows. A clean control on the same harness writes, so a
// refusal here is the guard, not a harness that refuses everything.
//
// Real: Postgres, check()/can()/recordAudit, POST /api/memory/facts, PATCH
// /api/memory/facts/:id, POST /api/contacts/from-research, POST /api/briefs/:id/correct,
// the memory_write agent tool. Faked: the Clerk session, the memory backend's removeFact,
// and ingestMemory (a spy: its own NUL refusal is lib/inngest/memory-ingest-nul.realdb.qa.test.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import type { MemoryStore } from "@/services/memory/memory-store";
import type { RemoveFactInput } from "@/types/memory";

const QA_URL = process.env.QA_DATABASE_URL;
const ORG = "case510nul";
const ROOT = `org_${ORG}`;
const ADMIN = "u-case510-admin";
const NUL = "\u0000";

const refusal = (field: string) =>
  `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`;

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn(async () => ({ readableNow: false })) }));

const removeFact = vi.hoisted(() => vi.fn(async (_input: RemoveFactInput) => ({ removed: true })));
vi.mock("@/services/memory", async () => {
  const { GuardedMemoryStore } = await import("@/services/memory/guarded-store");
  const { MemoryServiceError } = await import("@/services/memory/graphiti-store");
  return { guardedMemory: new GuardedMemoryStore({ removeFact } as unknown as MemoryStore), MemoryServiceError };
});

describe.skipIf(!QA_URL)("ingestMemory callers refuse a NUL before any row is written, real Postgres", () => {
  let db: PrismaClient;
  let ingestMemory: ReturnType<typeof vi.fn>;
  let POST_FACT: (typeof import("./facts/route"))["POST"];
  let PATCH_FACT: (typeof import("./facts/[id]/route"))["PATCH"];
  let FROM_RESEARCH: (typeof import("../contacts/from-research/route"))["POST"];
  let CORRECT: (typeof import("../briefs/[id]/correct/route"))["POST"];
  let memoryWriteTool: (typeof import("@/services/agents/tools"))["memoryWriteTool"];

  const json = (url: string, method: string, body: unknown) =>
    new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const rows = async () => ({
    audit: await db.auditLog.count({ where: { orgId: ORG } }),
    accounts: await db.account.count({ where: { orgId: ORG } }),
    contacts: await db.contact.count({ where: { orgId: ORG } }),
  });
  const none = { audit: 0, accounts: 0, contacts: 0 };

  async function wipe() {
    await db.contact.deleteMany({ where: { orgId: ORG } });
    await db.account.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
  }

  beforeAll(async () => {
    if (QA_URL === undefined) return;
    if (QA_URL === process.env.DATABASE_URL) throw new Error("QA_DATABASE_URL must not be DATABASE_URL");
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ POST: POST_FACT } = await import("./facts/route"));
    ({ PATCH: PATCH_FACT } = await import("./facts/[id]/route"));
    ({ POST: FROM_RESEARCH } = await import("../contacts/from-research/route"));
    ({ POST: CORRECT } = await import("../briefs/[id]/correct/route"));
    ({ memoryWriteTool } = await import("@/services/agents/tools"));
    ({ ingestMemory } = (await import("@/lib/inngest")) as never);
    const { requireAccessContext } = (await import("@/lib/access-context")) as never as {
      requireAccessContext: ReturnType<typeof vi.fn>;
    };
    requireAccessContext.mockResolvedValue({
      org: { id: ORG },
      user: { id: ADMIN, name: ADMIN },
      ctx: { orgId: ORG, actor: { type: "human", id: ADMIN, role: "admin" } },
    });

    await wipe();
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.org.create({ data: { id: ORG, name: "QA 510" } });
    await db.user.create({
      data: { id: ADMIN, orgId: ORG, email: `${ADMIN}@case510.test`, role: "admin", clerkId: `clerk-${ADMIN}` },
    });
    const root = await db.scope.create({ data: { orgId: ORG, path: ROOT, name: ROOT } });
    await db.grant.create({
      data: { orgId: ORG, scopeId: root.id, granteeType: "user", granteeId: ADMIN, permission: "admin" },
    });
  }, 60_000);

  afterAll(async () => {
    if (QA_URL === undefined) return;
    await wipe();
    await db.grant.deleteMany({ where: { orgId: ORG } });
    await db.scope.deleteMany({ where: { orgId: ORG } });
    await db.user.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    ingestMemory.mockClear();
    removeFact.mockClear();
    await wipe();
  });

  describe("POST /api/memory/facts", () => {
    it.each([
      ["fact", { fact: `Refunds are owned${NUL} by payments.` }],
      // A NUL in scope is refused as a malformed scope instead: a 403 with one deny row,
      // as on every scope writer (writers-refuse-malformed-scope.realdb.test.ts).
    ])("a NUL in %s alone is a 400 naming it, with no audit row and no ingest", async (field, body) => {
      const res = await POST_FACT(json("http://t/api/memory/facts", "POST", body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(refusal(field));
      expect(await rows()).toEqual(none);
      expect(ingestMemory).not.toHaveBeenCalled();
    });

    it("control: the same fact without a NUL is audited and ingested", async () => {
      const res = await POST_FACT(
        json("http://t/api/memory/facts", "POST", { fact: "Refunds are owned by payments." }),
      );
      expect(res.status).toBe(202);
      expect((await rows()).audit).toBe(1);
      expect(ingestMemory).toHaveBeenCalledTimes(1);
    });
  });

  describe("PATCH /api/memory/facts/:id", () => {
    const patch = (body: unknown) =>
      PATCH_FACT(json("http://t/api/memory/facts/f1", "PATCH", body), { params: Promise.resolve({ id: "f1" }) });

    it("a NUL in fact is a 400 naming it, and the old fact is not removed", async () => {
      const res = await patch({ fact: `Refunds are owned${NUL} by payments.` });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(refusal("fact"));
      expect(removeFact).not.toHaveBeenCalled();
      expect(await rows()).toEqual(none);
      expect(ingestMemory).not.toHaveBeenCalled();
    });

    it("control: the same edit without a NUL removes the old fact and ingests the new one", async () => {
      const res = await patch({ fact: "Refunds are owned by payments." });
      expect(res.status).toBe(202);
      expect(removeFact).toHaveBeenCalledTimes(1);
      expect(ingestMemory).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/contacts/from-research", () => {
    const clean = {
      contact: { name: "Jane Doe", email: "jane@acme.test", title: "CFO", linkedin: "https://linkedin.test/jane" },
      account: { name: "Acme", domain: "acme.test", industry: "Payments", description: "B2B payments" },
      findings: ["ships weekly", "hiring SREs"],
    };
    const withNul = (path: string): unknown => {
      const body = structuredClone(clean) as Record<string, unknown>;
      const m = /^findings\[(\d+)\]$/.exec(path);
      if (m) (body.findings as string[])[Number(m[1])] += NUL;
      else {
        const [group, key] = path.split(".");
        (body[group] as Record<string, string>)[key] += NUL;
      }
      return body;
    };

    // Every text field the route stores or ingests, one at a time: dropping any one field
    // from the guard fails exactly its own case.
    it.each([
      "contact.name",
      "contact.email",
      "contact.title",
      "contact.linkedin",
      "account.name",
      "account.domain",
      "account.industry",
      "account.description",
      "findings[0]",
      "findings[1]",
    ])("a NUL in %s alone is a 400 naming it, with no account, contact or ingest", async (field) => {
      const res = await FROM_RESEARCH(json("http://t/api/contacts/from-research", "POST", withNul(field)));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(refusal(field));
      const after = await rows();
      expect({ accounts: after.accounts, contacts: after.contacts }).toEqual({ accounts: 0, contacts: 0 });
      expect(ingestMemory).not.toHaveBeenCalled();
    });

    it("control: the same import without a NUL writes the account and contact and ingests each finding", async () => {
      const res = await FROM_RESEARCH(json("http://t/api/contacts/from-research", "POST", clean));
      expect(res.status).toBe(201);
      const after = await rows();
      expect({ accounts: after.accounts, contacts: after.contacts }).toEqual({ accounts: 1, contacts: 1 });
      expect(ingestMemory).toHaveBeenCalledTimes(2);
    });
  });

  describe("POST /api/briefs/:id/correct", () => {
    it.each([
      ["correction", { correction: `The queue runs on${NUL} Postgres now.` }],
      ["sectionHeading", { sectionHeading: `System${NUL} design`, correction: "The queue runs on Postgres now." }],
    ])("a NUL in %s alone is a 400 naming it, with no audit row and no ingest", async (field, body) => {
      const res = await CORRECT(json("http://t/api/briefs/b1/correct", "POST", body), {
        params: Promise.resolve({ id: "b1" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(refusal(field));
      expect(await rows()).toEqual(none);
      expect(ingestMemory).not.toHaveBeenCalled();
    });
  });

  describe("memory_write agent tool", () => {
    const runtime = () => {
      const values = new Map<string, string>([
        ["orgId", ORG],
        ["capabilityToken", "wcap_qa510"],
        ["actorId", "agent-case510"],
      ]);
      return { get: (k: string) => values.get(k) } as never;
    };
    const run = (context: { content: string; name: string }) =>
      (
        memoryWriteTool as unknown as { execute: (a: unknown) => Promise<{ episodeId: string | null; error?: string }> }
      ).execute({ context, runtimeContext: runtime() });

    it.each([
      ["content", { content: `Acme raised${NUL} $10M`, name: "Acme Corp" }],
      ["name", { content: "Acme raised $10M", name: `Acme${NUL} Corp` }],
    ])("a NUL in %s alone is invalid_input naming it, with no audit row and no ingest", async (field, context) => {
      expect(await run(context)).toEqual({ episodeId: null, error: `invalid_input: ${refusal(field)}` });
      expect(await rows()).toEqual(none);
      expect(ingestMemory).not.toHaveBeenCalled();
    });

    it("control: a clean write with an unknown token reaches check(), which audits the denial", async () => {
      const res = await run({ content: "Acme raised $10M", name: "Acme Corp" });
      expect(res.episodeId).toBeNull();
      expect(res.error).not.toMatch(/^invalid_input/);
      expect(res.error).toMatch(/^access denied: no valid capability/);
      expect((await rows()).audit).toBe(1);
    });
  });
});
