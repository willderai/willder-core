// services/memory/rule-copies.ts for a test whose database is a mock: no fact on its pages copies
// or contradicts a rule, so a read is served as retrieved, unlabelled, ranked as retrieved. The
// rule itself is tested on Postgres (mcp/confirmed-rule-guard.qa.realdb.test.ts).
//
//   vi.mock("@/services/memory/rule-copies", () => import("@/services/memory/rule-copies.testsupport"));
//
// It imports nothing from the module it stands in for: a factory that loads the mocked path
// waits on itself.
import type { MemoryFact } from "@/types";

export async function settledRuleCopiesFirst(_orgId: string, facts: readonly MemoryFact[]): Promise<MemoryFact[]> {
  return [...facts];
}

export function rankingLeadsApart(rank: (fact: MemoryFact) => number): (fact: MemoryFact) => number {
  return rank;
}

export function ruleLabelOf(_fact: MemoryFact): string | null {
  return null;
}
