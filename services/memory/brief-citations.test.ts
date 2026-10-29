// boundCitations decides what a brief may store; the re-check itself needs a database
// and is covered by brief-citations.realdb.test.ts.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("./guarded-store", () => ({ guardedMemory: {} }));

import { boundCitations, MAX_CITATIONS_PER_BRIEF } from "./brief-citations";

const cite = (sectionIndex: number, factId: string) => ({ sectionIndex, factId, factText: `text of ${factId}` });

describe("boundCitations", () => {
  it("keeps one citation per section and fact, in order", () => {
    expect(boundCitations([cite(0, "a"), cite(0, "a"), cite(1, "a"), cite(0, "b")], 2)).toEqual([
      cite(0, "a"),
      cite(1, "a"),
      cite(0, "b"),
    ]);
  });

  it("drops a citation for a section the brief does not have", () => {
    expect(boundCitations([cite(-1, "a"), cite(2, "b"), cite(1.5, "c"), cite(1, "d")], 2)).toEqual([cite(1, "d")]);
  });

  it(`stores at most ${MAX_CITATIONS_PER_BRIEF}`, () => {
    const many = Array.from({ length: MAX_CITATIONS_PER_BRIEF + 3 }, (_, i) => cite(0, `f${i}`));

    expect(boundCitations(many, 1)).toEqual(many.slice(0, MAX_CITATIONS_PER_BRIEF));
  });
});
