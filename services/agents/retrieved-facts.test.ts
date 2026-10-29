// The seam is RetrievedFacts' contract with the structuring step: the labels it shows
// the model, and the citations it accepts back. Only facts this run retrieved can be cited.
import { describe, expect, it } from "vitest";
import { MAX_LABELLED_FACTS, RetrievedFacts } from "./retrieved-facts";

function retrieved(...facts: [string, string][]): RetrievedFacts {
  const collected = new RetrievedFacts();
  collected.add(facts.map(([uuid, fact]) => ({ uuid, fact })));
  return collected;
}

describe("RetrievedFacts", () => {
  it("labels facts F1, F2, ... in the order they were first retrieved, one line each", () => {
    const facts = retrieved(["u1", "Deploys go out on Tuesdays"], ["u2", "The API is\n  versioned "]);

    expect(facts.promptBlock()).toBe("[F1] Deploys go out on Tuesdays\n[F2] The API is versioned");
  });

  it("keeps one entry per uuid, so a fact retrieved twice keeps its first label", () => {
    const facts = retrieved(["u1", "a"], ["u2", "b"]);
    facts.add([
      { uuid: "u1", fact: "a" },
      { uuid: "u3", fact: "c" },
    ]);

    expect(facts.promptBlock()).toBe("[F1] a\n[F2] b\n[F3] c");
  });

  it("maps cited labels back to the facts they name, per section", () => {
    const facts = retrieved(["u1", "a"], ["u2", "b"]);

    expect(facts.citationsFor([{ citations: ["F2"] }, {}, { citations: ["F1", "F2"] }])).toEqual([
      { sectionIndex: 0, factId: "u2", factText: "b" },
      { sectionIndex: 2, factId: "u1", factText: "a" },
      { sectionIndex: 2, factId: "u2", factText: "b" },
    ]);
  });

  it("accepts a label written as [F1] or f1", () => {
    const facts = retrieved(["u1", "a"]);

    expect(facts.citationsFor([{ citations: ["[F1]", " f1 "] }]).map((c) => c.factId)).toEqual(["u1", "u1"]);
  });

  it("drops a label that names no retrieved fact, including a raw uuid", () => {
    const facts = retrieved(["u1", "a"]);

    expect(facts.citationsFor([{ citations: ["F2", "F0", "u1", "anything"] }])).toEqual([]);
  });

  it("lists at most MAX_LABELLED_FACTS facts", () => {
    const facts = new RetrievedFacts();
    facts.add(Array.from({ length: MAX_LABELLED_FACTS + 5 }, (_, i) => ({ uuid: `u${i}`, fact: `f${i}` })));

    expect(facts.promptBlock().split("\n")).toHaveLength(MAX_LABELLED_FACTS);
    expect(facts.citationsFor([{ citations: [`F${MAX_LABELLED_FACTS + 1}`] }])).toEqual([]);
  });
});
