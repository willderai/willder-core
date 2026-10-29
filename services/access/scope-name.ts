// How long a scope's name may be.
//
// The one rule: no path stores a scope name longer than SCOPE_NAME_MAX characters. A name is
// shown to people and quoted to agents (memory_query's checked-scope note, mcp/read-notes.ts),
// and nothing a person names a scope needs more; an unbounded one only costs every place that
// reads it. Every path that names a scope (the scopes API, a connector's new scope, an org
// import) refuses a longer one with scopeNameTooLong's message.

/** The most characters (code points) a scope name may hold. */
export const SCOPE_NAME_MAX = 200;

/** Why `name` cannot name a scope, or null when it can. Counts characters, not UTF-16 units. */
export function scopeNameTooLong(name: string): string | null {
  // Counting stops just past the limit, so a very long name costs no more than a short one.
  let count = 0;
  for (const _ of name) if (++count > SCOPE_NAME_MAX) break;
  return count > SCOPE_NAME_MAX
    ? `A scope name may be at most ${SCOPE_NAME_MAX} characters; this one is longer. Choose a shorter name.`
    : null;
}
