// A deactivated agent does no new work.
//
// An admin switches an agent off with PATCH /api/agents/:id { active: false }. The
// scheduled sweep already skips such an agent (cron.ts). This file is the same rule
// for everything else that runs one: a route that starts a run refuses, and a run
// already under way stops at its next step, because every driver reloads the agent
// row before it plans and every executor rechecks it before each plan step.
//
// The run's own agent row is what is checked, never the capability token the run
// reads memory with. Built-in and custom QA and architecture agents all read
// memory under one shared system key (lib/qa-agent.ts, lib/architecture-agent.ts),
// so the token cannot tell a deactivated custom agent from an active one; its row
// can. Reactivating the agent lets new runs start again; a run stopped by the
// switch stays failed.
import { db } from "@/lib/db";

/** What a caller is told when the agent it asked to run is switched off. */
export const AGENT_DEACTIVATED_MESSAGE =
  "agent is deactivated, so it cannot run. An org admin can reactivate it on the Agents page.";

/** Thrown by a run driver that reloads an agent row and finds it switched off. */
export class AgentDeactivatedError extends Error {
  constructor() {
    super(AGENT_DEACTIVATED_MESSAGE);
    this.name = "AgentDeactivatedError";
  }
}

/** The refusal a route returns instead of starting or resuming a run for a deactivated agent. */
export function agentDeactivatedResponse(): Response {
  return Response.json({ error: AGENT_DEACTIVATED_MESSAGE }, { status: 409 });
}

/**
 * Whether the agent row `agentId` (its database id, as an AgentRun stores it) in
 * `orgId` is switched off. A missing row is not reported as deactivated: the
 * caller already handles a run whose agent is gone.
 */
export async function isAgentDeactivated(orgId: string, agentId: string): Promise<boolean> {
  const row = await db.agent.findFirst({ where: { id: agentId, orgId }, select: { active: true } });
  return row !== null && !row.active;
}

/**
 * Throws AgentDeactivatedError when the run's agent has been switched off. An
 * executor calls this at every plan-step boundary, so a run already under way stops
 * before its next step instead of running the rest of a plan loaded at its start.
 */
export async function assertAgentActive(orgId: string, agentId: string): Promise<void> {
  if (await isAgentDeactivated(orgId, agentId)) throw new AgentDeactivatedError();
}
