// The aggregate digest (services/memory/aggregate-digest.ts): only with RETRIEVAL_AGGREGATE_DIGEST
// on and only for an aggregate question; its sentences picked for counting (statements and
// quantities first, a restatement within a day once);
// and its layout, one heading per day, oldest first, every fact on its own line.
import { describe, expect, it } from "vitest";
import type { MemoryFact } from "@/types/memory";
import {
  DIGEST_SNIPPET_POLICY,
  aggregateDigestEnabled,
  aggregateDigestOfQuery,
  dayHeading,
  dayOf,
  digestDays,
  digestHeader,
  digestText,
  weekdayOf,
} from "./aggregate-digest";
import {
  compactAggregatePage,
  inflectionStem,
  informativeTopic,
  restates,
  statementWeight,
  stem,
} from "./query-shapes";

const ON = { RETRIEVAL_AGGREGATE_DIGEST: "1" };

function fact(uuid: string, text: string, extra: Partial<MemoryFact> = {}): MemoryFact {
  return { uuid, fact: text, validAt: null, actorType: "agent", store: "semantic", ...extra };
}

const turn = (
  date: string,
  user: string,
  assistant = "What a lovely thing to do. Here is a long reply with some ideas for next time. ".repeat(8),
) => `Session date: ${date}\n\nuser: ${user}\n\nassistant: ${assistant}`;

describe("aggregateDigestOfQuery", () => {
  it("is false with the flag off, whatever the question", () => {
    expect(aggregateDigestEnabled({})).toBe(false);
    expect(aggregateDigestEnabled({ RETRIEVAL_AGGREGATE_DIGEST: "0" })).toBe(false);
    expect(aggregateDigestOfQuery("How many birdhouses have I built?", {})).toBe(false);
  });

  it("is true with the flag on, only for an aggregate question", () => {
    for (const value of ["1", "true", "on", "YES"])
      expect(aggregateDigestEnabled({ RETRIEVAL_AGGREGATE_DIGEST: value })).toBe(true);
    expect(aggregateDigestOfQuery("How many birdhouses have I built?", ON)).toBe(true);
    expect(aggregateDigestOfQuery("What is the total I paid for the kayak rentals?", ON)).toBe(true);
    expect(aggregateDigestOfQuery("Where did I put the spare kayak paddle?", ON)).toBe(false);
    expect(aggregateDigestOfQuery("Can you recommend a birdhouse design?", ON)).toBe(false);
  });
});

