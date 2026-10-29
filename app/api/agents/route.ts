// GET/POST /api/agents: list the org's agents or create a custom one; scoped to the caller's org.
// Creating needs `access.manage` at the org root (services/agents/config-access.ts).
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { pickPage, readPickQuery } from "@/lib/pick-query";
import { readableScopePaths } from "@/services/access";
import { escapeLikePrefix } from "@/services/access/scope-containment";
import { AVAILABLE_TOOL_KEYS } from "@/services/agents";
import { decideAgentCreate, mayReadAgentConfig, withoutAgentConfig } from "@/services/agents/config-access";
import { summarizeVisibleRuns } from "@/services/agents/run-visibility";

// GET /api/agents — list the org's pre-configured agents.
//
// An agent itself is org-wide: every member sees the roster. Its run history is
// not — a run belongs to the memory scope it was started at. So the run count
// and the last run shown per agent cover only the runs this caller may read
// (services/agents/run-visibility.ts). The raw relation counts every run in the
// org, which would tell a member how much agent activity is happening inside
// scopes they hold no grant on. Nor is its configuration: the system prompt and settings
// are returned only to a caller who may configure agents (services/agents/config-access.ts).
//
// `?kind=builtin` lists only the product's own agents, a fixed handful, for a page that
// shows them as actions and pages through the rest (GET /api/agents/roster).
//
// `?limit=N&q=text` answers the agent pickers (lib/pick-query.ts): the first N agents,
// built-in or custom, whose name or key holds the text, by name, as
// `{ agents: [{ id, agentKey, name, role }], more }`.
export async function GET(req?: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = req ? new URL(req.url).searchParams : new URLSearchParams();
  const pick = readPickQuery(params);
  if (pick && "error" in pick) return NextResponse.json({ error: pick.error }, { status: 400 });
  if (pick) {
    if (params.has("kind")) return NextResponse.json({ error: "limit cannot be combined with kind" }, { status: 400 });
    // Names and keys only: a picker needs no config and no run history.
    const text = { contains: escapeLikePrefix(pick.search), mode: "insensitive" as const };
    const rows = await db.agent.findMany({
      where: { orgId: rc.org.id, ...(pick.search ? { OR: [{ name: text }, { agentKey: text }] } : {}) },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: pick.limit + 1,
      select: { id: true, agentKey: true, name: true, role: true },
    });
    const page = pickPage(rows, pick.limit);
    return NextResponse.json({ agents: page.rows, more: page.more });
  }

  const builtinOnly = params.get("kind") === "builtin";
  const agents = await db.agent.findMany({
    where: { orgId: rc.org.id, ...(builtinOnly ? { role: { not: "custom" } } : {}) },
    orderBy: { role: "asc" },
  });

  const readable = await readableScopePaths(rc.ctx);
  const [visible, configReadable] = await Promise.all([
    summarizeVisibleRuns(
      rc.org.id,
      readable,
      agents.map((agent) => agent.id),
    ),
    mayReadAgentConfig(rc.ctx),
  ]);

  return NextResponse.json({
    agents: agents.map((agent) => {
      const summary = visible.get(agent.id);
      const lastRun = summary?.lastRun;
      return {
        ...(configReadable ? agent : withoutAgentConfig(agent)),
        _count: { runs: summary?.runs ?? 0 },
        runs: lastRun ? [lastRun] : [],
      };
    }),
  });
}

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(80),
  systemPrompt: z.string().max(4000).optional(),
  tools: z.array(z.enum(AVAILABLE_TOOL_KEYS as [string, ...string[]])).default([]),
  model: z.string().max(120).optional(),
});

/**
 * POST /api/agents — create a new custom agent. A custom agent can be run by anyone who
 * may run agents, with their authority, so writing its prompt and tools is reserved to
 * people who may manage access.
 */
export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const decision = await decideAgentCreate(rc.ctx);
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = CreateAgentSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 });

  const { name, systemPrompt, tools, model } = parsed.data;
  const agentKey = `custom-${Date.now()}`;

  const agent = await db.agent.create({
    data: {
      orgId: rc.org.id,
      agentKey,
      name,
      role: "custom",
      systemPrompt: systemPrompt ?? null,
      tools,
      model: model ?? null,
    },
  });

  return NextResponse.json({ agent }, { status: 201 });
}
