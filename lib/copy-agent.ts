// The copy agent's access identity (UC4 × UC2, Day 5). The campaign loop runs
// detached in Inngest, not inside a user request — so its memory reads can't ride a
// human session. Instead the agent reads as a NON-HUMAN actor authenticated by a
// capability token: scoped (org root), read-only, time-bounded, and audited on every
// read like any other access (access control applies to agents too).
//
// When a campaign starts, the route (which already verified the human can read
// memory) provisions a short-lived read capability for the copy agent and hands the
// raw token to the Inngest job via the event payload. The job rebuilds the agent
// AccessContext from that token and reads memory through the guarded store.
import { db } from "@/lib/db";
import {
  deriveGrantGovernance,
  generateCapabilityToken,
  hashCapabilityToken,
  orgRootPath,
  type AccessContext,
} from "@/services/access";
import { COPY_AGENT_ID, COPY_AGENT_NAME } from "@/services/access/system-actors";

/** Stable agent identity for the outbound copy agent (shown in the audit log). */
export { COPY_AGENT_ID };

/** Default lifetime of a campaign's copy-agent capability. A campaign's drafting
 *  fan-out completes well within this; the token expires on its own afterward. */
const DEFAULT_TTL_HOURS = 48;

/**
 * Mint a fresh, scoped, read-only capability token for the copy agent and persist
 * its hash (the raw token is returned once, to ride the Inngest event). Provisioning
 * is a system step justified by the human caller's verified memory-read access — it
 * never grants the agent more than `read` on the org root.
 */
export async function provisionCopyAgentCapability(
  orgId: string,
  createdBy: string,
  ttlHours: number = DEFAULT_TTL_HOURS,
): Promise<string> {
  const token = generateCapabilityToken();
  // agent-scope-full-removal-provenance-gap-20260918: almost always ungoverned
  // (no /access/grants entry ever targets this agentId) — deriveGrantGovernance
  // only stamps true if one genuinely exists, so this stays a no-op today.
  const governance = await deriveGrantGovernance(orgId, COPY_AGENT_ID);
  await db.capability.create({
    data: {
      orgId,
      agentId: COPY_AGENT_ID,
      tokenHash: hashCapabilityToken(token),
      scopePath: orgRootPath(orgId),
      permission: "read",
      expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000),
      ...governance,
      createdBy,
    },
  });
  return token;
}

/** Build the agent AccessContext the guarded memory store expects, from a token. */
export function copyAgentContext(orgId: string, token: string): AccessContext {
  return {
    orgId,
    actor: { type: "agent", id: COPY_AGENT_ID, capabilityToken: token, name: COPY_AGENT_NAME },
    origin: "agent-run",
  };
}