describe("the digest's sentences", () => {
  it("weighs a first-person statement and a quantity up, and a bare question down", () => {
    expect(statementWeight("I built two cedar birdhouses for the garden.")).toBe(2);
    expect(statementWeight("My neighbour helped with the roof.")).toBe(1);
    expect(statementWeight("Cedar weathers well outdoors.")).toBe(0);
    expect(statementWeight("Can you suggest a birdhouse design for wrens?")).toBe(-1);
    expect(statementWeight("Do you think 3 is a lot for one garden?")).toBe(0);
  });

  it("calls a sentence a restatement when most of its content words were served already", () => {
    const served = [new Set(["built", "cedar", "birdhouse", "garden"])];
    expect(restates(new Set(["built", "cedar", "birdhouse"]), served)).toBe(true);
    expect(restates(new Set(["painted", "pine", "feeder", "garden"]), served)).toBe(false);
    expect(restates(new Set(), served)).toBe(false);
  });

  it("calls a sentence that holds most of a served one a restatement, whichever came first", () => {
    const plain = new Set(["built", "cedar", "birdhouse", "wren", "morning"]);
    const likeISaid = new Set(["like", "said", "built", "cedar", "birdhouse", "wren", "morning"]);
    expect(restates(likeISaid, [plain])).toBe(true);
    expect(restates(plain, [likeISaid])).toBe(true);
    // A served sentence of fewer than three content words is not held by every longer one that shares them.
    expect(restates(new Set(["built", "cedar", "feeder", "garden", "niece"]), [new Set(["built", "cedar"])])).toBe(
      false,
    );
  });

  it("never calls sentences that state different numbers restatements", () => {
    const five = new Set(["bought", "lilac", "bush", "number", "5", "nursery"]);
    expect(restates(new Set(["bought", "lilac", "bush", "number", "6", "nursery"]), [five])).toBe(false);
    expect(restates(new Set(["bought", "lilac", "bush", "number", "nursery"]), [five])).toBe(false);
    expect(
      restates(new Set(["bought", "two", "lilac", "bush", "nursery"]), [
        new Set(["bought", "three", "lilac", "bush", "nursery"]),
      ]),
    ).toBe(false);
    expect(restates(new Set(["like", "said", "bought", "lilac", "bush", "number", "5", "nursery"]), [five])).toBe(true);
  });

  it("matches a word and its inflections on one stem", () => {
    for (const [a, b] of [
      ["replace", "replaced"],
      ["replace", "replacing"],
      ["repair", "repairing"],
      ["fix", "fixed"],
      ["birdhouse", "birdhouses"],
      ["box", "boxes"],
      ["hobby", "hobbies"],
      ["date", "dated"],
      ["bike", "biked"],
      ["hope", "hoped"],
      ["change", "changed"],
      ["note", "notes"],
      ["plan", "planned"],
    ]) {
      expect(inflectionStem(a), `${a} ~ ${b}`).toBe(inflectionStem(b!));
    }
  });

  it("keeps apart words that differ by a final e, and leaves short words whole", () => {
    for (const [a, b] of [
      ["plane", "plan"],
      ["note", "not"],
      ["here", "her"],
      ["hope", "hop"],
      ["site", "sit"],
      ["cute", "cut"],
      ["rate", "rat"],
      ["paste", "past"],
      ["hoped", "hopped"],
    ]) {
      expect(inflectionStem(a), `${a} ≁ ${b}`).not.toBe(inflectionStem(b!));
    }
    expect(inflectionStem("speed")).toBe("speed");
    expect(inflectionStem("breed")).toBe("breed");
  });

  it("leaves the RETRIEVAL_QUERY_SHAPES stem as it was", () => {
    for (const [word, stemmed] of [
      ["puzzles", "puzzle"],
      ["replaced", "replac"],
      ["replace", "replace"],
      ["fixed", "fixed"],
      ["plane", "plane"],
      ["note", "note"],
      ["speed", "speed"],
      ["hobbies", "hobby"],
      ["boxes", "box"],
    ]) {
      expect(stem(word!), word).toBe(stemmed);
    }
  });

  it("matches on the topic terms most candidates do not hold, or on all of them when none or all are rare", () => {
    const woodworking = Array.from({ length: 12 }, (_, i) =>
      fact(
        `w${i}`,
        `Session date: 2024/03/0${(i % 9) + 1} (Fri) 10:00\n\nuser: More woodworking today, sanding board ${i}.`,
      ),
    );
    const withFeeder = [...woodworking, fact("f", "user: My woodworking project this week was a bird feeder.")];
    expect(informativeTopic(withFeeder, "How many bird feeders have I made in woodworking class?")).toEqual([
      "bird",
      "feeders",
      "made",
      "class",
    ]);
    expect(informativeTopic(withFeeder, "How much woodworking did I do?")).toEqual(["woodworking"]);
    expect(
      informativeTopic(withFeeder.slice(0, 5), "How many bird feeders have I made in woodworking class?"),
    ).toContain("woodworking");
  });

  const query = "How many birdhouses have I built?";
  const candidates = [
    fact(
      "may-1",
      turn(
        "2024/05/04 (Sat) 10:00",
        "I built my first birdhouse this morning, a cedar one for the wrens. Can you suggest a birdhouse paint that is safe for birds?",
      ),
    ),
    fact(
      "may-2",
      turn(
        "2024/05/04 (Sat) 10:20",
        "As I said, I built my first birdhouse this morning, the cedar one for the wrens.",
      ),
    ),
    fact(
      "june",
      turn("2024/06/15 (Sat) 09:00", "I built my first birdhouse kit with my niece today, a small pine one."),
    ),
    fact(
      "chatter",
      turn(
        "2024/06/20 (Thu) 18:00",
        "What's the weather like for the weekend?",
        "Sunny, a good weekend for building a birdhouse outside.",
      ),
    ),
  ];

  it("serves statements before bare questions, and a restatement within a day once", () => {
    const page = compactAggregatePage(candidates, query, 100_000, candidates.length, DIGEST_SNIPPET_POLICY);
    expect(page.map((f) => f.uuid)).toEqual(["may-1", "june", "chatter"]);
    const text = page.map((f) => f.fact).join("\n");
    expect(text).toContain("I built my first birdhouse this morning, a cedar one for the wrens.");
    expect(text).not.toContain("Can you suggest a birdhouse paint");
    // The same words on another day are another event, and are served.
    expect(text).toContain("I built my first birdhouse kit with my niece today, a small pine one.");
  });

  it("serves two events of one day that differ only in their number", () => {
    const roses = [
      fact("lilac-5", turn("2024/04/06 (Sat) 09:00", "I planted lilac bush number 5 along the fence.")),
      fact("lilac-6", turn("2024/04/06 (Sat) 11:00", "I planted lilac bush number 6 along the fence.")),
      fact(
        "lilac-6-again",
        turn("2024/04/06 (Sat) 11:30", "Like I said, I planted lilac bush number 6 along the fence."),
      ),
    ];
    const page = compactAggregatePage(
      roses,
      "How many lilac bushes have I planted?",
      100_000,
      roses.length,
      DIGEST_SNIPPET_POLICY,
    );
    expect(page.map((f) => f.uuid)).toEqual(["lilac-5", "lilac-6"]);
  });

  it("serves a restatement once, whichever of the two ranks first", () => {
    const plain = fact(
      "plain",
      turn("2024/05/04 (Sat) 10:00", "I built a cedar birdhouse for the wrens this morning."),
    );
    const repeat = fact(
      "repeat",
      turn("2024/05/04 (Sat) 10:20", "Like I said, I built a cedar birdhouse for the wrens this morning."),
    );
    for (const order of [
      [plain, repeat],
      [repeat, plain],
    ]) {
      const page = compactAggregatePage(order, query, 100_000, order.length, DIGEST_SNIPPET_POLICY);
      expect(page.map((f) => f.uuid)).toEqual([order[0]!.uuid]);
    }
  });

  it("serves the user's first-person statement of a quantity beside a matching sentence, though it shares no topic term", () => {
    const record = fact(
      "q",
      turn(
        "2024/07/06 (Sat) 10:00",
        "I built another birdhouse for the porch. It took me 3 hours to sand it. The paint is a soft green.",
      ),
    );
    const page = compactAggregatePage([record], query, 100_000, 1, DIGEST_SNIPPET_POLICY);
    expect(page[0]!.fact).toContain("It took me 3 hours to sand it.");
    expect(page[0]!.fact).not.toContain("soft green");
    expect(compactAggregatePage([record], query, 100_000, 1)[0]!.fact).not.toContain("3 hours");
  });

  it("serves the same page as before without the policy", () => {
    const page = compactAggregatePage(candidates, query, 100_000, candidates.length);
    expect(page.map((f) => f.uuid)).toEqual(["may-1", "may-2", "june", "chatter"]);
  });
});

