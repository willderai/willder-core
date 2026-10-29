// A read's first line is served below the later records of the same page that state a new value of
// its thing, and is marked; nothing else moves, and nothing is added or dropped. These tests
// drive serveLaterUpdatesFirst on pages shaped like the ones memory_query serves.
import { describe, expect, it } from "vitest";
import { serveLaterUpdatesFirst } from "./update-links";
import type { ActorType, MemoryFact } from "@/types/memory";

const TIERS: Record<string, number> = { human: 0, agent: 1, extraction: 2 };
const rank = (f: MemoryFact) => (f.actorType ? TIERS[f.actorType] : 3);

interface Shape {
  at?: string | null;
  actorType?: ActorType;
  scopePath?: string;
  store?: MemoryFact["store"];
}

/** A stored record dated `at`, in scope `org_1.home` by default. */
function record(
  uuid: string,
  fact: string,
  { at = "2026-03-01T10:00:00.000Z", actorType = "agent", scopePath = "org_1.home", store = "semantic" }: Shape = {},
): MemoryFact {
  return { uuid, fact, validAt: at, actorType, store, ...(scopePath ? { scopePath } : {}) };
}

const EARLY = "2026-03-01T10:00:00.000Z";
const LATER = "2026-03-08T10:00:00.000Z";
const LATEST = "2026-03-15T10:00:00.000Z";

const QUERY = "What is the monthly grocery budget Alexis and I have agreed on?";
const AGREED = "USER: I've agreed with Alexis on a $500 monthly joint budget for groceries starting Sept 1.";
const RAISED = "USER: I saw that my grocery budget was increased to $550 monthly starting September 15.";
const OTHER = "USER: I'm planning meals for the week and want to use more beans.";

const ids = (page: MemoryFact[]) => page.map((f) => f.uuid);
const marks = (page: MemoryFact[]) => page.map((f) => f.laterRecordsAbove ?? 0);

