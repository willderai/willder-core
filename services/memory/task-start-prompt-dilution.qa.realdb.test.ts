// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// The prompt the hook sends ranks the task-start block beside the task's name
// (rankingTextOf). It must widen what the block can find, never take away what the task's
// name alone already finds: a write in the scope whose text names the task.
//
// Real: Postgres, the capability check, the task-start read and the block as served
// (taskStartNotice), with the ranking text built exactly as the notice route builds it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/lib/generated/prisma/client";
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "qa_taskStartPromptDilution";
const SCOPE = `org_${ORG}.ops`;
const TASK = "ledger-idempotency-retry";
/** What a person really types: many words, none of them the task's. */
const PROMPT =
  "Please look at the failing CI shard, the vitest run in cli hooks is flaky on node 18 and the docs-connect URL test " +
  "broke after the init change; also check the eslint ratchet and knip output before pushing anything to the branch";
const ABOUT_TASK =
  "ledger-idempotency-retry: the dedupe now uses a unique index on (orgId, key), and a retry reads Retry-After first.";

describe.skipIf(!QA_URL)("a prompt never takes away what the task's name finds", () => {
  let db: PrismaClient;
  let taskStartNotice: (typeof import("@/mcp/task-start-notice"))["taskStartNotice"];
  let rankingTextOf: (typeof import("@/mcp/task-start-notice"))["rankingTextOf"];
  let seq = 0;
  let session = 0;
  let ctx: AccessContext;

  async function cleanup(): Promise<void> {
    await db.taskStartDelivery.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.memoryChunk.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.org.deleteMany({ where: { id: ORG } });
  }

  /** A fact version and its create event, as memory_ingest stores them, under no task. */
  async function fact(id: string, content: string): Promise<void> {
    const n = ++seq;
    const createdAt = new Date(Date.UTC(2026, 9, 1) + n * 1000);
    await db.memoryChunk.create({
      data: {
        id,
        orgId: ORG,
        content,
        scopePath: SCOPE,
        actorType: "agent",
        actorId: "importer",
        factVersion: true,
        createdAt,
      },
    });
    await db.changeEvent.create({
      data: {
        orgId: ORG,
        seq: BigInt(n),
        scopePath: SCOPE,
        recordType: "fact",
        recordId: id,
        op: "create",
        actorId: "importer",
        actorType: "agent",
        origin: "mcp",
        summary: content.slice(0, 200),
        createdAt,
      },
    });
  }

  const block = (taskText: string) =>
    taskStartNotice(ctx, { scopePath: SCOPE, sessionKey: `s-${++session}`, taskText, taskKey: TASK });

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ taskStartNotice, rankingTextOf } = await import("@/mcp/task-start-notice"));
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    seq = 0;
    await db.org.create({ data: { id: ORG, name: ORG } });
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId: "reader",
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "read",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    ctx = { orgId: ORG, actor: { type: "agent", id: "reader", capabilityToken: token }, origin: "mcp" };
  });

  it("still serves an older write about the task when the session also sends a long prompt", async () => {
    await fact("f-about", ABOUT_TASK);
    // More newer writes than the passing-mention window, none about the task or the prompt.
    for (let i = 0; i < 210; i++)
      await fact(`f-noise-${i}`, `Release note ${i}: tagged build ${i} and posted the changelog.`);

    const withoutPrompt = await block(rankingTextOf(TASK, ""));
    const withPrompt = await block(rankingTextOf(TASK, PROMPT));

    expect(withoutPrompt).toContain("unique index on (orgId, key)");
    expect(withPrompt).toContain("unique index on (orgId, key)");
  });

  it("still serves an older write about the task when many newer writes match only the prompt", async () => {
    await fact("f-about", ABOUT_TASK);
    // More newer writes matching the prompt than the read takes back, then enough others to
    // push the write about the task out of the passing-mention window.
    for (let i = 0; i < 40; i++)
      await fact(`f-prompt-${i}`, `The vitest shard in cli hooks is flaky on node 18, run ${i}.`);
    for (let i = 0; i < 170; i++)
      await fact(`f-noise-${i}`, `Release note ${i}: tagged build ${i} and posted the changelog.`);

    const withPrompt = await block(rankingTextOf(TASK, PROMPT));

    expect(await block(rankingTextOf(TASK, ""))).toContain("unique index on (orgId, key)");
    expect(withPrompt).toContain("unique index on (orgId, key)");
  });

  it("serves a recent write about the task the same with or without a prompt", async () => {
    await fact("f-about", ABOUT_TASK);
    const lineOf = (text: string | null) => text?.split("\n").find((line) => line.includes("f-about")) ?? null;

    const withoutPrompt = lineOf(await block(rankingTextOf(TASK, "")));
    const withPrompt = lineOf(await block(rankingTextOf(TASK, PROMPT)));

    expect(withoutPrompt).not.toBeNull();
    expect(withPrompt).toBe(withoutPrompt);
  });
});