describe("the digest's layout", () => {
  const facts = [
    fact("b", turn("2024/06/15 (Sat) 09:00", "I built a pine birdhouse.")),
    fact("u", "A note with no date about birdhouses."),
    fact("a1", turn("2024/05/04 (Sat) 10:00", "I built a cedar birdhouse.")),
    fact("a2", "Stored without a date line.", { validAt: "2024-05-04T16:30:00.000Z" }),
  ];

  it("groups facts by day, oldest first and undated last, keeping the served order within a day", () => {
    const days = digestDays(facts);
    expect(days.map((d) => d.day)).toEqual(["2024-05-04", "2024-06-15", null]);
    expect(days[0]!.facts.map((f) => f.uuid)).toEqual(["a1", "a2"]);
    expect(dayOf(facts[3]!)).toBe("2024-05-04");
  });

  it("names each day's weekday and record count, and the span in its header", () => {
    expect(weekdayOf("2024-05-04")).toBe("Sat");
    expect(weekdayOf("not a day")).toBeNull();
    const days = digestDays(facts);
    expect(dayHeading(days[0]!)).toBe("2024-05-04 (Sat), 2 records:");
    expect(dayHeading(days[2]!)).toBe("Undated, 1 record:");
    expect(digestHeader(days)).toBe(
      "4 records matching this question on 2 days from 2024-05-04 to 2024-06-15, grouped by day, oldest first. A statement repeated within a day is served once.",
    );
    expect(digestHeader(digestDays([facts[0]!]))).toContain("1 record matching this question on 2024-06-15,");
  });

  it("prints every fact's own line exactly once, under its day", () => {
    const text = digestText(digestDays(facts), (f) => `• line ${f.uuid}`);
    const lines = text.split("\n");
    for (const f of facts) expect(lines.filter((l) => l === `• line ${f.uuid}`)).toHaveLength(1);
    expect(lines.indexOf("2024-05-04 (Sat), 2 records:")).toBeLessThan(lines.indexOf("• line a1"));
    expect(lines.indexOf("• line a2")).toBeLessThan(lines.indexOf("2024-06-15 (Sat), 1 record:"));
    expect(lines.indexOf("Undated, 1 record:")).toBeLessThan(lines.indexOf("• line u"));
  });
});
