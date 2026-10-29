// GET /api/changes/notice — layer 2 of the change feed: the one call
// the client hook installed by `willder init` makes (cli/hooks/willder-changes.mjs).
//
// A coding agent that is busy with files and shell commands may not call a Willder
// tool for a long time, or at all, so layer 1 (what rides on every MCP tool result)
// never reaches it. The hook asks this route on each prompt and after each of the
// agent's tool calls, and passes on whatever it gets back as context.
//
// The answer is exactly what layer 1 would attach, for the same agent: the task-start
// block on a session's first call, then the change notices. The task is
// the X-Willder-Task header, read as the MCP route reads it. On a prompt the hook also
// sends the prompt (X-Willder-Prompt), which ranks the block as a tool call's arguments do. Both paths share the
// server-held cursor (mcp/change-notices.ts), so a change is told to an agent once, by
// whichever path asks first. The block is told once per session, task and scope (the
// delivered_to claim in services/memory/task-start.ts). The hook names its session in
// X-Willder-Session, the agent CLI's own session id; an agent CLI's MCP calls carry their
// connection's session instead (mcp/connection-session.ts), which the hook cannot know, so
// a session that uses both paths can be told the block once by each. A block finished after
// the hook stopped waiting is not claimed, and its next poll is told it instead. When Claude
// Code compacts the session's context, the hook asks once more with X-Willder-Reason: compact,
// which makes a block delivered before this request due again for that session: the model after
// the compaction no longer holds it, and compaction keeps the session id. After a /clear it asks
// with X-Willder-Reason: clear. Either lays the block out as a boundary's, verified first.
//
// The one rule this route enforces: a token that may not read its own scope learns
// nothing about the org's writes from asking. Its answer is the quiet answer, and it
// costs the same whether or not anything was written — the decision is made first,
// on every poll, before the feed is looked at. The denial is audited once when it
// starts, not on every poll that repeats it, since the hook polls on every tool
// call. Unknown and revoked tokens still get a 401 — the hook stays silent on any
// failure, and a person debugging a bad token needs to see it.
import { resolveCapability } from "@/services/access";
import type { AccessContext } from "@/services/access";
import { MISSING_BEARER_TOKEN_MESSAGE, bearerToken } from "@/lib/bearer-token";
import { toolCallNotice } from "@/mcp/change-notices";
import {
  PROMPT_HEADER,
  REASON_HEADER,
  SESSION_HEADER,
  TASK_HEADER,
  connectionTaskOf,
  headerSaysBoundary,
  headerSaysCompacted,
  headerPromptOf,
  headerSessionOf,
  rankingTextOf,
} from "@/mcp/task-start-notice";
import { HOOK_CLAIM_BUDGET_MS, abandonedSignal } from "@/mcp/connection-session";

export const runtime = "nodejs";
// Every call re-authenticates and reads live state; nothing here may be cached.
export const dynamic = "force-dynamic";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function GET(req: Request): Promise<Response> {
  // Taken first, before any await: a block delivered after this moment was told after the
  // compaction this request may report, so it must stay served.
  const receivedAt = new Date();
  const token = bearerToken(req);
  if (!token) {
    return json(401, { error: MISSING_BEARER_TOKEN_MESSAGE });
  }

  const cap = await resolveCapability(token, "api");
  if (!cap) return json(401, { error: "Invalid or unknown capability token." });

  const ctx: AccessContext = {
    orgId: cap.orgId,
    actor: { type: "agent", id: cap.agentId, capabilityToken: token },
    origin: "api",
  };
  // The token's own scope, as layer 1 uses: there is no `scope` parameter, so a
  // hook cannot be pointed somewhere its MCP twin would not look. toolCallNotice
  // decides read access before it looks at anything, and answers a denied token
  // with null, as it answers a quiet one.
  // The prompt, when the hook sends one, ranks the block beside the task's name and goes no
  // further than this request.
  const task = connectionTaskOf(req.headers.get(TASK_HEADER));
  const taskText = rankingTextOf(task, headerPromptOf(req.headers.get(PROMPT_HEADER)));
  const notice = await toolCallNotice(ctx, cap.scopePath, {
    taskStart: {
      sessionKey: headerSessionOf(req.headers.get(SESSION_HEADER)),
      taskText,
      taskKey: task,
      // The hook stops waiting after 2 s; a block finished later, on a cold start say, is left
      // for its next poll rather than claimed for a reply it never reads.
      abandoned: abandonedSignal(req, HOOK_CLAIM_BUDGET_MS),
      ...(headerSaysCompacted(req.headers.get(REASON_HEADER)) ? { compactedAt: receivedAt } : {}),
      ...(headerSaysBoundary(req.headers.get(REASON_HEADER)) ? { boundary: true } : {}),
    },
  });
  return json(200, { notice });
}
