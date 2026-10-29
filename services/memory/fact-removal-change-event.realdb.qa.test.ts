// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Fact deletes and corrections on the change feed, against a
// real database: what a second agent actually reads after one agent removes a fact.
//
// fact-removal-change-event.realdb.test.ts asserts the rows removeFact() writes. This one reads them back
// through readChanges(), the path an agent uses, with the real check() on both
// sides. Two tenants and two scopes, so a delete announced in one scope is shown to
// be invisible from a sibling scope and from another tenant, and one case pins the
// "store removed nothing" rule on both rows at once: the applied audit row is
// written, the change event is not.
//
// Set QA_DATABASE_URL to an ISOLATED test database. Never the sandbox's inherited
// DATABASE_URL, which points at live Neon. Skips cleanly without it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at
// the QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";
import type { MemoryStore } from "./memory-store";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_fact_removal_feed";
const OTHER_ORG = "qa_fact_removal_feed_other";
const ENG = `org_${ORG}.eng`;
const SALES = `org_${ORG}.sales`;

describe.skipIf(!QA_URL)("a fact delete as another agent reads it from the feed", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let readChanges: (typeof import("./change-feed"))["readChanges"];

  const storeReporting = (removed: boolean): MemoryStore =>
    ({ removeFact: vi.fn().mockResolvedValue({ removed }) }) as unknown as MemoryStore;

  /** Mint a live capability and return the context an agent holding it acts as. */
  async function agent(
    orgId: string,
    agentId: string,
    scopePath: string,
    permission: "read" | "write",
  ): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
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
    return { orgId, actor: { type: "agent", id: agentId, capabilityToken: token }, origin: "mcp" };
  }

  const appliedDeletes = (orgId: string) => db.auditLog.findMany({ where: { orgId, action: "memory.delete.applied" } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ readChanges } = await import("./change-feed"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    for (const orgId of [ORG, OTHER_ORG]) {
      await db.changeEvent.deleteMany({ where: { orgId } });
      await db.auditLog.deleteMany({ where: { orgId } });
      await db.capability.deleteMany({ where: { orgId } });
      await db.org.upsert({ where: { id: orgId }, update: {}, create: { id: orgId, name: orgId } });
      await db.agentCursor.deleteMany({ where: { orgId } });
    }
  });

  it("shows a delete to a reader of that scope, with no summary", async () => {
    const editor = await agent(ORG, "editor", ENG, "write");
    const engReader = await agent(ORG, "eng-reader", ENG, "read");

    await new GuardedMemoryStore(storeReporting(true)).removeFact(editor, { groupId: ORG, factId: "fact-d" }, ENG);

    const { changes } = await readChanges(engReader, ENG);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      recordType: "fact",
      recordId: "fact-d",
      op: "delete",
      actorId: "editor",
      summary: "",
    });
  });

  it("shows a correction as a supersede, without the corrected text", async () => {
    const editor = await agent(ORG, "editor", ENG, "write");
    const engReader = await agent(ORG, "eng-reader", ENG, "read");

    await new GuardedMemoryStore(storeReporting(true)).removeFact(
      editor,
      { groupId: ORG, factId: "fact-c" },
      ENG,
      "Deploys freeze on Fridays.",
    );

    const { changes } = await readChanges(engReader, ENG);
    expect(changes.map((c) => [c.op, c.recordId, c.summary])).toEqual([["supersede", "fact-c", "corrected"]]);
  });

  it("keeps the delete out of a sibling scope and out of another tenant", async () => {
    const editor = await agent(ORG, "editor", ENG, "write");
    const salesReader = await agent(ORG, "sales-reader", SALES, "read");
    const otherTenant = await agent(OTHER_ORG, "outsider", `org_${OTHER_ORG}`, "read");

    await new GuardedMemoryStore(storeReporting(true)).removeFact(
      editor,
      { groupId: ORG, factId: "fact-secret" },
      ENG,
      "Acquisition target is Acme.",
    );

    expect((await readChanges(salesReader, SALES)).changes).toEqual([]);
    expect((await readChanges(otherTenant, `org_${OTHER_ORG}`)).changes).toEqual([]);
    // Pointing another tenant's reader at this tenant's scope is a denial, not an
    // empty page.
    await expect(readChanges(otherTenant, ENG)).rejects.toThrow();
  });

  it("writes the applied row but no event when the store removed nothing", async () => {
    const editor = await agent(ORG, "editor", ENG, "write");
    const engReader = await agent(ORG, "eng-reader", ENG, "read");

    await new GuardedMemoryStore(storeReporting(false)).removeFact(
      editor,
      { groupId: ORG, factId: "fact-gone-already" },
      ENG,
      "a correction that replaced nothing",
    );

    const applied = await appliedDeletes(ORG);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ target: `${ENG}/fact:fact-gone-already` });
    expect((await readChanges(engReader, ENG)).changes).toEqual([]);
  });
});
