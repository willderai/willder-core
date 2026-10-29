// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Fact deletes and corrections on the change feed, against a real database.
//
// The path under test is the one every delete takes: GuardedMemoryStore.removeFact,
// with the real check() against a real capability, the real applied-row writer and
// the real change-event writer. Only the memory store itself is a double, because it
// lives behind the memory service; what it reports (removed or not) is the input the
// feed must respect.
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

const ORG = "qa_fact_removal";
/** Under the org's own root: a delete only ever runs inside the caller's tenant. */
const SCOPE = `org_${ORG}.eng`;
const OTHER_SCOPE = `org_${ORG}.sales`;
const EDITOR = "agent-editor";

describe.skipIf(!QA_URL)("fact delete and correct events against a real database", () => {
  let db: PrismaClient;
  let GuardedMemoryStore: (typeof import("./guarded-store"))["GuardedMemoryStore"];
  let recordFactRemoved: (typeof import("./fact-change-event"))["recordFactRemoved"];
  let ctx: AccessContext;

  /** A store that reports the delete the way the memory service would. */
  const storeReporting = (removed: boolean): MemoryStore =>
    ({ removeFact: vi.fn().mockResolvedValue({ removed }) }) as unknown as MemoryStore;

  const events = () => db.changeEvent.findMany({ where: { orgId: ORG } });
  const appliedRows = () => db.auditLog.findMany({ where: { orgId: ORG, action: "memory.delete.applied" } });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ GuardedMemoryStore } = await import("./guarded-store"));
    ({ recordFactRemoved } = await import("./fact-change-event"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });

    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: EDITOR,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    ctx = { orgId: ORG, actor: { type: "agent", id: EDITOR, capabilityToken: token }, origin: "mcp" };
  });

  it("announces a delete the store made, in the scope it ran in", async () => {
    const guarded = new GuardedMemoryStore(storeReporting(true));

    await guarded.removeFact(ctx, { groupId: ORG, factId: "fact-1" }, SCOPE);

    const [event, ...rest] = await events();
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      recordType: "fact",
      recordId: "fact-1",
      op: "delete",
      scopePath: SCOPE,
      actorId: EDITOR,
      summary: "",
    });
    expect(await appliedRows()).toHaveLength(1);
  });

  it("announces a correction as a supersede naming what the fact was filed under, never the corrected text", async () => {
    // The corrected text is the correction's own `create`; the removal says what it corrected,
    // which is how a person erasure finds the correction once the fact is gone.
    const guarded = new GuardedMemoryStore({
      removeFact: vi
        .fn()
        .mockResolvedValue({ removed: true, storedScopePath: SCOPE, storedEntityName: "Release  calendar" }),
    } as unknown as MemoryStore);

    await guarded.removeFact(ctx, { groupId: ORG, factId: "fact-2" }, SCOPE, "Release freeze moved to Thursdays.");

    const [event] = await events();
    expect(event).toMatchObject({ recordId: "fact-2", op: "supersede", summary: "corrected: Release calendar" });
  });

  it("announces a correction of a fact filed under no name, or under another correction's name, as plainly corrected", async () => {
    for (const [factId, storedEntityName] of [
      ["fact-3", null],
      ["fact-4", "Human fact (edited) — 2026-10-13T10:00:00.000Z — corrects fact-1"],
    ] as const) {
      const guarded = new GuardedMemoryStore({
        removeFact: vi.fn().mockResolvedValue({ removed: true, storedScopePath: SCOPE, storedEntityName }),
      } as unknown as MemoryStore);
      await guarded.removeFact(ctx, { groupId: ORG, factId }, SCOPE, "Release freeze moved to Thursdays.");
    }

    expect((await events()).map((e) => [e.recordId, e.summary]).sort()).toEqual([
      ["fact-3", "corrected"],
      ["fact-4", "corrected"],
    ]);
  });

  it("announces nothing when the store removed nothing", async () => {
    const guarded = new GuardedMemoryStore(storeReporting(false));

    await guarded.removeFact(ctx, { groupId: ORG, factId: "fact-missing" }, SCOPE);

    expect(await events()).toHaveLength(0);
  });

  it("announces nothing when the delete is denied", async () => {
    const guarded = new GuardedMemoryStore(storeReporting(true));

    await expect(guarded.removeFact(ctx, { groupId: ORG, factId: "fact-3" }, OTHER_SCOPE)).rejects.toThrow();

    expect(await events()).toHaveLength(0);
    expect(await appliedRows()).toHaveLength(0);
  });

  it("leaves no applied row behind when the event cannot be recorded", async () => {
    await expect(
      recordFactRemoved({
        orgId: ORG,
        actorType: "agent",
        actorId: EDITOR,
        origin: "mcp",
        scopePath: `org_${ORG}..eng`,
        factId: "fact-4",
        removed: true,
      }),
    ).rejects.toThrow("valid ltree scopePath");

    expect(await appliedRows()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });
});
