// Time and agent-role wording the agents pages share.

/** "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const diffMin = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

/** How long a run took, or "running…" while it has no end. */
export function duration(start: string, end: string | null): string {
  if (!end) return "running…";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * A built-in agent as an action on memory (docs: agents are verbs on memory): what
 * a person asks it, and what it does, in one line. Roles without one (custom, the
 * retired research role) are named by their own name instead.
 */
export const AGENT_VERBS: Partial<Record<string, { verb: string; does: string }>> = {
  handoff: { verb: "Brief me", does: "Writes a scoped briefing of what someone needs to pick up the work." },
  architecture: {
    verb: "What contradicts this",
    does: "Plans from confirmed decisions and flags what contradicts them.",
  },
  qa: { verb: "Check this", does: "Reviews a change against the specs and decisions in memory." },
  copy: { verb: "Draft this", does: "Drafts copy from what memory holds about the audience." },
};
