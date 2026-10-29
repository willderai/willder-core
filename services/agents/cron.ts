// Cron-config selection for scheduled agents (UC10). Kept separate from the Inngest
// function itself so the "which agents does the nightly sweep pick up" logic is pure +
// unit-testable without the cron runtime. Cron config lives in Agent.settings JSON
// (`settings.cron = { enabled: true, scope: "<ltree path>" }`) — set via the existing
// PATCH /api/agents/:id, no dedicated endpoint (docs/willder_api.md).
import { db } from "@/lib/db";
import type { AgentRow } from "@/services/agents/runner";

export interface CronAgentSelection {
  id: string;
  orgId: string;
  scope: string;
  agentRow: AgentRow;
}

interface CronSettings {
  enabled?: boolean;
  scope?: string;
}

/** Read `settings.cron` defensively (settings is untyped JSON). */
export function cronConfig(settings: unknown): CronSettings | null {
  if (settings == null || typeof settings !== "object" || Array.isArray(settings)) return null;
  const cron = (settings as Record<string, unknown>).cron;
  if (cron == null || typeof cron !== "object" || Array.isArray(cron)) return null;
  return cron as CronSettings;
}

/**
 * All architecture agents opted into the nightly sweep: active, role `architecture`,
 * `settings.cron.enabled === true`, and a non-empty `settings.cron.scope`. Optionally
 * limited to one org (used by tests; the cron passes nothing = all orgs).
 */
export async function selectCronArchitectureAgents(orgId?: string): Promise<CronAgentSelection[]> {
  const rows = await db.agent.findMany({
    where: { role: "architecture", active: true, ...(orgId ? { orgId } : {}) },
    select: {
      id: true,
      orgId: true,
      agentKey: true,
      name: true,
      role: true,
      model: true,
      systemPrompt: true,
      tools: true,
      settings: true,
    },
  });

  const selected: CronAgentSelection[] = [];
  for (const r of rows) {
    const cron = cronConfig(r.settings);
    if (!cron?.enabled || !cron.scope) continue;
    selected.push({
      id: r.id,
      orgId: r.orgId,
      scope: cron.scope,
      agentRow: {
        agentKey: r.agentKey,
        name: r.name,
        role: r.role,
        systemPrompt: r.systemPrompt,
        tools: r.tools,
        model: r.model,
        settings: r.settings,
      },
    });
  }
  return selected;
}