describe("serveLaterUpdatesFirst", () => {
  it("serves a later record that changed the first line's value above it, and marks the first line", () => {
    const page = [
      record("old", AGREED, { at: EARLY }),
      record("other", OTHER, { at: LATER }),
      record("new", RAISED, { at: LATER }),
    ];

    const served = serveLaterUpdatesFirst(page, QUERY, rank);

    expect(ids(served)).toEqual(["new", "old", "other"]);
    expect(marks(served)).toEqual([0, 1, 0]);
  });

  it("serves every later record that updates it, newest first", () => {
    const again = "USER: The monthly grocery budget was adjusted again, to $600.";
    const page = [
      record("old", AGREED, { at: EARLY }),
      record("latest", again, { at: LATEST }),
      record("other", OTHER, { at: LATER }),
      record("new", RAISED, { at: LATER }),
    ];

    const served = serveLaterUpdatesFirst(page, QUERY, rank);

    expect(ids(served)).toEqual(["latest", "new", "old", "other"]);
    expect(served[2].laterRecordsAbove).toBe(2);

    const rankedOlderFirst = [
      record("old", AGREED, { at: EARLY }),
      record("new", RAISED, { at: LATER }),
      record("latest", again, { at: LATEST }),
    ];
    expect(ids(serveLaterUpdatesFirst(rankedOlderFirst, QUERY, rank))).toEqual(["latest", "new", "old"]);
  });

  it("keeps a later version of an updater's own fact above the line it updates", () => {
    const subject = JSON.stringify(["org_1.home", "grocery-budget"]);
    const page = [
      record("old", "USER: My grocery budget is $500 a month.", { at: EARLY }),
      { ...record("t1", "USER: My grocery budget was increased to $520.", { at: LATER }), subject },
      record("other", OTHER, { at: LATER }),
      { ...record("t2", "USER: My grocery budget is $560 per month.", { at: LATEST }), subject },
    ];

    const served = serveLaterUpdatesFirst(page, "What is my grocery budget?", rank);

    expect(ids(served)).toEqual(["t2", "t1", "old", "other"]);
    expect(served[2].laterRecordsAbove).toBe(2);
  });

  it("links nothing when the change is denied, asked about, offered, or said of something else", () => {
    const q = "What is my grocery budget?";
    const lead = "USER: My grocery budget is $500 a month.";
    for (const later of [
      "USER: I've now spent $320 of my grocery budget this month.",
      "USER: I'm now close to $450 of my grocery budget.",
      "USER: We increased our savings, and the grocery budget is still close to $450.",
      "USER: The new grocery budget app costs $5 a month.",
      "USER: My grocery budget hasn't moved, but rent was increased to $1,900.",
      "USER: My grocery budget was not increased to $550 after all; it stays.",
      "USER: My grocery budget hasn't been increased to $550 yet.",
      "USER: Should my grocery budget be increased to $550?",
      "ASSISTANT: Would you like your grocery budget increased to $550?",
    ]) {
      const page = [record("old", lead, { at: EARLY }), record("new", later, { at: LATER })];
      expect(ids(serveLaterUpdatesFirst(page, q, rank)), later).toEqual(["old", "new"]);
    }
  });

  it("links nothing between a record dated by when it happened and one dated by when it was stored", () => {
    const lead = {
      ...record("old", "USER: My grocery budget was set to $650 in September.", { at: "2026-09-01T00:00:00.000Z" }),
      validAtSource: "occurred" as const,
    };
    const imported = {
      ...record("new", "USER: My grocery budget was increased to $550.", { at: "2026-10-15T00:00:00.000Z" }),
      validAtSource: "stored" as const,
    };

    expect(ids(serveLaterUpdatesFirst([lead, imported], "What is my grocery budget?", rank))).toEqual(["old", "new"]);
    const stated = { ...imported, validAtSource: "occurred" as const };
    expect(ids(serveLaterUpdatesFirst([lead, stated], "What is my grocery budget?", rank))).toEqual(["new", "old"]);
  });

  it("reads one sum however it is written", () => {
    const q = "What is my grocery budget?";
    const lead = "USER: My grocery budget is $5,000 a year.";
    for (const same of [
      "USER: My grocery budget was updated to $5,000.00 a year.",
      "USER: My grocery budget was updated to $5k a year.",
    ]) {
      const page = [record("old", lead, { at: EARLY }), record("new", same, { at: LATER })];
      expect(ids(serveLaterUpdatesFirst(page, q, rank)), same).toEqual(["old", "new"]);
    }
    const page = [
      record("old", lead, { at: EARLY }),
      record("new", "USER: My grocery budget was updated to $5.5k a year.", { at: LATER }),
    ];
    expect(ids(serveLaterUpdatesFirst(page, q, rank))).toEqual(["new", "old"]);
  });

  it("keeps an abbreviated month, a p.m. and a dotted capital in one sentence and one term", () => {
    const q = "When is the dentist appointment?";
    const lead = "USER: The dentist appointment is on Mar 20.";
    const moved = "USER: The dentist appointment was rescheduled to Mar. 22.";
    expect(
      ids(serveLaterUpdatesFirst([record("old", lead, { at: EARLY }), record("new", moved, { at: LATER })], q, rank)),
    ).toEqual(["new", "old"]);

    const sync = [
      record("old", "USER: The weekly team sync is at 3 p.m. on Mondays.", { at: EARLY }),
      record("new", "USER: The weekly team sync was moved to 4 p.m. the week after.", { at: LATER }),
    ];
    expect(ids(serveLaterUpdatesFirst(sync, "What time is the weekly team sync?", rank))).toEqual(["new", "old"]);

    const income = [
      record("old", "USER: My income budget is $500.", { at: EARLY }),
      record("new", "USER: My income budget was increased to $600.", { at: LATER }),
    ];
    expect(ids(serveLaterUpdatesFirst(income, "What is my İNCOME budget?", rank))).toEqual(["new", "old"]);
  });

  it("reads a page as long as the largest answer in linear time", () => {
    const rows = Array.from({ length: 4_000 }, (_, i) => `{"id":${i},"amount":${i * 7}}`).join(",");
    const json = `{"grocery_budget":500,"rows":[${rows}]}`;
    const numbers = `USER: My grocery budget now ${Array.from({ length: 10_000 }, (_, i) => i).join(" ")}`;
    const dollars = `USER: My grocery budget ${"$5 ".repeat(20_000)}`;
    const page = [
      record("old", json, { at: EARLY }),
      record("a", numbers, { at: LATER }),
      record("b", dollars, { at: LATER }),
    ];
    const asLead = [
      record("b", dollars, { at: EARLY }),
      record("a", numbers, { at: LATER }),
      record("old", json, { at: LATER }),
    ];
    // Sentences just under the length a statement may have, each full of values.
    const denseOf = (from: number) => {
      const sentence =
        `My grocery budget was increased to ${Array.from({ length: 380 }, (_, i) => `$${from + i}`).join(" ")}`.slice(
          0,
          1_990,
        );
      return `USER: ${Array.from({ length: 30 }, () => `${sentence}.`).join("\n")}`;
    };
    const dense = denseOf(0);
    const densePage = [record("old", dense, { at: EARLY }), record("a", denseOf(5_000), { at: LATER })];

    const started = performance.now();
    serveLaterUpdatesFirst(page, "What is my grocery budget?", rank);
    serveLaterUpdatesFirst(asLead, "What is my grocery budget?", rank);
    expect(dense.length).toBeGreaterThan(50_000);
    expect(ids(serveLaterUpdatesFirst(densePage, "What is my grocery budget?", rank))).toEqual(["a", "old"]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps the page as ranked when the later record states the value with no word of change", () => {
    const restated = "USER: How do I make the most of a $550 monthly grocery budget?";
    const page = [record("old", AGREED, { at: EARLY }), record("new", restated, { at: LATER })];

    expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["old", "new"]);
  });

  it("links nothing to a record that is dated earlier, or at the same moment", () => {
    for (const at of ["2026-02-20T10:00:00.000Z", EARLY]) {
      const page = [record("old", AGREED, { at: EARLY }), record("new", RAISED, { at })];
      const served = serveLaterUpdatesFirst(page, QUERY, rank);
      expect(ids(served)).toEqual(["old", "new"]);
      expect(marks(served)).toEqual([0, 0]);
    }
  });

  it("links nothing when the later record states the value the first line already holds", () => {
    const same = "USER: Our grocery budget was increased to $500 monthly, as agreed.";
    const page = [record("old", AGREED, { at: EARLY }), record("new", same, { at: LATER })];

    expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["old", "new"]);
  });

  it("reads the value after 'from' as the one replaced, not the new one", () => {
    const lead = "USER: My monthly grocery budget with Alexis is $500.";
    const fromTo = "USER: The monthly grocery budget increased from $400 to $500 last week.";
    const page = [record("old", lead, { at: EARLY }), record("new", fromTo, { at: LATER })];

    expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["old", "new"]);
  });

  it("links only records about the same thing: two query terms in common, and the same kind of value", () => {
    const otherThing = "USER: The rent was increased to $1,550 monthly for the flat.";
    const otherKind = "USER: The grocery budget call with Alexis moved to 3 PM.";
    for (const later of [otherThing, otherKind]) {
      const page = [record("old", AGREED, { at: EARLY }), record("new", later, { at: LATER })];
      expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["old", "new"]);
    }
    // Two query terms each, but none in common: the groceries Alexis agreed, and a monthly budget.
    const agreedGroceries = "USER: Alexis and I agreed on $500 for groceries.";
    const monthlyBudget = "USER: The monthly budget was increased to $550.";
    const page = [record("old", agreedGroceries, { at: EARLY }), record("new", monthlyBudget, { at: LATER })];
    expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["old", "new"]);
  });

  it("reads only the first line's sentences about the queried thing as what it states", () => {
    // "Bills are $550 monthly" names one query term: the first line does not state $550 about the budget.
    const lead = `${AGREED} Bills are $550 monthly.`;
    const raised = "USER: My grocery budget was increased to $550 monthly.";
    const page = [record("old", lead, { at: EARLY }), record("new", raised, { at: LATER })];

    expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["new", "old"]);
  });

  it("links nothing across scopes or provenance tiers, or to a graph fact", () => {
    const cases: Shape[] = [
      { at: LATER, scopePath: "org_1.office" },
      { at: LATER, scopePath: "" },
      { at: LATER, actorType: "human" },
      { at: LATER, store: "graph" },
    ];
    for (const shape of cases) {
      const page = [record("old", AGREED, { at: EARLY }), record("new", RAISED, shape)];
      expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["old", "new"]);
    }
    const graphLead = [record("old", AGREED, { at: EARLY, store: "graph" }), record("new", RAISED, { at: LATER })];
    expect(ids(serveLaterUpdatesFirst(graphLead, QUERY, rank))).toEqual(["old", "new"]);
    const undated = [record("old", AGREED, { at: null }), record("new", RAISED, { at: LATER })];
    expect(ids(serveLaterUpdatesFirst(undated, QUERY, rank))).toEqual(["old", "new"]);
  });

  it("links two untagged records, which share the org root", () => {
    const page = [
      record("old", AGREED, { at: EARLY, scopePath: "" }),
      record("new", RAISED, { at: LATER, scopePath: "" }),
    ];

    expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["new", "old"]);
  });

  it("links nothing for a question that does not ask for a value", () => {
    const page = [record("old", AGREED, { at: EARLY }), record("new", RAISED, { at: LATER })];

    expect(ids(serveLaterUpdatesFirst(page, "Have Alexis and I agreed on a monthly grocery budget?", rank))).toEqual([
      "old",
      "new",
    ]);
    for (const asks of [
      "How much is our monthly grocery budget with Alexis?",
      "WHEN did the grocery budget with Alexis start?",
    ]) {
      expect(ids(serveLaterUpdatesFirst(page, asks, rank))[0]).toBe("new");
    }
  });

  it("links only the first line: an older record lower on the page keeps its place", () => {
    const page = [
      record("other", OTHER, { at: EARLY }),
      record("old", AGREED, { at: EARLY }),
      record("new", RAISED, { at: LATER }),
    ];

    expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["other", "old", "new"]);
  });

  it("links a bare number only when the word of change stands right before it, said of the thing itself", () => {
    const q = "How many commits have been merged into the main branch of my Git repository?";
    const lead = "USER: I pushed the release, and the main branch of my Git repository has 150 commits.";
    const near = "USER: The main branch has now reached 165, so what next?";
    const far = "USER: The commits merged into the main branch now stands at about 165, which looks fine.";
    // beam-c1-KU-1: what "has now reached 165" here is the object of "into", not a thing this reads.
    const objectOfPreposition =
      "USER: Given the commits merged into the main branch, which has now reached 165, what next?";
    const page = (later: string) => [record("old", lead, { at: EARLY }), record("new", later, { at: LATER })];

    expect(ids(serveLaterUpdatesFirst(page(near), q, rank))).toEqual(["new", "old"]);
    expect(ids(serveLaterUpdatesFirst(page(far), q, rank))).toEqual(["old", "new"]);
    expect(ids(serveLaterUpdatesFirst(page(objectOfPreposition), q, rank))).toEqual(["old", "new"]);
  });

  it("does not compare years, versions or ranges as values", () => {
    const q = "What is the release number of the budget tracker app?";
    const lead = "USER: The budget tracker app release is tagged v1.0.0 with 150 commits.";
    for (const later of [
      "USER: The budget tracker app release moved to 2025.",
      "USER: The budget tracker app release was updated to v1.1.0 today.",
      "USER: The budget tracker app release was cut to 5-7 screens.",
    ]) {
      const page = [record("old", lead, { at: EARLY }), record("new", later, { at: LATER })];
      expect(ids(serveLaterUpdatesFirst(page, q, rank))).toEqual(["old", "new"]);
    }
  });

  it("reads a date the same however its month is spelled", () => {
    const q = "When does the grocery budget with Alexis start?";
    const lead = "USER: The grocery budget with Alexis starts Sept 1.";
    const same = "USER: The grocery budget with Alexis was moved to September 1, as planned.";
    const moved = "USER: The grocery budget with Alexis was moved to Sept 15.";
    const page = (later: string) => [record("old", lead, { at: EARLY }), record("new", later, { at: LATER })];

    expect(ids(serveLaterUpdatesFirst(page(same), q, rank))).toEqual(["old", "new"]);
    expect(ids(serveLaterUpdatesFirst(page(moved), q, rank))).toEqual(["new", "old"]);
  });

  it("matches clock times, shares and sums as values of their own kind", () => {
    const q = "What time is the Zoom meeting with Professor Danielle?";
    const lead = "USER: The Zoom meeting with Professor Danielle is at 3 PM on March 22.";
    const moved = "USER: The Zoom meeting with Professor Danielle was rescheduled to March 22 at 4:30 p.m.";
    const page = [record("old", lead, { at: EARLY }), record("new", moved, { at: LATER })];
    expect(ids(serveLaterUpdatesFirst(page, q, rank))).toEqual(["new", "old"]);

    const shareQ = "What is the test coverage percentage for my API module?";
    const shareLead = "USER: The API module test coverage is 65% after the first run.";
    const sumLater = "USER: The API module test coverage budget was increased to $65 this month.";
    const shareLater = "USER: The API module test coverage has improved to 78% now.";
    const sharePage = (later: string) => [record("old", shareLead, { at: EARLY }), record("new", later, { at: LATER })];
    expect(ids(serveLaterUpdatesFirst(sharePage(sumLater), shareQ, rank))).toEqual(["old", "new"]);
    expect(ids(serveLaterUpdatesFirst(sharePage(shareLater), shareQ, rank))).toEqual(["new", "old"]);
  });

  it("returns every fact it was given, once, and leaves the page it was given as it was", () => {
    const page = [
      record("old", AGREED, { at: EARLY }),
      record("other", OTHER, { at: LATER }),
      record("new", RAISED, { at: LATER }),
    ];
    const before = structuredClone(page);

    const served = serveLaterUpdatesFirst(page, QUERY, rank);

    expect([...ids(served)].sort()).toEqual([...ids(page)].sort());
    expect(page).toEqual(before);
    expect(serveLaterUpdatesFirst(page, QUERY, rank)).toEqual(served);
    expect(serveLaterUpdatesFirst([], QUERY, rank)).toEqual([]);
  });

  it("serves no mark it did not make: a mark the store returned is dropped", () => {
    const page = [
      { ...record("old", AGREED, { at: EARLY }), laterRecordsAbove: 3 },
      { ...record("other", OTHER, { at: LATER }), laterRecordsAbove: 1 },
    ];

    expect(marks(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual([0, 0]);
    expect(marks(serveLaterUpdatesFirst(page, "Have we agreed on a budget?", rank))).toEqual([0, 0]);
  });

  it("reads change words and terms whatever their case or punctuation", () => {
    const shouted = "USER: MY GROCERY BUDGET WAS INCREASED, TO $550 MONTHLY.";
    const page = [record("old", AGREED, { at: EARLY }), record("new", shouted, { at: LATER })];

    expect(ids(serveLaterUpdatesFirst(page, QUERY, rank))).toEqual(["new", "old"]);
  });
});

