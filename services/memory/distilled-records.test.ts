// Unit tests for the distiller's output checks: a decision survives only as a
// verbatim span of the source, and an entity seed only with a closed-list type
// and a name the source contains.
import { describe, expect, it } from "vitest";
import { decisionToSentence, entitySeedToSentence, parseDecisions, parseEntitySeeds } from "./distilled-records";

const SOURCE = "Jordan decided on 2026-09-24 that every crew run reads Willder memory after its control check.";

describe("parseDecisions", () => {
  it("keeps a decision that is a verbatim span, in the source's own spelling", () => {
    const [record] = parseDecisions(
      [
        {
          decision: "EVERY crew run reads  Willder memory\nafter its control check.",
          actor: "jordan",
          date: "2026-09-24",
        },
      ],
      SOURCE,
    );

    expect(record).toEqual({
      decision: "every crew run reads Willder memory after its control check",
      actor: "Jordan",
      date: "2026-09-24",
    });
  });

  it("drops a decision the source does not contain word for word", () => {
    expect(parseDecisions([{ decision: "crew runs consult memory after the control check" }], SOURCE)).toEqual([]);
  });

  it("drops a decision too short to act on", () => {
    expect(parseDecisions([{ decision: "every crew" }], SOURCE)).toEqual([]);
  });

  it("drops an actor or date the source does not contain, and keeps the decision", () => {
    const [record] = parseDecisions(
      [{ decision: "every crew run reads Willder memory", actor: "Morgan", date: "2026-09-25" }],
      SOURCE,
    );

    expect(record).toEqual({ decision: "every crew run reads Willder memory" });
  });

  it("drops a date that is not YYYY-MM-DD even when the source contains it", () => {
    const [record] = parseDecisions([{ decision: "every crew run reads Willder memory", date: "2026-09" }], SOURCE);

    expect(record!.date).toBeUndefined();
  });

  it("ignores anything that is not a decision object", () => {
    expect(parseDecisions("every crew run", SOURCE)).toEqual([]);
    expect(parseDecisions([null, 3, { actor: "Jordan" }], SOURCE)).toEqual([]);
  });

  it("cuts the span from the source correctly after a character that lengthens when lowercased", () => {
    // "İ" (U+0130) lowercases to two characters; the span must still start at "every".
    const [record] = parseDecisions([{ decision: "every crew run reads memory" }], "İ: every crew run reads memory");

    expect(record!.decision).toBe("every crew run reads memory");
  });
});

describe("decisionToSentence", () => {
  it("leads with the type, then who and when", () => {
    expect(decisionToSentence({ decision: "ship on Monday", actor: "Jordan", date: "2026-09-24" })).toBe(
      "Decision by Jordan on 2026-09-24: ship on Monday.",
    );
  });

  it("omits what the source did not state", () => {
    expect(decisionToSentence({ decision: "ship on Monday" })).toBe("Decision: ship on Monday.");
  });
});

describe("entitySeedToSentence", () => {
  // The description is the model's own clause, as often a noun phrase as a verb phrase, so
  // no "<name> is a <type> that <description>" template reads for both: it served "ED is a
  // Signal that the emergency department that referred Elena Park." The type is the model's
  // guess from a closed list no graph node type uses, and it once typed a clinic's agent a
  // Relationship, so the line does not state it as a fact.
  it("defines the entity by its description, whatever form the description takes", () => {
    expect(
      entitySeedToSentence({
        name: "ED",
        type: "Signal",
        description: "the emergency department that referred Elena Park",
      }),
    ).toBe("ED: the emergency department that referred Elena Park.");
    expect(
      entitySeedToSentence({ name: "Willder memory", type: "Project", description: "stores crew decisions" }),
    ).toBe("Willder memory: stores crew decisions.");
  });

  it("never states the seed's type", () => {
    const sentence = entitySeedToSentence({
      name: "MemCare",
      type: "Relationship",
      description: "agent managing the follow-up schedule",
    });

    expect(sentence).toBe("MemCare: agent managing the follow-up schedule.");
    expect(sentence).not.toMatch(/Relationship/i);
  });
});

describe("parseEntitySeeds", () => {
  it("keeps a seed with a listed type and a name the source contains", () => {
    const seeds = parseEntitySeeds(
      [{ name: "willder memory", type: "Project", description: "stores crew decisions." }],
      SOURCE,
    );

    expect(seeds).toEqual([{ name: "Willder memory", type: "Project", description: "stores crew decisions" }]);
  });

  it("never seeds a Decision: decisions are stored as decision records", () => {
    expect(parseEntitySeeds([{ name: "Jordan", type: "Decision", description: "sets procedures" }], SOURCE)).toEqual(
      [],
    );
  });

  it("drops a seed whose name the source does not mention", () => {
    expect(parseEntitySeeds([{ name: "Acme", type: "Deal", description: "a renewal" }], SOURCE)).toEqual([]);
  });

  it("never seeds a decision's actor under any type", () => {
    const decisions = parseDecisions([{ decision: "every crew run reads Willder memory", actor: "Jordan" }], SOURCE);

    expect(
      parseEntitySeeds(
        [{ name: "Jordan", type: "Relationship", description: "the decision-maker" }],
        SOURCE,
        decisions,
      ),
    ).toEqual([]);
  });

  it("ignores the old free-text seed shape", () => {
    expect(parseEntitySeeds(["Jordan is a Decision that specifies operational procedures."], SOURCE)).toEqual([]);
  });
});
