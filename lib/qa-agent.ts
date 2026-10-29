// The QA agent's access identity.
// Unlike the other agents, QA's primary input is a RUNNING PRODUCT it drives black-box
// (an API base URL, or a browser), not the memory graph. It still reads
// memory (read-only, scope-bounded like Handoff/Architecture) for any stored specs,
// acceptance criteria, or per-run focus the human captured — so its capability follows
// the same rule: never wider than the human grant that triggered it.
import { db } from "@/lib/db";
import {
  deriveGrantGovernance,
  generateCapabilityToken,
  hashCapabilityToken,
  type AccessContext,
} from "@/services/access";
import { QA_AGENT_ID, QA_AGENT_NAME } from "@/services/access/system-actors";

/** Stable agent identity for the QA agent (shown in the audit log). */
export { QA_AGENT_ID, QA_AGENT_NAME };

/** A QA run is a single (long) session, not a standing campaign. The capability only
 *  needs to live long enough for one run — give browser sessions a little more room. */
const DEFAULT_TTL_HOURS = 2;

/**
 * Mint a fresh, read-only capability token scoped to `scopePath` (never wider than the
 * human grant that triggered it) and persist its hash. The raw token is returned once,
 * to pass into `runQaAgent`. Read-only: the QA agent inspects specs/focus, it never
 * writes memory.
 */
export async function provisionQaAgentCapability(
  orgId: string,
  scopePath: string,
  createdBy: string,
  ttlHours: number = DEFAULT_TTL_HOURS,
): Promise<string> {
  const token = generateCapabilityToken();
  // Almost always ungoverned
  // (no /access/grants entry ever targets this agentId) — deriveGrantGovernance
  // only stamps true if one genuinely exists, so this stays a no-op today.
  const governance = await deriveGrantGovernance(orgId, QA_AGENT_ID);
  await db.capability.create({
    data: {
      orgId,
      agentId: QA_AGENT_ID,
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
export function qaAgentContext(orgId: string, token: string): AccessContext {
  return {
    orgId,
    actor: { type: "agent", id: QA_AGENT_ID, capabilityToken: token, name: QA_AGENT_NAME },
    origin: "agent-run",
  };
}