/** The ids memory_query serves for a first line `lead` and one later line `later`, for `query`. */
function servedPair(query: string, lead: string, later: string): string[] {
  return ids(
    serveLaterUpdatesFirst([record("old", lead, { at: EARLY }), record("new", later, { at: LATER })], query, rank),
  );
}

// Sentences from the retrieval lab's BEAM run (beam-c<conversation>-<question>), trimmed to the
// part that decides. The first group are real updates the link keeps; the second were linked by
// the head this replaced and are not updates.
describe("serveLaterUpdatesFirst on the lab's own sentences", () => {
  it.each([
    [
      "c1-KU-0, a change said in a relative clause",
      "What is the average response time of the dashboard API?",
      "USER: I'm trying to optimize the dashboard API response time, which was initially 800ms, and I've managed to reduce it to 300ms by caching.",
      "USER: I'm trying to optimize the dashboard API response time, which has recently improved to 250ms after adding some caching tweaks, but I want to check my dependencies.",
    ],
    [
      "c3-KU-0, the new <thing> of <value>",
      "What is the deadline for completing the first sprint focused on the basic layout and navigation?",
      "USER: I have a deadline of April 1, 2024, for the first sprint, which covers the basic layout and navigation.",
      "USER: I'm trying to update my project timeline to reflect the new sprint deadline of April 5, 2024, but I'm having trouble with Trello.",
    ],
    [
      "c7-KU-1, <thing> reached <value>",
      "How many words does my final essay draft contain?",
      "USER: I'm finalizing my first draft of the essay by May 15, 2024, and I have 4,500 words to submit, can you help me?",
      "USER: I'm trying to improve my essay writing, especially since my final draft reached 4,700 words by May 13, which is more than I targeted.",
    ],
    [
      "c13-KU-1, a month range names when, not what",
      "What is my monthly budget for books and subscriptions?",
      "USER: I spent $43 on books and subscriptions in January, which is $8 over my $35 monthly budget, can you help me cut back?",
      "USER: I'm trying to decide on a new series to read, and I've increased my April-June book budget to $75, which is more than before.",
    ],
    [
      "c15-KU-1, my increased <thing> of <value> is a change already made",
      "What is my annual budget for buying sneakers?",
      "USER: I've spent $575 on sneakers this year and I'm getting close to my $600 annual budget, so what should I prioritize?",
      "USER: I'm considering buying new sneakers with my increased budget of $650, but I've never attended sneaker swap events.",
    ],
    [
      "c18-KU-1, a passive change",
      "When is the deadline for submitting my application for the senior producer role at Montserrat Media Corp?",
      "USER: I'm considering applying for a senior producer role at Montserrat Media Corp, with the application deadline being May 1.",
      "USER: I'm kinda stressed about this senior producer role application, and I just found out the deadline was extended to May 20, so I'm wondering how to use the time.",
    ],
    [
      "c20-KU-1, the increased <thing> to <value>",
      "What is the budget allocated for prototype refinement and patent attorney fees through August?",
      "USER: I'm kinda worried about the $7,000 budget for prototype refinement and patent attorney fees, will it be enough through August 2024?",
      "USER: I'm kinda worried that with the increased budget allocation to $8,000 through August 2024, I might not be able to cover everything, what are my options?",
    ],
  ])("links %s", (_, query, lead, later) => {
    expect(servedPair(query, lead, later)).toEqual(["new", "old"]);
  });

  it.each([
    [
      "c4-KU-0, another score of another subject",
      "What is my accuracy percentage in solving area calculation problems after completing 15 problems?",
      "USER: I'm trying to understand how my accuracy in area calculation problems improved from 70% to 90% after completing 12 problems.",
      "USER: I'm trying to understand how my test score improved from 80% to 92% on congruence proofs and similarity ratio calculations.",
    ],
    [
      "c4-temporal-0, a value the query itself names",
      "Which improvement happened first: my quiz score increasing from 65% to 82%, or my test score rising from 80% to 92% on congruence proofs?",
      "USER: I'm trying to understand how my quiz score improved from 65% to 82% after deepening my understanding.",
      "USER: I'm trying to understand how my test score improved from 80% to 92% on congruence proofs.",
    ],
    [
      "c5-KU-0, minutes of another time do not update hours studied",
      "How many total hours have I spent studying probability basics, including time dedicated to dice roll problems?",
      "USER: I'm trying to track my time spent studying probability basics, and I've already spent 3 hours on it, with 2 hours on dice roll problems.",
      "USER: I'm trying to see how my progress has improved, given that my average problem-solving time reduced from 20 to 12 minutes.",
    ],
    [
      "c10-KU-1, words cut are no deadline",
      "What deadline should I aim for to submit my peer-reviewed draft to the local writing group?",
      "USER: I've set a goal to complete my final draft by October 1, 2024, and I have a peer review session on September 25.",
      "USER: I cut 1,200 words from my draft for concision after peer review on August 7, but I'm wondering if that was right.",
    ],
    [
      "c10-KU-0, the assistant's milestone",
      "What is my weekly word count target for my writing goals?",
      "USER: I just found out my weekly word count target was adjusted to 1,350 words.",
      "USER: I'll set a new milestone. ASSISTANT: Setting a new milestone of 15,000 words is a great goal for your weekly word count.",
    ],
    [
      "c10-KU-0, a change from a value the first line does not state",
      "What is my weekly word count target for my writing goals?",
      "USER: I just found out my weekly word count target was adjusted to 1,350 words.",
      "USER: I've increased my weekly word count from 1,200 to 1,500 words by April 9, tracked via Google Docs.",
    ],
    [
      "c13-temporal-0, reading blocks are not pages",
      "How many days did it take me to finish reading the trilogy after I downloaded it?",
      "USER: I downloaded the trilogy on December 7, and it's a total of 1,150 pages, so how many days will reading it take?",
      "USER: I've extended my February reading blocks to 90 minutes on weekdays to finish the trilogy quickly.",
    ],
    [
      "c16-temporal-1, the assistant's suggested goal",
      "How much is my emergency fund goal?",
      "USER: I've got an emergency fund goal of $2,000 by June 30, 2024.",
      "USER: How can I keep saving? ASSISTANT: Here is a plan. New Goal: your emergency fund goal was increased to $7,500.",
    ],
    [
      "c18-KU-0, a real update said of 'it', which is not read",
      "How many hours of overtime have I tracked most recently?",
      "USER: I'm trying to cut my overtime by 50% in March, so I've been tracking it, and I saw I did 12 hours of overtime in February.",
      "USER: I'm trying to reduce my weekly overtime, and I've managed to cut it down from 12 to 5 hours by April 7, which is a big achievement.",
    ],
    [
      "c16-KU-1, whose first line's $150 is a gift exchange, not the gift budget",
      "What is my total budget for holiday gifts this year?",
      "USER: I'm trying to stick to my spending caps, but with Alexis's family expecting a $150 holiday gift exchange, I'm worried about my budget.",
      "USER: I've adjusted our holiday gift budget to $450, can you help me plan how to allocate this amount?",
    ],
  ])("does not link %s", (_, query, lead, later) => {
    expect(servedPair(query, lead, later)).toEqual(["old", "new"]);
  });
});

