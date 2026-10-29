// Supplementary context is opt-in compact on reads only. A preference changes
// delivery, never access or a write's pre-handler notices.

/** Tool-call metadata and HTTP header carrying the same read-context preference. */
export const CONTEXT_META_KEY = "willder/context";
export const CONTEXT_HEADER = "x-willder-context";

export type ContextMode = "full" | "compact";

/** Only the two documented values select a mode; malformed preferences retain full delivery. */
export function contextModeOf(value: unknown): ContextMode {
  return value === "compact" ? "compact" : "full";
}

/** A call's explicit preference wins over the connection's, including an invalid value (full). */
export function callContextMode(extra: unknown, connectionMode: ContextMode = "full"): ContextMode {
  if (typeof extra !== "object" || extra === null || !("_meta" in extra)) return connectionMode;
  const meta = extra._meta;
  if (typeof meta !== "object" || meta === null || !(CONTEXT_META_KEY in meta)) return connectionMode;
  return contextModeOf((meta as Record<string, unknown>)[CONTEXT_META_KEY]);
}

/** A compact response does not claim that its deferred feed is empty or current. */
export const CONTEXT_DEFERRED = "Change notices deferred; memory_changes reads pending changes.";
