// POST /api/agents/[id]/run: stream a test run of an agent against one contact; check() gates the
// read before any contact data is looked up.
import { db } from "@/lib/db";
import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { provisionCopyAgentCapability } from "@/lib/copy-agent";
import { runCopyAgent } from "@/services/agents/runner";
import { agentDeactivatedResponse } from "@/services/agents/agent-active";

const enc = new TextEncoder();

function sseEvent(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

/** POST /api/agents/[id]/run: test-run an agent against a contact, streaming progress as SSE. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rc = await requireAccessContext();
  if (!rc) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = (await req.json()) as { contactId?: string };
  if (!body.contactId) {
    return Response.json({ error: "contactId required" }, { status: 400 });
  }

  // Gate BEFORE the contact read, not after. This handler returns the
  // contact's name, title, email and account to the caller, so tenant scoping
  // alone let any org member read any contact by id. Asking first also keeps a
  // refused caller from telling an existing contactId apart from a made-up one.
  const decision = await check(rc.ctx, { action: "memory.read", target: `agent:run:${id}` });
  if (!decision.allowed) return Response.json({ error: decision.reason }, { status: 403 });

  const [agentRow, contact] = await Promise.all([
    db.agent.findFirst({
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
    }),
    db.contact.findFirst({
      where: { id: body.contactId, orgId: rc.org.id },
      select: {
        id: true,
        name: true,
        title: true,
        email: true,
        account: { select: { name: true, domain: true } },
      },
    }),
  ]);

  if (!agentRow) return Response.json({ error: "agent not found" }, { status: 404 });
  if (!agentRow.active) return agentDeactivatedResponse();
  if (!contact) return Response.json({ error: "contact not found" }, { status: 404 });

  const agentRun = await db.agentRun.create({
    data: {
      orgId: rc.org.id,
      agentId: agentRow.id,
      status: "running",
      triggeredBy: rc.user.id,
      meta: { contactId: contact.id, contactName: contact.name, type: "test-run" },
    },
    select: { id: true },
  });

  const stream = new ReadableStream({
    async start(controller) {
      try {
        sseEvent(controller, "progress", { message: "Starting outreach agent…" });

        const capabilityToken = await provisionCopyAgentCapability(rc.org.id, rc.user.id);

        const result = await runCopyAgent({
          agentRow,
          contactName: contact.name,
          contactTitle: contact.title,
          contactEmail: contact.email,
          accountName: contact.account?.name,
          accountDomain: contact.account?.domain,
          orgId: rc.org.id,
          orgName: rc.org.name,
          campaignName: "Test run",
          capabilityToken,
          traceCtx: { orgId: rc.org.id, contactId: contact.id },
          agentRunId: agentRun.id,
          onProgress: (message) => sseEvent(controller, "progress", { message }),
        });

        await db.agentRun.update({
          where: { id: agentRun.id },
          data: { status: "completed", finishedAt: new Date() },
        });

        sseEvent(controller, "done", result);
      } catch (err) {
        await db.agentRun.update({
          where: { id: agentRun.id },
          data: { status: "failed", finishedAt: new Date() },
        });
        sseEvent(controller, "error", { message: err instanceof Error ? err.message : "Run failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