describe("serveLaterUpdatesFirst reads only an asserted change of the queried thing", () => {
  const Q = "What is my monthly grocery budget?";
  const LEAD = "USER: My monthly grocery budget is $500.";

  it.each([
    ["a command", "USER: Increase the monthly grocery budget to $550."],
    ["a future change", "USER: My monthly grocery budget will be increased to $550."],
    ["a plan to change it", "USER: I'm planning to raise my monthly grocery budget to $550."],
    ["another period", "USER: My weekly grocery budget was increased to $550."],
    ["another thing with the same head", "USER: My monthly rent budget was increased to $550."],
    ["a pronoun with no queried thing before it", "USER: We talked to the landlord and it was increased to $550."],
    [
      "a change in the question the sentence ends with",
      "USER: Remember my monthly grocery budget, can you confirm it was increased to $550?",
    ],
    [
      "a change said of 'it'",
      "USER: We looked at my monthly grocery budget again, and it was raised to $550 in March.",
    ],
    ["a change said of 'it's'", "USER: We checked my monthly grocery budget, and it's been raised to $550."],
    [
      "a change undone in a later clause",
      "USER: My monthly grocery budget was increased to $550, but that didn't happen in the end.",
    ],
    [
      "a change of another thing the queried one names",
      "USER: The surplus of my monthly grocery budget was increased to $50.",
    ],
    [
      "a change undone later in its sentence",
      "USER: My monthly grocery budget was increased to $550, which Alexis then rejected.",
    ],
    ["a change denied by the clause around it", "USER: I never said my monthly grocery budget was increased to $550."],
    ["a change wished for", "USER: I want my monthly grocery budget increased to $550."],
    ["a change that must still be made", "USER: My monthly grocery budget must be increased to $550."],
    ["a change only tried", "USER: I'm trying to cut my monthly grocery budget to $450."],
    ["a command in the past form", "USER: Cut the monthly grocery budget to $450."],
    ["a value of another kind", "USER: My monthly grocery budget was moved to March 3."],
    ["a new value with no determiner, as in a list of options", "USER: Option B: new monthly grocery budget of $550."],
    [
      "a record an assistant opens",
      "Support bot (assistant): Noted, the monthly grocery budget was increased to $550.",
    ],
  ])("does not link %s", (_, later) => {
    expect(servedPair(Q, LEAD, later)).toEqual(["old", "new"]);
  });

  it.each([
    ["is now <value>", "USER: My monthly grocery budget is now $550."],
    ["a statement before a question", "USER: My monthly grocery budget was increased to $550, how should I spend it?"],
    ["a contraction", "USER: My monthly grocery budget's been raised to $550."],
    ["a month in its name", "USER: My December grocery budget was increased to $550."],
    [
      "a change after a clause that denies something else",
      "USER: I can't complain because my monthly grocery budget was increased to $550.",
    ],
    ["a change managed", "USER: I managed to cut my monthly grocery budget to $450."],
    ["a change with a particle after its object", "USER: I cut my monthly grocery budget down to $450."],
  ])("links %s", (_, later) => {
    expect(servedPair(Q, LEAD, later)).toEqual(["new", "old"]);
  });

  it("reads a date after 'now' as today's date, not a new one", () => {
    const query = "When does my remote work start?";
    const lead = "USER: My remote work starts June 15.";
    expect(servedPair(query, lead, "USER: My remote work start is now July 20.")).toEqual(["old", "new"]);
    expect(servedPair(query, lead, "USER: My remote work start was moved to July 20.")).toEqual(["new", "old"]);
  });

  it("links nothing whose head noun the query does not name, even when the first line names it", () => {
    const lead = "USER: My monthly grocery budget is $500 and the grocery delivery fee is $5.";
    expect(servedPair(Q, lead, "USER: My grocery delivery fee was increased to $7.")).toEqual(["old", "new"]);
  });

  it("skips a sentence longer than 2,000 characters, and reads one just under it", () => {
    const sentence = (length: number) => {
      const change = "USER: My monthly grocery budget was increased to $550 ";
      return `${change}${"and so on ".repeat(Math.ceil((length - change.length) / 10))}`.slice(0, length);
    };
    expect(sentence(1_990).length).toBe(1_990);
    expect(servedPair(Q, LEAD, sentence(1_990))).toEqual(["new", "old"]);
    expect(servedPair(Q, LEAD, sentence(2_010))).toEqual(["old", "new"]);
  });
});

