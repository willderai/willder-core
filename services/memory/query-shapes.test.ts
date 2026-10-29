// Answer shapes (services/memory/query-shapes.ts): which questions are aggregate or advice, only
// with RETRIEVAL_QUERY_SHAPES on; the compact dated snippets an aggregate page is served as,
// which only ever remove text; and the labelled block of the user's own stated preferences.
import { describe, expect, it } from "vitest";
import type { MemoryFact } from "@/types/memory";
import {
  PREFERENCE_BLOCK_LABEL,
  PREFERENCE_BLOCK_MAX_LINES,
  SERVED_FACT_OVERHEAD_CHARS,
  answerShapeOfQuery,
  compactAggregatePage,
  compactSnippet,
  preferenceBlock,
  preferenceQuery,
  queryShapesEnabled,
  servedCharsOf,
  statesPreference,
} from "./query-shapes";

const ON = { RETRIEVAL_QUERY_SHAPES: "1" };
const OFF = {};

const AGGREGATE = [
  "How many jigsaw puzzles have I finished or bought?",
  "What's the total I spent on gifts for my coworkers?",
  "How often do I go to the gym each week?",
  "How much money did I raise for charity altogether?",
  "List all the books I read last month.",
  "How many times did I visit the farmers market?",
];
const ADVICE = [
  "Can you recommend a podcast for my commute tomorrow?",
  "What should I cook for dinner on Friday?",
  "Any tips for keeping my tomato plants healthy?",
  "Can you suggest some activities for my next trip?",
  "Should I get a new laptop bag?",
];
const GENERAL = [
  "What's my dog called?",
  "When did I move to Austin?",
  "Where did I buy my bike?",
  "What did the assistant say about the Romer-G switches?",
];

describe("answerShapeOfQuery", () => {
  it("answers null for every question with the flag off, unset or not a yes", () => {
    for (const env of [
      OFF,
      { RETRIEVAL_QUERY_SHAPES: "0" },
      { RETRIEVAL_QUERY_SHAPES: "off" },
      { RETRIEVAL_QUERY_SHAPES: "" },
    ]) {
      for (const q of [...AGGREGATE, ...ADVICE, ...GENERAL]) expect(answerShapeOfQuery(q, env)).toBeNull();
    }
  });

  it("reads the flag as 1, true, on or yes", () => {
    for (const value of ["1", "true", "on", "yes", " YES "])
      expect(queryShapesEnabled({ RETRIEVAL_QUERY_SHAPES: value })).toBe(true);
    expect(queryShapesEnabled(OFF)).toBe(false);
  });

  it("tells aggregate, advice and other questions apart with the flag on", () => {
    for (const q of AGGREGATE) expect(answerShapeOfQuery(q, ON), q).toBe("aggregate");
    for (const q of ADVICE) expect(answerShapeOfQuery(q, ON), q).toBe("advice");
    for (const q of GENERAL) expect(answerShapeOfQuery(q, ON), q).toBeNull();
  });

  it("calls a question that is both aggregate", () => {
    expect(answerShapeOfQuery("How many plants should I buy for the balcony?", ON)).toBe("aggregate");
  });
});

const TURN = [
  "Session date: 2023/05/20 (Sat) 16:42",
  "",
  "user: I'm thinking about my weekend projects. I just finished building a Ravensburger lighthouse jigsaw puzzle last week. What glue works best for framing it?",
  "",
  "assistant: Great question! For clear parts, a PVA-based glue works well. It dries clear and will not fog the canopy. Many modelers also use Micro Kristal Klear. Let me know if you want more tips.",
].join("\n");

/** Every piece of a snippet, its date line, labels and gap marks aside, is text of the record it came from. */
function onlyRemoves(snippet: string, record: string): void {
  for (const line of snippet.split("\n")) {
    const body = line.replace(/^(?:user|assistant):\s*/, "");
    for (const piece of body.split(" … ")) {
      const text = piece.replace(/^…\s*/, "").replace(/\s*…$/, "").trim();
      if (text) expect(record, `"${text}" is not in the record`).toContain(text);
    }
  }
}

