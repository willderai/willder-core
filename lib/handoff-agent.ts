// The Handoff agent's access identity. When a
// contractor/freelancer or new hire is granted scoped access to a sub-scope, this agent
// generates a briefing document bounded to exactly that grant. Unlike the copy agent
// (always org-root, per campaign), a handoff capability is scoped to the SPECIFIC
// sub-scope the grant covers — the whole point is that the briefing can't see more than
// the person it's for is allowed to see.
import { db } from "@/lib/db";
import {
  deriveGrantGovernance,
  generateCapabilityToken,
  hashCapabilityToken,
  type AccessContext,
} from "@/services/access";
import { HANDOFF_AGENT_ID, HANDOFF_AGENT_NAME } from "@/services/access/system-actors";

/** Stable agent identity for the handoff agent (shown in the audit log). */
export { HANDOFF_AGENT_ID, HANDOFF_AGENT_NAME };

/** The briefing generation is a single short-lived run, not a long campaign — the
 *  capability only needs to live long enough for one agent.generate() call. */
const DEFAULT_TTL_HOURS = 1;

/**
 * Mint a fresh, read-only capability token scoped to `scopePath` (the same sub-scope
 * the human grant covers — never wider) and persist its hash. The raw token is
 * returned once, to pass directly into `runHandoffAgent`.
 */
export async function provisionHandoffAgentCapability(
  orgId: string,
  scopePath: string,
  createdBy: string,
  ttlHours: number = DEFAULT_TTL_HOURS,
): Promise<string> {
  const token = generateCapabilityToken();
  // agent-scope-full-removal-provenance-gap-20260918: almost always ungoverned
  // (no /access/grants entry ever targets this agentId) — deriveGrantGovernance
  // only stamps true if one genuinely exists, so this stays a no-op today.
  const governance = await deriveGrantGovernance(orgId, HANDOFF_AGENT_ID);
  await db.capability.create({
    data: {
      orgId,
      agentId: HANDOFF_AGENT_ID,
      tokenHash: hashCapabilityToken(token),
      scopePath,
      permission: "read",
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      createdBy,
      ...governance,
    },
  });
  return token;
}

/** Build the agent AccessContext the guarded memory store expects, from a token. */
export function handoffAgentContext(orgId: string, token: string): AccessContext {
  return {
    orgId,
    actor: { type: "agent", id: HANDOFF_AGENT_ID, capabilityToken: token, name: HANDOFF_AGENT_NAME },
    origin: "agent-run",
  };
}