// Each later line below resembles an update, and none is an asserted change of the queried thing.
describe("serveLaterUpdatesFirst does not link what only resembles an update", () => {
  const Q = "What is my monthly grocery budget?";
  const LEAD = "USER: My monthly grocery budget is $500.";

  it.each([
    [
      "What is my annual salary at Acme?",
      "USER: My annual salary at Acme is $90,000.",
      "USER: The parking fee at Acme was raised to $200.",
    ],
    [
      "When is my meeting with Professor Danielle?",
      "USER: My meeting with Professor Danielle is on March 20.",
      "USER: The reminder for my meeting with Professor Danielle was moved to March 19.",
    ],
    [
      "When is my meeting with Professor Danielle?",
      "USER: My meeting with Professor Danielle is on March 20.",
      "USER: The email about my meeting with Professor Danielle was moved to March 18.",
    ],
    [
      "When is my dentist appointment?",
      "USER: My dentist appointment is on May 3.",
      "USER: Mom called; her dentist appointment was moved to May 10.",
    ],
    [
      "When is my dentist appointment?",
      "USER: My dentist appointment is on May 3.",
      "USER: I told Sam his dentist appointment was moved to May 10.",
    ],
    ["What is the estate tax rate?", "USER: The estate tax rate is 40%.", "USER: The tax rate was increased to 45%."],
    [
      "How many hours do I work per week?",
      "USER: I work 40 hours per week.",
      "USER: The heat this week has now reached 50.",
    ],
    [
      "How many hours do I work per week?",
      "USER: I work 40 hours per week.",
      "USER: My work hours were increased to 9 hours per day.",
    ],
    [
      "What is my annual salary at Acme?",
      "USER: My annual salary at Acme is $90,000.",
      "USER: Acme has now reached $8m.",
    ],
    [
      "When is my meeting with professor danielle?",
      "USER: My meeting with professor danielle is on March 20.",
      "USER: Professor Danielle was moved to March 18, after I asked.",
    ],
    [
      "When is my meeting with Professor Danielle?",
      "USER: My meeting with Professor Danielle is on March 20.",
      "USER: My dentist was moved to March 22 and my meeting with Professor Danielle to March 25.",
    ],
  ])("%s: %s / %s", (query, lead, later) => {
    expect(servedPair(query, lead, later)).toEqual(["old", "new"]);
  });

  it.each([
    ["another thing named only by the head noun", "USER: The budget was increased to $5,000."],
    ["another period after the value", "USER: My monthly grocery budget was increased to $150 per week."],
    ["another period after the value, without 'per'", "USER: My monthly grocery budget was increased to $150 a week."],
    ["a difference", "USER: My monthly grocery budget is now $50 more than last month."],
    ["a difference, over", "USER: My monthly grocery budget is now $50 over."],
    [
      "the assistant, labelled in title case",
      "USER: Thanks. Assistant: Noted, the monthly grocery budget was increased to $550.",
    ],
    [
      "the assistant, in the Human/Assistant format",
      "Human: thanks!\n\nAssistant: Noted, the monthly grocery budget was increased to $550.",
    ],
    [
      "the assistant, labelled in bold",
      "**User:** thanks\n**Assistant:** Noted, the monthly grocery budget was increased to $550.",
    ],
    ["an assistant named by its product", "Claude: Noted, the monthly grocery budget was increased to $550."],
    ["a change reversed", "USER: My monthly grocery budget was increased to $550 and then reversed."],
    ["a change rolled back", "USER: My monthly grocery budget was increased to $550 but it was rolled back."],
    [
      "a change called a mistake",
      "USER: I said my monthly grocery budget was increased to $550 but that was a mistake.",
    ],
    ["a change nobody made", "USER: Nobody has increased my monthly grocery budget to $550."],
    ["a doubted change", "USER: I doubt my monthly grocery budget was increased to $550."],
    ["a change called false", "USER: It's false that my monthly grocery budget was increased to $550."],
    ["an app's wrong claim", "USER: The app incorrectly says my monthly grocery budget is now $550."],
    ["an inverted condition", "USER: Were my monthly grocery budget increased to $550, I'd be happy."],
    ["a change in case", "USER: In case my monthly grocery budget is increased to $550, let me know."],
    ["a change once it happens", "USER: Once my monthly grocery budget gets increased to $550, I'll buy salmon."],
    ["an assumed change", "USER: Assuming my monthly grocery budget was increased to $550, what changes?"],
    [
      "a change said for the sake of argument",
      "USER: Say my monthly grocery budget was increased to $550, how would meals change?",
    ],
    ["hearsay", "USER: Alexis said the monthly grocery budget was increased to $550."],
    ["an unconfirmed report", "USER: Apparently my monthly grocery budget was increased to $550."],
    ["a future change", "USER: Next month my monthly grocery budget was increased to $550."],
    ["a new value that starts later", "USER: My new monthly grocery budget of $550 starts next year."],
    ["a change older than the first line", "USER: Last year my monthly grocery budget was increased to $550."],
    ["a change from long ago", "USER: Two years ago my monthly grocery budget was raised to $550."],
    [
      "a change older than an agreement",
      "USER: Before we agreed on $500, my monthly grocery budget had been raised to $550.",
    ],
    ["a change asked in disbelief", "USER: My monthly grocery budget was increased to $550?! No way that's right."],
    [
      "a change asked in brackets",
      "USER: My monthly grocery budget was increased to $550 (really?) according to the app.",
    ],
    [
      "a change taken back in the next sentence",
      "USER: My monthly grocery budget was increased to $550. Never mind, it's still $500.",
    ],
    [
      "a change taken back after a dash",
      "USER: My monthly grocery budget was increased to $550, scratch that, it's still $500.",
    ],
    [
      "a change from a value the first line does not state, said after it",
      "USER: My monthly grocery budget was increased to $550 from $400.",
    ],
    ["a counteroffer", "USER: My counteroffer: monthly grocery budget increased to $550."],
    [
      "a change corrected in its sentence",
      "USER: My monthly grocery budget was increased to $550, oops, I mean the dining budget.",
    ],
    ["a bound", "USER: My monthly grocery budget was increased up to $550."],
    ["a bound after the value", "USER: My monthly grocery budget was increased to $550 max."],
    ["a change that recurs", "USER: My monthly grocery budget is increased to $550 every spring."],
    ["a change older than another", "USER: I had increased my monthly grocery budget to $550 before we agreed."],
    ["a change to someone else's thing", "USER: I raised your monthly grocery budget to $550."],
    ["someone else's new value", "USER: Mom showed me her new monthly grocery budget of $550."],
    [
      "the assistant, labelled in capitals",
      "USER: Thanks. ASSISTANT: Noted, the monthly grocery budget was increased to $550.",
    ],
  ])("does not link %s", (_, later) => {
    expect(servedPair(Q, LEAD, later)).toEqual(["old", "new"]);
  });

  it("does not read an excerpt, whose speaker label may have been cut away", () => {
    const later = {
      ...record("new", "… the monthly grocery budget was increased to $550. …", { at: LATER }),
      excerptOfChars: 4_000,
    };
    expect(ids(serveLaterUpdatesFirst([record("old", LEAD, { at: EARLY }), later], Q, rank))).toEqual(["old", "new"]);
    const whole = record("new", "USER: My monthly grocery budget was increased to $550.", { at: LATER });
    expect(ids(serveLaterUpdatesFirst([record("old", LEAD, { at: EARLY }), whole], Q, rank))).toEqual(["new", "old"]);
  });

  it("moves only versions of an updater's fact that are newer than it, and counts only those", () => {
    const subject = JSON.stringify(["org_1.home", "grocery-budget"]);
    const page = [
      record("old", LEAD, { at: EARLY }),
      {
        ...record("raised", "USER: My monthly grocery budget was raised to $550.", { at: "2026-03-10T10:00:00.000Z" }),
        subject,
      },
      {
        ...record("older", "USER: I'm thinking of adding more beans to my meals.", { at: "2026-03-05T10:00:00.000Z" }),
        subject,
      },
    ];

    const served = serveLaterUpdatesFirst(page, Q, rank);

    expect(ids(served)).toEqual(["raised", "old", "older"]);
    expect(served[1].laterRecordsAbove).toBe(1);
  });

  it("reads a long first line of like statements against a long later line in well under a second", () => {
    const leadText = Array.from({ length: 700 }, (_, i) => `My monthly grocery budget for food is $${1_000 + i}.`).join(
      " ",
    );
    const laterText = Array.from(
      { length: 700 },
      (_, i) => `My weekly grocery budget was raised to $${50_000 + i}.`,
    ).join(" ");
    expect(leadText.length + laterText.length).toBeGreaterThan(60_000);
    const started = performance.now();
    serveLaterUpdatesFirst(
      [record("old", `USER: ${leadText}`, { at: EARLY }), record("new", `USER: ${laterText}`, { at: LATER })],
      Q,
      rank,
    );
    expect(performance.now() - started).toBeLessThan(500);
  });
});

