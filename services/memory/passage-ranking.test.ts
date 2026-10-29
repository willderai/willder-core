// How a vector search orders the rows it found by their own embedding and by their
// passages (services/memory/passage-ranking.ts). Pure; no database.
import { describe, expect, it } from "vitest";
import { interleaveRowAndPassageRanks, type RankedCandidate } from "./passage-ranking";

const row = (
  id: string,
  rowSimilarity: number,
  passageSimilarity: number | null = null,
): RankedCandidate & { id: string } => ({
  id,
  rowSimilarity,
  passageSimilarity,
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("interleaveRowAndPassageRanks", () => {
  it("puts the row whose own embedding matches best first, even when another row's passage matches better", () => {
    const ranked = interleaveRowAndPassageRanks([row("passage-hit", 0.2, 0.95), row("whole-row", 0.8, 0.6)], 10);
    expect(ids(ranked)).toEqual(["whole-row", "passage-hit"]);
  });

  it("alternates the two orders, row order first, never serving a row twice", () => {
    const ranked = interleaveRowAndPassageRanks(
      [row("r1", 0.9, 0.5), row("r2", 0.8, 0.4), row("r3", 0.7, 0.3), row("p1", 0.1, 0.99), row("p2", 0.1, 0.98)],
      10,
    );
    expect(ids(ranked)).toEqual(["r1", "p1", "r2", "p2", "r3"]);
  });

  it("orders a row without passages among the passage hits by its own similarity", () => {
    const ranked = interleaveRowAndPassageRanks([row("a", 0.9, 0.5), row("short", 0.85), row("b", 0.2, 0.7)], 10);
    expect(ids(ranked)).toEqual(["a", "short", "b"]);
  });

  it("returns at most `limit` rows", () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`x${i}`, 1 - i / 100, i / 100));
    expect(interleaveRowAndPassageRanks(many, 7)).toHaveLength(7);
  });
});
