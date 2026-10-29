// rankByProvenance against a hostile actorType: a value naming an inherited
// Object property ("toString", "constructor") must still rank as a real tier, or
// the comparator returns NaN and the sort order is unspecified.
import { describe, expect, it } from "vitest";

import { rankByProvenance } from "./guarded-store";
import type { MemoryFact } from "@/types/memory";

function factOf(uuid: string, actorType: string): MemoryFact {
  // actorType is cast past ActorType's compile-time union on purpose: the
  // runtime data this function actually sees is unchecked (see
  // guarded-store.merge-tier-coverage.test.ts — a free-text DB column
  // laundered through an unchecked cast), so a real regression test has to
  // construct exactly the kind of fact the type system would otherwise forbid.
  return { uuid, fact: `fact-${uuid}`, validAt: null, actorType: actorType as MemoryFact["actorType"] };
}

/**
 * rankByProvenance sees the store's raw page on an unscoped `retrieve()`, so
 * a fact whose free-text `actorType` names an inherited Object property must
 * still get a numeric tier from `provenanceRank`. See
 * `guarded-store.retrieve-rank-guard.test.ts` for the same cases through the
 * real `retrieve()`. These call `rankByProvenance` directly with a scrambled,
 * not pre-grouped input, so a passing result cannot come from `mergeFacts`.
 */
describe("rankByProvenance — a fact whose actorType names an inherited Object property", () => {
  it("sorts a fact with an Object.prototype-inherited actorType last, not into an unspecified position", () => {
    // Looked up on a plain object, "toString" resolves to a function, the
    // comparator computes `function - 0` = NaN, and sort order under a NaN
    // comparator is unspecified — so this asserts the order, not just that
    // nothing throws.
    const weird = factOf("weird", "toString");
    const human = factOf("human-1", "human");
    const agent = factOf("agent-1", "agent");

    const result = rankByProvenance([weird, agent, human]);

    expect(result.map((f) => f.uuid)).toEqual(["human-1", "agent-1", "weird"]);
  });

  it("treats the malformed fact as UNRANKED (the extraction tier), same priority as a plain unrecognised actorType", () => {
    const weird = factOf("weird", "constructor");
    const extraction = factOf("extraction-1", "extraction");
    const human = factOf("human-1", "human");

    const result = rankByProvenance([extraction, human, weird]);

    // human still wins the top slot; weird and extraction are peers in the
    // lowest tier, so both orderings between them are "correct" here — the
    // real assertion is that weird never jumps ahead of a real tier.
    expect(result[0].uuid).toBe("human-1");
    expect(
      result
        .map((f) => f.uuid)
        .slice(1)
        .sort(),
    ).toEqual(["extraction-1", "weird"]);
  });

  it("ranks a lone malformed fact without throwing", () => {
    const weird = factOf("weird", "__proto__");

    expect(() => rankByProvenance([weird])).not.toThrow();
    expect(rankByProvenance([weird]).map((f) => f.uuid)).toEqual(["weird"]);
  });
});