// Qualifiers after the change, sentence openers, other speakers, plans
// without a plan word, and values for another period or occasion. None of these is a change made.
describe("serveLaterUpdatesFirst does not link a change qualified anywhere in its clause or sentence", () => {
  const Q = "What is my monthly grocery budget?";
  const LEAD = "USER: My monthly grocery budget is $500.";

  it.each([
    ["a condition after the value", "USER: My monthly grocery budget was raised to $550 if the bonus came through."],
    ["an exception after the value", "USER: My monthly grocery budget is now $550 unless Alexis objects."],
    ["a doubt after the value", "USER: My monthly grocery budget was raised to $550, I think."],
    ["hearsay after the value", "USER: My monthly grocery budget was raised to $550 apparently."],
    ["an approval still pending", "USER: My monthly grocery budget was increased to $550, pending Alexis's approval."],
    ["a tentative change", "USER: My monthly grocery budget was increased to $550 tentatively."],
    ["a sentence opening with a time", "USER: Last year, my monthly grocery budget was increased to $550."],
    ["a sentence opening with a place in the past", "USER: In college, my monthly grocery budget was raised to $550."],
    ["a sentence opening with a source", "USER: According to Alexis, my monthly grocery budget was increased to $550."],
    [
      "a sentence opening with a past condition",
      "USER: When I lived in Boston my monthly grocery budget was raised to $550.",
    ],
    ["a year after the value", "USER: My monthly grocery budget was increased to $550 in 2023."],
    ["a month after the value", "USER: My monthly grocery budget was bumped to $550 in June."],
    ["a value for one month", "USER: My monthly grocery budget was increased to $650 for December."],
    ["a value for this month only", "USER: My monthly grocery budget was increased to $650 this month only."],
    ["a value per person", "USER: My monthly grocery budget was increased to $150 per person."],
    ["hearsay by text", "USER: Alexis texted me that our monthly grocery budget was raised to $550."],
    [
      "another speaker in a pasted chat",
      "USER: Here's my chat with Alexis.\nAlexis: I raised the monthly grocery budget to $550.\nMe: ok",
    ],
    [
      "an answer under an A: label",
      "Q: what's my monthly grocery budget? A: The monthly grocery budget was increased to $550.",
    ],
    ["a quoted line", "USER: The assistant replied:\n> The monthly grocery budget was increased to $550."],
    [
      "a list a line introduces",
      "USER: Ideas for the blog post:\n- My monthly grocery budget was increased to $550\n- Meal prep tips",
    ],
    ["a joke taken back", "USER: My monthly grocery budget was increased to $550. Just kidding!"],
    ["a correction", "USER: My monthly grocery budget was increased to $550. Correction - it's still $500."],
    ["an attempt", "USER: I'm trying to get my monthly grocery budget raised to $550."],
    ["a command", "USER: Get my monthly grocery budget raised to $550."],
    ["a request to confirm", "USER: Please confirm my monthly grocery budget is now $550."],
    ["an inline label", "USER: Draft: my monthly grocery budget was increased to $550."],
    ["a value someone suggested", "USER: The new monthly grocery budget of $550 Alexis suggested is too high."],
    ["a value still to be signed off", "USER: Our new monthly grocery budget of $550 still needs approval."],
    ["a question with no question mark", "USER: was my monthly grocery budget increased to $550"],
    ["a difference, bigger", "USER: My monthly grocery budget is now $50 bigger than before."],
    ["someone's own thing", "USER: Alexis's monthly grocery budget was increased to $550."],
    ["a game", "USER: In the budgeting game, my monthly grocery budget was raised to $550."],
    ["a condition in a later clause", "USER: My new monthly grocery budget of $550, if Alexis agrees, starts soon."],
    ["a condition set off after the value", "USER: My monthly grocery budget is now $550, assuming the raise happens."],
    ["something read somewhere", "USER: I read that my monthly grocery budget was raised to $550 in the app."],
    [
      "the assistant with no space after its label",
      "USER: thanks\nAssistant:The monthly grocery budget was increased to $550.",
    ],
    [
      "a quoted line under someone else's words",
      "USER: Here it is\n> The monthly grocery budget was increased to $550.",
    ],
    [
      "a question with no question mark, opening on its auxiliary",
      "USER: has my monthly grocery budget been raised to $550 yet",
    ],
    ["a new value with no determiner", "USER: Option B is new monthly grocery budget of $550."],
    [
      "a 'May' that is a month, in a condition",
      "USER: If it rains in May 20 days, my monthly grocery budget was raised to $550.",
    ],
  ])("does not link %s", (_, later) => {
    expect(servedPair(Q, LEAD, later)).toEqual(["old", "new"]);
  });

  it("does not link when the first line's value is not the thing's own", () => {
    const later = "USER: My monthly grocery budget was raised to $550.";
    for (const lead of [
      "USER: I spent $480 of my monthly grocery budget.",
      "USER: I have $120 left in my monthly grocery budget.",
      "USER: My monthly grocery budget covers the $15 Instacart membership.",
      "USER: Alexis's monthly grocery budget is $500.",
      "USER: Her monthly grocery budget is $500.",
      "USER: If my monthly grocery budget were $400, I'd skip organic.",
      "USER: My monthly grocery budget is fine. The rent is $1,500 and that is a lot for a monthly bill.",
      "USER: My monthly grocery budget includes a farmers market trip with Alexis and the kids at $60.",
    ]) {
      expect(servedPair(Q, lead, later), lead).toEqual(["old", "new"]);
    }
  });

  it.each([
    ["a second-hand record", "USER: Here's what Alexis wrote. My monthly grocery budget was increased to $550."],
    ["someone else's, by pronoun", "USER: I checked, and her monthly grocery budget was increased to $550."],
    ["someone else's new value, by pronoun", "USER: I saw their new monthly grocery budget of $550."],
    [
      "a question after a comma, with no question mark",
      "USER: Quick one, has my monthly grocery budget been raised to $550",
    ],
    [
      "a change from a value the first line does not state, said before it",
      "USER: My monthly grocery budget was raised from $400 to $550.",
    ],
    ["a plan in an earlier sentence", "USER: Planning ahead for 2027. My monthly grocery budget is now $550."],
    [
      "a dream",
      "USER: I had a weird dream last night. My monthly grocery budget was raised to $550 and I bought lobster.",
    ],
    ["someone else's", "USER: My sister is struggling with money. The monthly grocery budget was cut to $300."],
    ["a sentence opening on a place", "USER: At the office, the monthly grocery budget was raised to $550."],
    ["a value for a span of months", "USER: My monthly grocery budget was raised to $1,000 for two months."],
    [
      "an assistant turn under a Markdown heading",
      "### User\nthanks\n### Assistant\nThe monthly grocery budget was increased to $550.",
    ],
    [
      "an assistant turn in the ChatGPT export",
      "## You\nthanks\n## ChatGPT\nThe monthly grocery budget was increased to $550.",
    ],
    ["an assistant turn in brackets", "[user] thanks\n[assistant] The monthly grocery budget was increased to $550."],
    ["an assistant turn after a dash", "USER: thanks\nAssistant — The monthly grocery budget was increased to $550."],
  ])("does not link %s", (_, later) => {
    expect(servedPair(Q, LEAD, later)).toEqual(["old", "new"]);
  });

  it("does not link a count of another unit", () => {
    const query = "How many hours do I study each week?";
    const lead = "USER: I study 10 hours each week.";
    expect(servedPair(query, lead, "USER: My weekly study hours were increased to 12 sessions.")).toEqual([
      "old",
      "new",
    ]);
    expect(servedPair(query, lead, "USER: My weekly study hours were increased to 12 hours.")).toEqual(["new", "old"]);
  });

  it("does not link another person's thing, even one the first line names", () => {
    const query = "What is the monthly grocery budget Alexis and I have agreed on?";
    const lead = "USER: I've agreed with Alexis on a $500 monthly joint budget for groceries starting Sept 1.";
    expect(servedPair(query, lead, "USER: Alexis's grocery budget was increased to $550.")).toEqual(["old", "new"]);
    expect(servedPair(query, lead, "USER: Our grocery budget was increased to $550.")).toEqual(["new", "old"]);
  });

  it("does not link another thing named after the head noun", () => {
    const query = "How much is the budget for groceries?";
    const lead = "USER: The budget for groceries is $500 and the budget for dining is $200.";
    expect(servedPair(query, lead, "USER: The budget for dining was increased to $250.")).toEqual(["old", "new"]);
    expect(servedPair(query, lead, "USER: The budget for groceries was increased to $550.")).toEqual(["new", "old"]);
  });

  it("does not link a name the query only puts after a preposition, however it is spelled", () => {
    const query = "what is my salary at acme?";
    const lead = "USER: My salary at acme is $90,000.";
    expect(servedPair(query, lead, "USER: Acme is now $8m.")).toEqual(["old", "new"]);
    expect(servedPair(query, lead, "USER: My salary was raised to $95,000.")).toEqual(["new", "old"]);
  });

  it("reads 'May' before a day as a month, not a possibility", () => {
    const query = "When is the project deadline?";
    const lead = "USER: The project deadline is April 30.";
    expect(servedPair(query, lead, "USER: The project deadline was extended to May 20.")).toEqual(["new", "old"]);
    expect(servedPair(query, lead, "USER: The project deadline may be extended to May 20.")).toEqual(["old", "new"]);
  });

  it("reads a run of asterisks and a first line of many statements in linear time, without throwing", () => {
    const stars = "*".repeat(60_000);
    const started = performance.now();
    serveLaterUpdatesFirst(
      [record("old", `USER: ${LEAD} ${stars}`, { at: EARLY }), record("new", stars, { at: LATER })],
      Q,
      rank,
    );
    expect(performance.now() - started).toBeLessThan(500);
    const many = Array.from({ length: 160_000 }, (_, i) => `grocery budget q${i}x $${i}.`).join("\n");
    // 160,000 statements: more than a spread into Math.max takes as arguments.
    expect(() =>
      serveLaterUpdatesFirst([record("old", many, { at: EARLY }), record("new", "USER: x", { at: LATER })], Q, rank),
    ).not.toThrow();
  }, 60_000);
});

