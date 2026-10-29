// The order of a vector search's results, from two rankings of the same rows.
//
// A long row is embedded whole (its first 512 tokens) and as passages
// (services/memory/passages.ts). The two answer different questions. The whole-row
// embedding says what the row is about, and it is the better guide to which row answers a
// question. Ranking every row by the better of the two instead cost 11.6 points of
// recall@1 and 16 of MRR on BEAM in the retrieval lab, because a short passage that
// shares the query's words outscores the row whose whole meaning answers it. A passage is the only way to reach what the row says past
// its first 512 tokens.
//
// The rule this module enforces: the results alternate between the two rankings, the
// whole-row ranking first, each row served once. The best whole-row match is therefore
// always first, as it was before passages, and every second slot goes to the best
// passage match not already served.

/** A row found by the search, with its similarity to the query both ways. */
export interface RankedCandidate {
  /** Cosine similarity of the row's own embedding. */
  rowSimilarity: number;
  /** Cosine similarity of its best passage; null for a row too short to have passages. */
  passageSimilarity: number | null;
}

/**
 * The first `limit` candidates, alternating between the order of their own embedding's
 * similarity and the order of their best passage's (a row without passages taking its
 * own similarity there), whole-row order first, each candidate once.
 */
export function interleaveRowAndPassageRanks<T extends RankedCandidate>(candidates: T[], limit: number): T[] {
  const byRow = [...candidates].sort((a, b) => b.rowSimilarity - a.rowSimilarity);
  const byPassage = [...candidates].sort(
    (a, b) => (b.passageSimilarity ?? b.rowSimilarity) - (a.passageSimilarity ?? a.rowSimilarity),
  );
  const served = new Set<T>();
  const next = (order: T[]) => order.find((candidate) => !served.has(candidate));
  const result: T[] = [];
  for (let turn = 0; result.length < Math.min(limit, candidates.length); turn++) {
    const pick = next(turn % 2 === 0 ? byRow : byPassage);
    if (pick === undefined) continue;
    served.add(pick);
    result.push(pick);
  }
  return result;
}