describe("compactSnippet", () => {
  it("keeps the date line and the sentences that answer, and drops the rest", () => {
    const snippet = compactSnippet(TURN, "How many jigsaw puzzles have I built?")!;
    expect(snippet.split("\n")[0]).toBe("Session date: 2023/05/20 (Sat) 16:42");
    expect(snippet).toContain("I just finished building a Ravensburger lighthouse jigsaw puzzle last week.");
    expect(snippet).not.toContain("PVA-based glue");
    expect(snippet).not.toContain("Let me know");
    expect(snippet.length).toBeLessThan(TURN.length / 2);
    onlyRemoves(snippet, TURN);
  });

  it("marks every gap, so a snippet never reads as the whole turn", () => {
    const snippet = compactSnippet(TURN, "How many jigsaw puzzles have I built?")!;
    expect(snippet).toMatch(/user: … I just finished/);
    expect(snippet).toMatch(/last week\. …/);
  });

  it("serves the opening of the user's turn when no sentence shares a term", () => {
    const snippet = compactSnippet(TURN, "How many aircraft have I assembled?")!;
    expect(snippet).toContain("user: I'm thinking about my weekend projects.");
    expect(snippet).not.toContain("assistant:");
    onlyRemoves(snippet, TURN);
  });

  it("stays within its size and never serves a sentence already served", () => {
    const long = `Session date: 2023/06/01 (Thu) 10:00\n\nuser: ${Array.from({ length: 40 }, (_, i) => `I bought jigsaw puzzle number ${i} today.`).join(" ")}`;
    const snippet = compactSnippet(long, "how many jigsaw puzzles did I buy", 300)!;
    expect(snippet.length).toBeLessThanOrEqual(300);
    onlyRemoves(snippet, long);
    const seen = new Set(["i just finished building a ravensburger lighthouse jigsaw puzzle last week"]);
    const again = compactSnippet(TURN, "How many jigsaw puzzles have I built?", 700, seen);
    expect(again ?? "").not.toContain("Ravensburger lighthouse");
  });

  it("serves a short record without labels as it stands", () => {
    expect(compactSnippet("The team ships on Fridays.", "how many releases ship on Fridays")).toBe(
      "The team ships on Fridays.",
    );
  });
});

function fact(uuid: string, text: string, extra: Partial<MemoryFact> = {}): MemoryFact {
  return { uuid, fact: text, validAt: null, actorType: "agent", store: "semantic", ...extra };
}

const session = (
  date: string,
  user: string,
  assistant = "That sounds wonderful. Here is a long answer about it. ".repeat(20),
) => `Session date: ${date}\n\nuser: ${user}\n\nassistant: ${assistant}`;

describe("compactAggregatePage", () => {
  const candidates = [
    fact("c", session("2023/07/02 (Sun) 09:00", "I bought a third jigsaw puzzle, a Buffalo Games harbour.")),
    fact("a", session("2023/05/20 (Sat) 16:42", "I just finished my first jigsaw puzzle, a Ravensburger lighthouse.")),
    fact("b", session("2023/06/11 (Sun) 12:30", "I picked up a second jigsaw puzzle, an Eurographics owl.")),
    fact("dup", session("2023/06/11 (Sun) 12:31", "I picked up a second jigsaw puzzle, an Eurographics owl.")),
  ];
  const query = "How many jigsaw puzzles have I bought?";

  it("serves more records than the page of whole facts in no more characters", () => {
    const whole = candidates.slice(0, 1);
    const budget = servedCharsOf(whole);
    const page = compactAggregatePage(candidates, query, budget);
    expect(page.length).toBeGreaterThan(whole.length);
    expect(servedCharsOf(page)).toBeLessThanOrEqual(budget);
  });

  it("orders the page by when each record happened, and serves a repeated sentence once", () => {
    const page = compactAggregatePage(candidates, query, 100_000);
    expect(page.map((f) => f.uuid)).toEqual(["a", "b", "c"]);
    for (const f of page) expect(f.excerptOfChars).toBe(candidates.find((c) => c.uuid === f.uuid)!.fact.length);
  });

  it("keeps the ranked order's choice when the budget is tight", () => {
    const page = compactAggregatePage(candidates, query, 2 * (SERVED_FACT_OVERHEAD_CHARS + 120));
    expect(page.map((f) => f.uuid).sort()).toEqual(["a", "c"]);
  });

  it("serves a candidate past the ordinary page only where the user's own words match", () => {
    const wide = [
      ...candidates.slice(0, 1),
      fact(
        "chatter",
        session(
          "2023/08/01 (Tue) 10:00",
          "Can you start with a fun fact?",
          "Here is a fun fact about jigsaw puzzles and the kits people build.",
        ),
      ),
      fact("match", session("2023/08/02 (Wed) 10:00", "I bought another jigsaw puzzle at the fair.")),
    ];
    expect(compactAggregatePage(wide, query, 100_000, 1).map((f) => f.uuid)).toEqual(["c", "match"]);
    expect(compactAggregatePage(wide, query, 100_000).map((f) => f.uuid)).toEqual(["c", "chatter", "match"]);
  });

  it("serves nothing in a budget too small for any snippet", () => {
    expect(compactAggregatePage(candidates, query, SERVED_FACT_OVERHEAD_CHARS)).toEqual([]);
  });
});

