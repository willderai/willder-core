// GET/PATCH /api/agents/[id]: read or edit one agent; every lookup is scoped to the caller's org.
// Editing needs `access.manage` at the org root, and every scope written into the agent
// must be one the editor can read (services/agents/config-access.ts).
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { check, readableScopePaths } from "@/services/access";
import { AVAILABLE_TOOL_KEYS } from "@/services/agents";
import {
  AGENT_CONFIG_ACTION,
  agentConfigScope,
  mayReadAgentConfig,
  refuseUnreadableAgentScopes,
  withoutAgentConfig,
  type AgentScopeSetting,
} from "@/services/agents/config-access";
import { publicRunMeta, recentVisibleRuns, summarizeVisibleRuns } from "@/services/agents/run-visibility";

// GET /api/agents/:id — single agent with its last five runs.
//
// The embedded runs follow the per-agent run list's rule (services/agents/run-visibility.ts):
// only runs whose scope the caller can read are returned, without the QA target's
// credential. The five are the newest five of those, and `_count.runs` counts the
// same set, so a caller is told the same thing whether the runs they cannot read
// exist or not. The raw relation count, or five taken before the filter, would
// each reveal how much agent activity sits in scopes this caller holds no grant on.
//
// The system prompt and settings are returned only to a caller who may configure agents
// (services/agents/config-access.ts); anyone else gets the agent without them.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  const agent = await db.agent.findFirst({ where: { id, orgId: rc.org.id } });
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });

  const readable = await readableScopePaths(rc.ctx);
  const [recent, visible, configReadable] = await Promise.all([
    recentVisibleRuns(rc.org.id, readable, agent.id, 5),
    summarizeVisibleRuns(rc.org.id, readable, [agent.id]),
    mayReadAgentConfig(rc.ctx),
  ]);
  const runs = recent.map((run) => ({ ...run, meta: publicRunMeta(run.meta) }));
  const shown = configReadable ? agent : withoutAgentConfig(agent);

  return NextResponse.json({
    agent: { ...shown, runs, _count: { runs: visible.get(agent.id)?.runs ?? 0 } },
  });
}

const PatchAgentSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  systemPrompt: z.string().max(4000).nullable().optional(),
  tools: z.array(z.enum(AVAILABLE_TOOL_KEYS as [string, ...string[]])).optional(),
  model: z.string().max(120).nullable().optional(),
  active: z.boolean().optional(),
  memoryScope: z.string().max(500).nullable().optional(),
  cron: z
    .object({ enabled: z.boolean(), scope: z.string().max(500) })
    // The agents page sends { enabled: false, scope: "" } when the sweep is off and no
    // scope was picked. That names no scope, so it is stored as a cleared sweep and needs
    // no scope decision. An enabled sweep keeps its scope and is decided as written.
    .transform((cron) => (!cron.enabled && cron.scope.trim() === "" ? null : cron))
    .nullable()
    .optional(),
});

/**
 * PATCH /api/agents/:id — update name, system prompt, tools, model, active state,
 * memory scope or nightly sweep.
 *
 * The edit is decided before the agent is looked up. The decision is `access.manage` at
 * the org root whichever agent is named, so a caller without it gets the same 403, and
 * the same recorded refusal, for a real agent as for an id that was never issued. Only
 * an editor learns whether the id exists. Each scope the edit names is then decided
 * against the editor before anything is written.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  const decision = await check(rc.ctx, {
    action: AGENT_CONFIG_ACTION,
    scope: agentConfigScope(rc.org.id),
    target: `agent:${id}:edit`,
  });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const existing = await db.agent.findFirst({ where: { id, orgId: rc.org.id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const parsed = PatchAgentSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });

  const scopes: AgentScopeSetting[] = [];
  if (parsed.data.memoryScope != null) scopes.push({ setting: "memoryScope", scopePath: parsed.data.memoryScope });
  if (parsed.data.cron != null) scopes.push({ setting: "cron.scope", scopePath: parsed.data.cron.scope });
  const refused = await refuseUnreadableAgentScopes(rc.ctx, existing.id, scopes);
  if (refused) return NextResponse.json({ error: refused }, { status: 403 });

  // Merge all settings-backed fields into the existing settings object once, so
  // multiple settings-backed fields (memoryScope, cron) coexist without clobbering
  // each other or any other keys already present in settings.
  const settingsTouched = parsed.data.memoryScope !== undefined || parsed.data.cron !== undefined;
  const mergedSettings = {
    ...(typeof existing.settings === "object" && existing.settings !== null ? existing.settings : {}),
    ...(parsed.data.memoryScope !== undefined && { memoryScope: parsed.data.memoryScope }),
    ...(parsed.data.cron !== undefined && { cron: parsed.data.cron }),
  };

  const agent = await db.agent.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined && { name: parsed.data.name }),
      ...(parsed.data.systemPrompt !== undefined && { systemPrompt: parsed.data.systemPrompt }),
      ...(parsed.data.tools !== undefined && { tools: parsed.data.tools }),
      ...(parsed.data.model !== undefined && { model: parsed.data.model }),
      ...(parsed.data.active !== undefined && { active: parsed.data.active }),
      ...(settingsTouched && { settings: mergedSettings }),
    },
  });

  return NextResponse.json({ agent });
}
