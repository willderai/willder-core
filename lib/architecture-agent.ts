// The Architecture agent's access identity.
// Given a scope of confirmed decisions/constraints/system-design/UX/business-logic in memory,
// this agent plans an architecture + schedule grounded ONLY in what it can retrieve and flags
// contradictions it finds among those facts. Like the Handoff agent, its capability is scoped
// to the SPECIFIC sub-scope the caller asks about (never wider) — the plan can only be built
// from what the triggering human is themselves allowed to see.
import { db } from "@/lib/db";
import {
  deriveGrantGovernance,
  generateCapabilityToken,
  hashCapabilityToken,
  type AccessContext,
} from "@/services/access";
import { ARCHITECTURE_AGENT_ID, ARCHITECTURE_AGENT_NAME } from "@/services/access/system-actors";

/** Stable agent identity for the architecture agent (shown in the audit log). */
export { ARCHITECTURE_AGENT_ID, ARCHITECTURE_AGENT_NAME };

/** Planning is a single short-lived run, not a long campaign — the capability only
 *  needs to live long enough for one agent.generate() call. */
const DEFAULT_TTL_HOURS = 1;

/**
 * Mint a fresh, read-only capability token scoped to `scopePath` (never wider than
 * the human grant that triggered it) and persist its hash. The raw token is returned
 * once, to pass directly into `runArchitectureAgent`.
 */
export async function provisionArchitectureAgentCapability(
  orgId: string,
  scopePath: string,
  createdBy: string,
  ttlHours: number = DEFAULT_TTL_HOURS,
): Promise<string> {
  const token = generateCapabilityToken();
  // agent-scope-full-removal-provenance-gap-20260918: almost always ungoverned
  // (no /access/grants entry ever targets this agentId) — deriveGrantGovernance
  // only stamps true if one genuinely exists, so this stays a no-op today.
  const governance = await deriveGrantGovernance(orgId, ARCHITECTURE_AGENT_ID);
  await db.capability.create({
    data: {
      orgId,
      agentId: ARCHITECTURE_AGENT_ID,
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
export function architectureAgentContext(orgId: string, token: string): AccessContext {
  return {
    orgId,
    actor: { type: "agent", id: ARCHITECTURE_AGENT_ID, capabilityToken: token, name: ARCHITECTURE_AGENT_NAME },
    origin: "agent-run",
  };
}