describe("preferenceBlock", () => {
  const facts = [
    fact(
      "p1",
      session(
        "2023/04/02 (Sun) 18:00",
        "I love trying new Thai recipes at home. My favorite is a green curry with tofu.",
        "I really like Thai food too! I'd suggest a pad see ew next.",
      ),
    ),
    fact(
      "p2",
      session("2023/04/09 (Sun) 18:00", "I've been training for a half marathon, so I usually eat light dinners."),
    ),
    fact(
      "p3",
      session("2023/04/10 (Mon) 08:00", "What time does the bakery open?", "I usually recommend arriving early."),
    ),
  ];

  it("labels the user's own stated preferences and habits, dated, the topic's first", () => {
    const block = preferenceBlock(facts, "What should I cook for dinner on Friday?")!;
    const lines = block.text.split("\n");
    expect(lines[0]).toBe(PREFERENCE_BLOCK_LABEL);
    expect(lines[1]).toBe("- (2023-04-09) I've been training for a half marathon, so I usually eat light dinners.");
    expect(block.text).toContain("- (2023-04-02) I love trying new Thai recipes at home.");
    expect(block.text).toContain("My favorite is a green curry with tofu.");
    expect(block.facts.map((f) => f.uuid)).toEqual(["p2", "p1"]);
  });

  it("never takes the assistant's words for the user's", () => {
    const block = preferenceBlock(facts, "Can you recommend a recipe?")!;
    expect(block.text).not.toContain("I really like Thai food too");
    expect(block.text).not.toContain("I usually recommend arriving early");
  });

  it("is null when no record states a preference, and takes unlabelled text only from a person", () => {
    expect(preferenceBlock([facts[2]!], "any tips for the bakery?")).toBeNull();
    const note = "I prefer morning meetings and I usually block Fridays for deep work.";
    expect(preferenceBlock([fact("n1", note)], "should I schedule the review on Friday?")).toBeNull();
    expect(
      preferenceBlock([fact("n2", note, { actorType: "human" })], "should I schedule the review on Friday?")?.text,
    ).toContain("I usually block Fridays");
  });

  it("holds at most its line count, each sentence once", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      fact(
        `m${i}`,
        session("2023/01/01 (Sun) 10:00", `I really like hobby number ${i}. I really like hobby number 0.`),
      ),
    );
    const block = preferenceBlock(many, "recommend a hobby")!;
    expect(block.text.split("\n").length - 1).toBe(PREFERENCE_BLOCK_MAX_LINES);
    expect(block.text.match(/hobby number 0\./g)).toHaveLength(1);
  });

  it("asks the preference read for the topic and the words preferences are stated in", () => {
    const q = preferenceQuery("What should I cook for dinner on Friday?");
    expect(q).toMatch(/^cook dinner friday /);
    expect(q).toContain("I prefer");
    expect(statesPreference("I'm really into bouldering lately")).toBe(true);
    expect(statesPreference("I’ve been learning to bake sourdough")).toBe(true);
    expect(statesPreference("The bakery opens at seven")).toBe(false);
  });
});
