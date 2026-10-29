// One identifier for one agent across grants and capability tokens.
//
// Access decisions name an agent by its `agentKey` ("copy-agent", "custom-...",
// or a free-text client name such as "mcp-client" for an agent with no Agent
// row). That string is the runtime actor id check() evaluates, a capability's
// `agentId`, and an agent grant's `granteeId`. The grant-revoke cascade and
// check()'s grant re-derivation join those last two columns by equality, so a
// grant stored under one name for an agent and a token stored under another
// never meet: revoking the grant would leave the token live until expiry.
//
// The rule this module enforces: every write that names an agent stores the
// canonical key returned by canonicalAgentId(), never its database id or name,
// and never an id the product already writes under for someone else.

import { db } from "@/lib/db";
import { reservedActorKind } from "./system-actors";

export type AgentIdResolution = { ok: true; agentId: string } | { ok: false; error: string };

/**
 * Resolve an agent reference supplied by a caller to the identifier grants and
 * capabilities store.
 *
 * - The `agentKey` of an Agent row in `orgId` is already canonical.
 * - The database `id` of an Agent row in `orgId` resolves to that row's key.
 * - The `name` of exactly one Agent row in `orgId` resolves to that row's key.
 *   The name is the only label the app shows for an agent, so it is what a
 *   person typing an agent into a form will enter. A name shared by several
 *   agents is refused rather than guessed.
 * - Anything else is an agent with no Agent row (an external MCP client, say)
 *   and is its own identifier, returned unchanged, unless it is an actor id the
 *   product writes under for a connector sync, a workflow step, the system, the
 *   org or a person. That is refused, so a token cannot file its writes under
 *   another author. User ids are checked in every org, since a person can
 *   belong to more than one.
 *
 * Earlier rules win, so an existing key is never rewritten. Lookups are
 * tenant-scoped: another org's Agent id or name is treated as free text.
 */
export async function canonicalAgentId(orgId: string, agentRef: string): Promise<AgentIdResolution> {
  const byKey = await db.agent.findUnique({
    where: { orgId_agentKey: { orgId, agentKey: agentRef } },
    select: { agentKey: true },
  });
  if (byKey) return { ok: true, agentId: byKey.agentKey };

  const byId = await db.agent.findFirst({
    where: { orgId, id: agentRef },
    select: { agentKey: true },
  });
  if (byId) return { ok: true, agentId: byId.agentKey };

  const byName = await db.agent.findMany({
    where: { orgId, name: agentRef },
    select: { agentKey: true },
    take: 2,
  });
  if (byName.length > 1) {
    return {
      ok: false,
      error: `more than one agent is named "${agentRef}"; choose the agent from the list or send its agentKey`,
    };
  }
  if (byName[0]) return { ok: true, agentId: byName[0].agentKey };

  const reserved = await reservedAgentIdReason(orgId, agentRef);
  if (reserved) {
    return {
      ok: false,
      error: `"${agentRef}" is reserved for ${reserved} and cannot name an agent; send the agent's agentKey from /api/agents, or give the client a different name`,
    };
  }
  return { ok: true, agentId: agentRef };
}

/**
 * Why `agentRef` may not be used as a free-text agent id, or null when it may.
 *
 * An agent id is the actor id of every write made under it, so it must not be one
 * the product records for another kind of writer: a reserved system actor
 * (services/access/system-actors.ts), the org itself (its own extraction writes
 * carry the org id), or a person's user id.
 */
async function reservedAgentIdReason(orgId: string, agentRef: string): Promise<string | null> {
  const kind = reservedActorKind(agentRef);
  if (kind) return kind;
  if (agentRef === orgId) return "this organization's own writes";
  const person = await db.user.findUnique({ where: { id: agentRef }, select: { id: true } });
  return person ? "a person's writes" : null;
}
