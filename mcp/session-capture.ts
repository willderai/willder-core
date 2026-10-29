// Session-state capture on the server side: what a memory_ingest call marked as one changes.
//
// The `willder init` hook can keep one fact per task and session that says where the work
// stands (cli/hooks/willder-capture.mjs, opt-in). It writes through memory_ingest with the
// session's own token like any agent, so the access check, the audit row and the erasure
// filter apply unchanged. It marks the call with `_meta["willder/capture"] = "session-state"`,
// and the mark changes two things, both about the caller's own write:
//
// - No graph extraction (`skipGraphExtraction`, lib/inngest/memory-ingest.ts). The fact is
//   stored where memory_query's semantic leg and the task-start block read it, and announced
//   on the change feed, but no extraction job runs: it would be one metered LLM job per
//   capture, for text that only says where one session stopped. The cost is that the fact
//   is not in memory_query's graph answers.
// - No change notices and no task-start block ride on the reply (mcp/tools/tool-context.ts).
//   The hook discards the reply, so whatever rode on it would be marked told and never reach
//   the agent; left alone, it reaches the agent on its next prompt or tool call.
//
// The hook's claim-touches capture (cli/hooks/willder-touches.mjs) marks its memory_note calls
// `_meta["willder/capture"] = "touches"`. That mark changes only the second thing: no notices
// ride on the reply, since the hook forwards only the reply's overlap section to the agent.
//
// A capture that replaces its own session's earlier one (it names a `baseVersion`, under a capture's
// name and role) is the same episode: it is neither checked against nor counted toward the free
// plan's episode cap (lib/inngest/memory-ingest.ts), and other agents' change notices leave it out,
// so they hear of each session's capture once, at its first version (mcp/change-notices.ts).
//
// The one rule this file enforces: the mark only ever makes the server do less for the
// caller's own call. It grants nothing and is never checked as authority.

/** The tool-call `_meta` key that marks a session-state capture; the hook sets it (same name there). */
export const CAPTURE_META_KEY = "willder/capture";

/** The mark's one value. */
export const SESSION_STATE_CAPTURE = "session-state";

/** The mark on the hook's claim-touches calls. */
export const TOUCHES_CAPTURE = "touches";

/** The capture mark a tool call's request extra carries, if any. */
function captureMark(extra: unknown): unknown {
  if (typeof extra !== "object" || extra === null || !("_meta" in extra)) return undefined;
  const meta = extra._meta;
  return typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>)[CAPTURE_META_KEY] : undefined;
}

/** Whether a tool call's request extra marks it as a session-state capture. */
export function isSessionStateCapture(extra: unknown): boolean {
  return captureMark(extra) === SESSION_STATE_CAPTURE;
}

/** Whether a tool call's request extra marks it as either of the hook's captures, which carry no notices. */
export function isHookCapture(extra: unknown): boolean {
  const mark = captureMark(extra);
  return mark === SESSION_STATE_CAPTURE || mark === TOUCHES_CAPTURE;
}