describe("serveLaterUpdatesFirst does not link a thing named inside a longer name", () => {
  it("does not link a name that runs into a number", () => {
    const query = "When is my report due?";
    const lead = "USER: My report is due March 15.";
    expect(servedPair(query, lead, "USER: The deadline for the March 22 report was moved to April 1.")).toEqual([
      "old",
      "new",
    ]);
    expect(servedPair(query, lead, "USER: My report was moved to April 1.")).toEqual(["new", "old"]);
  });

  it("does not link a word the first line only uses to qualify another noun", () => {
    const query = "What is my savings rate?";
    const lead = "USER: My savings rate is 15%.";
    expect(servedPair(query, lead, "USER: My savings grew to 20%.")).toEqual(["old", "new"]);
    expect(servedPair(query, lead, "USER: My savings rate was raised to 20%.")).toEqual(["new", "old"]);
  });
});

describe("serveLaterUpdatesFirst reads a phrase after the value as part of the thing", () => {
  const Q = "What is my monthly grocery budget?";
  const LEAD = "USER: My monthly grocery budget is $500.";

  it("links a phrase after the value that names the queried thing, and not one that names another", () => {
    expect(servedPair(Q, LEAD, "USER: My monthly budget was increased to $550 for groceries.")).toEqual(["new", "old"]);
    expect(servedPair(Q, LEAD, "USER: My monthly grocery budget was increased to $550 for the beach house.")).toEqual([
      "old",
      "new",
    ]);
  });

  it("links an after-value phrase that names nothing, and reads 'on' as a scope only after 'to <value>'", () => {
    for (const later of [
      "USER: My monthly grocery budget was increased to $550 for good.",
      "USER: My monthly grocery budget was raised to $550 for everyone.",
      "USER: My monthly grocery budget was raised to $550 at my annual review.",
    ]) {
      expect(servedPair(Q, LEAD, later), later).toEqual(["new", "old"]);
    }
    expect(servedPair(Q, LEAD, "USER: My increased monthly grocery budget of $550 went on organic produce.")).toEqual([
      "new",
      "old",
    ]);
    expect(servedPair(Q, LEAD, "USER: My monthly grocery budget was raised to $550 on the vacation account.")).toEqual([
      "old",
      "new",
    ]);
  });

  it("reads a neutral phrase as neutral only when it is the whole phrase", () => {
    expect(
      servedPair(Q, LEAD, "USER: My monthly grocery budget was increased to $550 for good, and I'm relieved."),
    ).toEqual(["new", "old"]);
    for (const later of [
      "USER: My monthly grocery budget was increased to $550 for good at the beach house.",
      "USER: My monthly grocery budget was raised to $550 for everyone in the Seattle branch.",
      "USER: My monthly grocery budget was raised to $550 for everybody at the co-op.",
      "USER: My monthly grocery budget was raised to $550 at our yearly review of the rental.",
    ]) {
      expect(servedPair(Q, LEAD, later), later).toEqual(["old", "new"]);
    }
  });

  it("reads through, via, by and with as scope prepositions, and a month after them names nothing", () => {
    for (const later of [
      "USER: My monthly grocery budget was raised to $550 through the food bank.",
      "USER: My monthly grocery budget was raised to $550 via the credit union.",
      "USER: My monthly grocery budget was raised to $550 by the housing board.",
      "USER: My monthly grocery budget was raised to $550 with the meal kit plan.",
    ]) {
      expect(servedPair(Q, LEAD, later), later).toEqual(["old", "new"]);
    }
    expect(servedPair(Q, LEAD, "USER: My monthly grocery budget was raised to $550 by March.")).toEqual(["new", "old"]);
    expect(servedPair(Q, LEAD, "USER: My monthly grocery budget was raised to $550 through August.")).toEqual([
      "new",
      "old",
    ]);
  });

  it("reads a capitalized code spelled like a common word as a code, except in all-caps text", () => {
    for (const later of [
      "USER: My monthly grocery budget was raised to $550 for ME.",
      "USER: My monthly grocery budget was raised to $550 in OR.",
      "USER: My monthly grocery budget was raised to $550 for P&L.",
      "USER: My monthly grocery budget was raised to $550 with AT&T.",
    ]) {
      expect(servedPair(Q, LEAD, later), later).toEqual(["old", "new"]);
    }
    expect(servedPair(Q, LEAD, "USER: My monthly grocery budget was raised to $550 for me.")).toEqual(["new", "old"]);
    expect(servedPair(Q, LEAD, "USER: MY MONTHLY GROCERY BUDGET WAS RAISED TO $550 FOR ME.")).toEqual(["new", "old"]);
  });

  it("links a code the question and first line both name", () => {
    const query = "What is my marketing budget for IT?";
    const lead = "USER: My marketing budget is $8,000 for IT.";
    expect(servedPair(query, lead, "USER: My marketing budget was increased to $10,000 for IT.")).toEqual([
      "new",
      "old",
    ]);
    expect(servedPair(query, lead, "USER: My marketing budget was increased to $10,000 for R&D.")).toEqual([
      "old",
      "new",
    ]);
  });

  it("reads a scope the value's clause hides behind a comma, a dash or a list", () => {
    expect(servedPair(Q, LEAD, "USER: My monthly grocery budget was increased to $550 for good :)")).toEqual([
      "new",
      "old",
    ]);
    for (const later of [
      "USER: My monthly grocery budget was increased to $550 for good, for the beach house.",
      "USER: My monthly grocery budget was raised to $550 for everyone, on the vacation account.",
      "USER: My monthly grocery budget was increased to $550 for good and for the beach house.",
      "USER: My monthly grocery budget was increased to $550 — for the beach house.",
      "USER: My monthly grocery budget was increased to $550 for groceries and household supplies.",
      "USER: My monthly grocery budget was increased to $550 for groceries or takeout.",
    ]) {
      expect(servedPair(Q, LEAD, later), later).toEqual(["old", "new"]);
    }
    expect(
      servedPair(Q, LEAD, "USER: My monthly grocery budget was increased to $550 for groceries and I'm relieved."),
    ).toEqual(["new", "old"]);
    expect(
      servedPair(Q, LEAD, "USER: My monthly grocery budget was increased to $550 for good and the kids love it."),
    ).toEqual(["new", "old"]);
  });

  it("reads the other prepositions that put a value on another thing", () => {
    for (const later of [
      "USER: My monthly grocery budget was raised to $550 from the side business.",
      "USER: My monthly grocery budget was raised to $550 toward the beach house.",
      "USER: My monthly grocery budget was raised to $550 towards the beach house.",
      "USER: My monthly grocery budget was raised to $550 thru the food bank.",
      "USER: My monthly grocery budget was raised to $550 w/ the side business.",
      "USER: My monthly grocery budget was raised to $550 outside the Denver office.",
      "USER: My monthly grocery budget was raised to $550 beyond the beach house.",
      "USER: My monthly grocery budget was raised to $550 alongside the beach house.",
      "USER: My monthly grocery budget was raised to $550 upon joining the co-op board.",
    ]) {
      expect(servedPair(Q, LEAD, later), later).toEqual(["old", "new"]);
    }
    expect(servedPair(Q, LEAD, "USER: My monthly grocery budget was raised from $500 to $550.")).toEqual([
      "new",
      "old",
    ]);
  });

  it("reads every spelling of a short code, and reads a capitalized 'or' as 'or' unless it follows a preposition", () => {
    for (const later of [
      "USER: My monthly grocery budget was raised to $550 for I.T.",
      "USER: My monthly grocery budget was raised to $550 for the U.K.",
      "USER: My monthly grocery budget was raised to $550 for r&d.",
      "USER: My monthly grocery budget was raised to $550 for R & D.",
      "USER: My monthly grocery budget was raised to $550 for R.&D.",
      "USER: My monthly grocery budget was raised to $550 for the OR.",
    ]) {
      expect(servedPair(Q, LEAD, later), later).toEqual(["old", "new"]);
    }
    expect(servedPair(Q, LEAD, "USER: My monthly grocery budget was raised to $550 SO I can cook more.")).toEqual([
      "new",
      "old",
    ]);
    expect(servedPair(Q, LEAD, "USER: MY MONTHLY GROCERY BUDGET WAS RAISED TO $550k FOR ME.")).toEqual(["new", "old"]);
    const query = "What is my marketing budget for r&d?";
    const lead = "USER: My marketing budget is $8,000 for r&d.";
    expect(servedPair(query, lead, "USER: My marketing budget was increased to $10,000 for R&D.")).toEqual([
      "new",
      "old",
    ]);
  });

  it("reads the words of a value after the change as that value, not a scope", () => {
    const query = "When is my dentist appointment?";
    const lead = "USER: My dentist appointment is on March 15.";
    for (const later of [
      "USER: My dentist appointment was moved to March 22 at 4:30 PM.",
      "USER: My dentist appointment was moved to March 22 at 10 AM.",
    ]) {
      expect(servedPair(query, lead, later), later).toEqual(["new", "old"]);
    }
  });
});
