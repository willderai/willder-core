// POST /api/agents/[id]/prospect: run prospect research with a research-role agent; tenant-scoped, writes nothing.
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { bodyTypeRefusal } from "@/lib/json-type-name";
import { runProspectResearch } from "@/services/agents/runner";
import { agentDeactivatedResponse } from "@/services/agents/agent-active";

// POST /api/agents/:id/prospect — run structured prospect research.
// Body: { query: string } — e.g. "John Smith at Acme Corp" or "acme.com".
// Agent must have role="research". Returns { contact, account, findings, confidence }.
// Does NOT create any Postgres records — that's the separate /contacts/from-research step.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;

  let body: { query?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const wrongType = bodyTypeRefusal(body, ["query"]);
  if (wrongType) return NextResponse.json({ error: wrongType }, { status: 400 });

  const query = body.query?.trim();
  if (!query) return NextResponse.json({ error: "query is required" }, { status: 400 });

  const agentRow = await db.agent.findFirst({
    where: { id, orgId: rc.org.id },
    select: {
      active: true,
      id: true,
      agentKey: true,
      name: true,
      role: true,
      model: true,
      systemPrompt: true,
      tools: true,
      settings: true,
    },
  });

  if (!agentRow) return NextResponse.json({ error: "agent not found" }, { status: 404 });
  if (!agentRow.active) return agentDeactivatedResponse();
  if (agentRow.role !== "research") {
    return NextResponse.json({ error: "agent must have role=research" }, { status: 400 });
  }

  const result = await runProspectResearch({
    agentRow,
    query,
    orgId: rc.org.id,
  });

  return NextResponse.json(result);
}
