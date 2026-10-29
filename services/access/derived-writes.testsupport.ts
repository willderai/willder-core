// The derived-write rule switched off, for unit tests that mock `@/lib/db` and test
// something else: every session is untainted, every write is an ordinary one and no fact
// carries a marker. The rule itself is tested on Postgres (mcp/derived-write.realdb.test.ts).
//
//   vi.mock("@/services/access/derived-writes", () => import("@/services/access/derived-writes.testsupport"));
//
// It stands in for the whole module and imports nothing from it: the real module reaches
// check.ts, whose imports lead back to the mocked path, so a factory that loads the
// original waits on itself.
export const MAX_DECLARED_SCOPES = 20;

/** Never thrown here; present so `instanceof` checks in the code under test still compile and run. */
export class DerivedWriteRefusedError extends Error {}

export async function recordScopesOfVersions(): Promise<void> {}

export async function recordScopesRead(): Promise<void> {}

export async function decideDerivedWrite(): Promise<string[]> {
  return [];
}

export async function derivedFromMarkers(): Promise<Map<string, string>> {
  return new Map();
}

export async function derivedFromTargets(): Promise<string[]> {
  return [];
}

/** The task-start claim's scope record (scopesShownCte), off: nothing to add to the statement. */
export function scopesShownCte(): null {
  return null;
}
