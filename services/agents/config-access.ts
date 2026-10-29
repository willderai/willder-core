// Who may configure an agent, and which scopes they may point it at.
//
// The one rule this file enforces: an agent never gets more authority from its
// configuration than the person who configured it holds. An agent's configuration is
// authority in its own right. Its system prompt and tools decide what it does with the
// memory it reads, `settings.memoryScope` narrows the outreach agent's reads, and
// `settings.cron.scope` is where the nightly architecture sweep (lib/inngest/
// scheduled-jobs.ts) mints its own read token and files briefs and disputes, with no
// person present when it runs. So:
//
// - creating or editing an agent needs `access.manage` at the org root, the authority
//   that already mints tokens and grants (agents are org-wide, so the org root is the
//   only scope they have);
// - every scope written into an agent must be one the editor can read, the same test
//   the manual planning routes apply to the human who starts a run;
// - reading the system prompt and settings needs the same authority as writing them.
//   Every member sees the roster, but not the configuration behind it.
//
// Every refusal leaves one deny row: check() writes its own, and a value that is not a
// scope path at all is recorded through recordRefusal() before it can reach check()'s
// ltree cast.
import {
  can,
  check,
  invalidCallerScopePath,
  isMintableScopePath,
  isValidLtreePath,
  orgRootPath,
  recordRefusal,
  type AccessContext,
  type AccessDecision,
} from "@/services/access";

/** The access action that configuring an agent requires, at the org root. */
export const AGENT_CONFIG_ACTION = "access.manage" as const;

/** The scope agent configuration is decided at: agents belong to the whole org. */
export function agentConfigScope(orgId: string): string {
  return orgRootPath(orgId);
}

/** Decide whether the caller may create an agent in their org. Audited by check(). */
export function decideAgentCreate(ctx: AccessContext): Promise<AccessDecision> {
  return check(ctx, { action: AGENT_CONFIG_ACTION, scope: agentConfigScope(ctx.orgId), target: "agent:create" });
}

/**
 * Whether the caller may read agent configuration: the system prompt and the settings
 * that hold `memoryScope` and `cron.scope`. Reading it needs the same authority as
 * writing it. The prompt is authority in its own right, and the settings name scopes
 * the caller may hold no grant on.
 *
 * Not audited. The caller asked for the roster, not for the configuration, which is
 * left out of what they did ask for, the same way their unreadable runs are. A refusal
 * row here would record an attempt nobody made on every visit to the agents page.
 */
export async function mayReadAgentConfig(ctx: AccessContext): Promise<boolean> {
  const decision = await can(ctx, { action: AGENT_CONFIG_ACTION, scope: agentConfigScope(ctx.orgId) });
  return decision.allowed;
}

/** An agent as shown to a caller who may not read its configuration. */
export function withoutAgentConfig<T extends { systemPrompt: unknown; settings: unknown }>(
  agent: T,
): Omit<T, "systemPrompt" | "settings"> {
  const { systemPrompt: _systemPrompt, settings: _settings, ...shown } = agent;
  return shown;
}

/** A scope an edit would write into the agent, named by the setting that holds it. */
export interface AgentScopeSetting {
  setting: "memoryScope" | "cron.scope";
  scopePath: string;
}

/**
 * Check that the editor can read every scope an edit would write into agent `agentId`.
 * Returns null when all are readable, or the client-safe reason for the first that is
 * not. A value that is not a scope path is refused without reaching check().
 */
export async function refuseUnreadableAgentScopes(
  ctx: AccessContext,
  agentId: string,
  settings: AgentScopeSetting[],
): Promise<string | null> {
  for (const { setting, scopePath } of settings) {
    const target = `agent:${agentId}:${setting}`;
    // An agent writes its memory at these scopes, so a dashed label is refused as a write's would be.
    if (!isMintableScopePath(scopePath)) {
      const { reason, auditReason } = invalidCallerScopePath(scopePath, setting, isValidLtreePath(scopePath));
      await recordRefusal(ctx, {
        action: "memory.read",
        target: `${agentConfigScope(ctx.orgId)}/${target}`,
        auditReason,
      });
      return reason;
    }
    const decision = await check(ctx, { action: "memory.read", scope: scopePath, target });
    if (!decision.allowed) return decision.reason;
  }
  return null;
}
