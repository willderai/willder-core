// Willder's MCP prompts. A client lists them as ready-made openings (Claude Code shows each as
// a slash command), so starting a task with what memory already holds is one pick.
//
// start_task opens a task with the facts Willder holds that bear on it, each cited with its
// source, and asks the agent to record what it learns. Its scopePath argument completes to the
// scopes the token may read.
//
// The one rule: the prompt reads as memory_query reads (guardedMemory.retrieve, named values
// checked, the same notes), scoped
// to the token's own scope unless the caller names one inside it, so the same audited
// memory.read decision is made, a scope outside the token is refused, and what is served is
// recorded for the stale-read and derived-write rules as a tool reply's would be. The
// completion offers only scopes at or below the token's own, and nothing to a token that may
// not read its own scope.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { can, resolveCallerScopePath, scopePathsStartingWith, type AccessContext } from "@/services/access";
import { guardedMemory } from "@/services/memory";
import { provenanceRank } from "@/services/memory/guarded-store";
import { serveLaterUpdatesFirst } from "@/services/memory/update-links";
import { derivedMarkersFor } from "./derived-write";
import { formatCitedFacts, storedVersionsBehind } from "./fact-citation";
import { NO_READABLE_MATCH_NOTE, incompleteReadNotes } from "./read-notes";
import { recordServedFacts, toolErrorText, type ResolvedCapability } from "./tools/tool-context";

/** How many facts start_task serves: memory_query's default page. */
export const START_TASK_FACT_LIMIT = 10;

/** How many scopes a completion offers at most: the most one completion result may carry. */
export const SCOPE_COMPLETION_LIMIT = 100;

/** Register Willder's prompts onto `server`, read as `ctx`/`cap`. */
export function registerWillderPrompts(server: McpServer, ctx: AccessContext, cap: ResolvedCapability): void {
  server.registerPrompt(
    "start_task",
    {
      title: "Start a task with Willder's memory",
      description:
        "Open a task with what Willder's memory holds about it, each fact cited with its source, then record what you learn with memory_ingest. Access-scoped to your token and audited.",
      argsSchema: {
        task: z.string().trim().min(1).describe("The task, in a sentence: what you are about to do."),
        // A default, not .optional(): the SDK declares completions only for a completable it can
        // see without unwrapping an optional, and an empty scope reads at the token's own.
        scopePath: completable(
          z.string().default("").describe("Scope to read within. Defaults to your token's scope."),
          (typed) => readableScopesStartingWith(ctx, cap, typed ?? ""),
        ),
      },
    },
    async ({ task, scopePath }) => {
      try {
        return {
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text: await openingFor(ctx, cap, task, scopePath) },
            },
          ],
        };
      } catch (e) {
        throw new McpError(ErrorCode.InvalidRequest, toolErrorText(e));
      }
    },
  );
}

/** start_task's opening message: the task, what memory holds on it (memory_query's read), and the ask to record. */
async function openingFor(
  ctx: AccessContext,
  cap: ResolvedCapability,
  task: string,
  scopePath: string,
): Promise<string> {
  const target = await resolveCallerScopePath(ctx, scopePath, cap, { onInvalid: "fallback" });
  const read = await guardedMemory.retrieve(
    ctx,
    { groupId: ctx.orgId, query: task, limit: START_TASK_FACT_LIMIT },
    target,
    { checkNamedValues: true },
  );
  const facts = serveLaterUpdatesFirst(read.facts, task, provenanceRank);
  const markers = await derivedMarkersFor(ctx, facts.flatMap(storedVersionsBehind));
  const known = facts.length
    ? await formatCitedFacts(ctx.orgId, facts, markers)
    : "Willder holds nothing you can read that matches this task yet.";
  await recordServedFacts(cap, facts, target);
  return [
    `I am starting this task: ${task}`,
    "",
    `What Willder's memory holds that bears on it (scope ${target}):`,
    known,
    ...(read.unheldValues?.length ? ["", NO_READABLE_MATCH_NOTE] : []),
    ...incompleteReadNotes(read).flatMap((note) => ["", note]),
    "",
    "Use what is settled, check what is only a lead, and record what you learn with memory_ingest so the next session starts from it.",
  ].join("\n");
}

/**
 * The scopes, at or below the token's own, that start with `typed`, when the token may read its
 * own scope right now, else none. Every grant a read is decided by covers its scope and
 * everything below it (check.ts), so a token that may read its own scope may read each of these.
 * One more than {@link SCOPE_COMPLETION_LIMIT} is returned when there are more, so the SDK
 * reports the result as cut (`hasMore`) when it trims it to the limit. The decision is can(),
 * the unaudited probe, because a completion runs on every keystroke and is not a read of memory.
 */
async function readableScopesStartingWith(
  ctx: AccessContext,
  cap: ResolvedCapability,
  typed: string,
): Promise<string[]> {
  const own = await can(ctx, { action: "memory.read", scope: cap.scopePath });
  if (!own.allowed) return [];
  const page = SCOPE_COMPLETION_LIMIT + 1;
  const registered = await scopePathsStartingWith(ctx.orgId, cap.scopePath, typed, page);
  return [...new Set([...(cap.scopePath.startsWith(typed) ? [cap.scopePath] : []), ...registered])].slice(0, page);
}
