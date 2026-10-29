// Database-gated: runs only when QA_DATABASE_URL names an isolated, migrated test
// Postgres; without it every test in this file is skipped, not failed.
//
// Conflicting writes, the half about delivery: the loser receives a change notice. services/memory/conflict.ts writes that notice as a `supersede` change event
// on the losing version, attributed to the winner's writer. This file asserts the part
// the write-side tests cannot see — that the losing writer's NEXT tool call carries it.
//
// Write-side tests cannot catch this: if change notices were read after the handler ran,
// the losing writer's own ingest result would consume the event its write had just caused,
// and its next call would carry no notice.
//
// Everything below runs for real: the real withChangeNotices wrapper around a real
// ingest announcement, real `change_events` rows with their per-org sequence, real
// `agent_cursors`, real capabilities, real check(), and the real ltree scope filter.
// Only the embedding is skipped, because `memory_chunks.embedding` is nullable and no
// part of this path reads it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PrismaClient } from "@/lib/generated/prisma/client";
// The leaf module, not the `@/services/access` barrel: the barrel builds the
// `@/lib/db` singleton at import time, before beforeAll points DATABASE_URL at the
// QA database.
import { hashCapabilityToken } from "@/services/access/capabilities";
import type { AccessContext } from "@/services/access";

const QA_URL = process.env.QA_DATABASE_URL;

const ORG = "org-qa-conflict-notice";
const SCOPE = "org_qa_cn.demo";
const WINNER = "agent-writer-a";
const LOSER = "agent-writer-b";
const ENTITY = "Launch date";

/** The header every change notice starts with; the clause is measured on this line. */
const NOTICE_HEADER = "Changed in your scope since your last call:";

describe.skipIf(!QA_URL)("a conflict's losing writer is told on its next tool call", () => {
  let db: PrismaClient;
  let recordIngestApplied: (typeof import("@/services/memory/fact-change-event"))["recordIngestApplied"];
  let toolCallNotice: (typeof import("./change-notices"))["toolCallNotice"];
  let withChangeNotices: (typeof import("./change-notices"))["withChangeNotices"];

  /** `agentId`'s access context, holding a write capability on {@link SCOPE}. */
  async function contextFor(agentId: string): Promise<AccessContext> {
    const token = `wcap_test_${Math.random().toString(36).slice(2)}`;
    await db.capability.create({
      data: {
        orgId: ORG,
        agentId,
        tokenHash: hashCapabilityToken(token),
        scopePath: SCOPE,
        permission: "write",
        grantGoverned: false,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return { orgId: ORG, actor: { type: "agent", id: agentId, capabilityToken: token } } as AccessContext;
  }

  /** The notice one of `ctx`'s tool results carries, or "" when it carries none. */
  function noticeOf(result: CallToolResult): string {
    const extra = result.content[1];
    return extra !== undefined && extra.type === "text" ? extra.text : "";
  }

  /** A tool call by `ctx`'s agent, wrapped the way every Willder tool is. */
  function call(ctx: AccessContext, handler: () => Promise<void>): Promise<CallToolResult> {
    const wrapped = withChangeNotices(
      async () => {
        await handler();
        return { content: [{ type: "text" as const, text: "the tool's own answer" }] };
      },
      () => toolCallNotice(ctx, SCOPE),
    );
    return wrapped();
  }

  /**
   * One writer's ingest, as the request path performs it: the store row first, then the
   * announcement, both inside the tool call that carries the writer's own notice.
   */
  function ingest(
    ctx: AccessContext,
    versionId: string,
    entityName: string,
    content: string,
    storedAt: Date,
  ): Promise<CallToolResult> {
    const agentId = ctx.actor.id;
    return call(ctx, async () => {
      await db.$executeRaw`
        INSERT INTO "memory_chunks" ("id","orgId","content","source","actorType","actorId","entityName","scopePath","createdAt")
        VALUES (${versionId}, ${ORG}, ${content}, 'mcp', 'agent', ${agentId}, ${entityName}, ${SCOPE}, ${storedAt})
      `;
      await recordIngestApplied(
        {
          groupId: ORG,
          content,
          name: entityName,
          actorType: "agent",
          origin: "mcp",
          actorId: agentId,
          scopePath: SCOPE,
        },
        versionId,
      );
    });
  }

  /** An ordinary later tool call that writes nothing: whatever notice it carries. */
  const nextCall = (ctx: AccessContext) => call(ctx, async () => {});

  /** The two writers of the production trial, 44 ms apart inside the one-second window. */
  const STORED_FIRST = new Date("2026-10-02T12:00:00.000Z");
  const STORED_SECOND = new Date(STORED_FIRST.getTime() + 44);

  beforeAll(async () => {
    process.env.DATABASE_URL = QA_URL;
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: QA_URL }) });
    ({ recordIngestApplied } = await import("@/services/memory/fact-change-event"));
    ({ toolCallNotice, withChangeNotices } = await import("./change-notices"));
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { orgId: ORG } });
    await db.changeEvent.deleteMany({ where: { orgId: ORG } });
    await db.agentCursor.deleteMany({ where: { orgId: ORG } });
    await db.capability.deleteMany({ where: { orgId: ORG } });
    await db.factEdge.deleteMany({ where: { orgId: ORG } });
    await db.$executeRaw`DELETE FROM "memory_chunks" WHERE "orgId" = ${ORG}`;
    await db.org.upsert({ where: { id: ORG }, update: {}, create: { id: ORG, name: ORG } });
  });

  it("carries the supersede notice on the loser's next call, naming its own version", async () => {
    const winner = await contextFor(WINNER);
    const loser = await contextFor(LOSER);

    await ingest(winner, "version-friday", ENTITY, "The launch date is FRIDAY.", STORED_FIRST);
    const ack = await ingest(loser, "version-monday", ENTITY, "The launch date is MONDAY.", STORED_SECOND);

    const notice = noticeOf(await nextCall(loser));

    // The losing write's own acknowledgement reports what existed when it arrived, not
    // the supersede its own transaction went on to write.
    expect(noticeOf(ack)).not.toContain("supersede");
    expect(notice).toContain(NOTICE_HEADER);
    expect(notice).toContain("supersede fact version-monday");
    expect(notice).toContain(`by ${WINNER}`);
    expect(notice).toContain("superseded by version-friday");
  });

  it("loses neither writer's change: one hears on its own result, the other on its next call", async () => {
    const one = await contextFor(WINNER);
    const two = await contextFor(LOSER);

    await ingest(one, "version-rome", "Office", "The office is in Rome.", STORED_FIRST);
    // The first writer's change was already there when the second writer called, so it
    // rides on that call's own result; the second writer's is new to the first, so it
    // waits for the first writer's next call. Each is delivered exactly once.
    const second = await ingest(two, "version-oslo", "Headcount", "Headcount is 12.", STORED_SECOND);

    expect(noticeOf(second)).toContain("create fact version-rome");
    expect(noticeOf(await nextCall(one))).toContain("create fact version-oslo");
  });

  it("shows the loser's notice once, not on every call after it", async () => {
    const winner = await contextFor(WINNER);
    const loser = await contextFor(LOSER);

    await ingest(winner, "version-friday", ENTITY, "The launch date is FRIDAY.", STORED_FIRST);
    await ingest(loser, "version-monday", ENTITY, "The launch date is MONDAY.", STORED_SECOND);

    await nextCall(loser);

    expect(noticeOf(await nextCall(loser))).toBe("");
  });
});
