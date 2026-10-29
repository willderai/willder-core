/**
 * Stores feedback a user sends from inside their AI client, through the MCP
 * `send_feedback` tool.
 *
 * The one rule: feedback goes to the people who run this server and nowhere
 * else. It is stored against the sender's org and agent, never shown to
 * another org, and never published. Each agent may send at most
 * FEEDBACK_HOURLY_LIMIT items an hour, so a looping agent cannot flood it.
 */
import { db } from "@/lib/db";

export const FEEDBACK_KINDS = ["bug", "request", "praise", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_MESSAGE_MAX = 4000;
export const FEEDBACK_CONTEXT_MAX = 2000;
export const FEEDBACK_HOURLY_LIMIT = 20;

export interface FeedbackInput {
  orgId: string;
  agentId: string;
  kind: FeedbackKind;
  message: string;
  context?: string;
}

export type FeedbackResult = { stored: true; id: string } | { stored: false; reason: "rate_limited" };

/**
 * Advisory-lock namespace for the per-agent feedback limit. Postgres advisory locks
 * share one server-wide space; the two-key form keeps this apart from every other
 * lock (services/memory/change-events.ts uses 8_241_001): the first key names the
 * purpose, the second the agent.
 */
const FEEDBACK_LIMIT_LOCK_NAMESPACE = 8_241_002;

/** Stores one piece of feedback, unless this agent has hit its hourly limit. */
export async function submitProductFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  return db.$transaction(async (tx) => {
    // MCP clients send tool calls in parallel. Without this lock every call in a burst
    // reads the same count before any of them inserts, and the whole burst is stored.
    // Held until commit, so the next call's count sees this call's row.
    //
    // `hashtext` narrows (org, agent) to int4, so two agents can collide. A collision
    // only makes those two agents wait for each other; each one's count still filters
    // on its own org and agent, so it never refuses a call that is under the limit.
    // Called in FROM because the function returns void, which the Prisma pg adapter
    // cannot read back as a column.
    await tx.$queryRaw`
      SELECT true AS locked
      FROM pg_advisory_xact_lock(
        ${FEEDBACK_LIMIT_LOCK_NAMESPACE}::int4,
        hashtext(${input.orgId} || '/' || ${input.agentId})::int4
      )
    `;
    const recent = await tx.productFeedback.count({
      where: { orgId: input.orgId, agentId: input.agentId, createdAt: { gte: since } },
    });
    if (recent >= FEEDBACK_HOURLY_LIMIT) return { stored: false, reason: "rate_limited" } as const;

    const row = await tx.productFeedback.create({
      data: {
        orgId: input.orgId,
        agentId: input.agentId,
        kind: input.kind,
        message: input.message,
        context: input.context || null,
      },
      select: { id: true },
    });
    return { stored: true, id: row.id } as const;
  });
}
