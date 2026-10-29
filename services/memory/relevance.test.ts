// What the task-start block counts as relevant to a task, and which passage of a record it
// serves (services/memory/relevance.ts).
import { describe, expect, it } from "vitest";
import {
  NO_WEIGHTS,
  RELATED_TERM_WEIGHT,
  TEXT_RANKED_CHARS,
  bestPassage,
  clip,
  holdsATaskTerm,
  isAboutTheTask,
  ownTermsOf,
  rankByRelevance,
  relevance,
  termCountsOf,
  termsOf,
  weighTaskTerms,
} from "./relevance";

/** Weights for `task` over `texts`, the records being ranked. */
const weightsFor = (task: string, texts: string[]) => weighTaskTerms(task, texts.map(termCountsOf));

describe("termsOf", () => {
  it("keeps an identifier whole and in parts, and drops short and common words", () => {
    expect([...termsOf("Fix the session2-run-state item for #139")].sort()).toEqual(
      ["#139", "139", "fix", "item", "session2", "session2-run-state", "run", "state"].sort(),
    );
  });

  it("keeps a pull request number shorter than three digits, written with its hash", () => {
    expect(termsOf("Review #42 before merging")).toContain("#42");
    expect(termsOf("Review PR 42 before merging")).not.toContain("42");
  });

  it("keeps a path whole and in parts, without the punctuation that ends a sentence", () => {
    expect([...termsOf("The defect is in app/api/facts/[id]/route.ts.")]).toEqual(
      expect.arrayContaining(["app/api/facts/[id]/route.ts", "app", "api", "facts", "route", "defect"]),
    );
  });

  it("reads letters outside ASCII as letters, and splits on punctuation outside it", () => {
    expect([...termsOf("Café—über straße")].sort()).toEqual(["café", "straße", "über"]);
  });
});

describe("weighTaskTerms", () => {
  const records = [
    "acme/storefront: progress on the pagination work",
    "acme/storefront: pagination tests pass",
    "acme/storefront: the defect is in listInvoices",
    "acme/storefront: pagination docs updated",
  ];

  it("weighs a word every record holds below one few records hold", () => {
    const weights = weightsFor("acme/storefront pagination defect", records);
    expect(weights.byTerm.get("acme/storefront")!).toBeLessThan(weights.byTerm.get("pagination")!);
    expect(weights.byTerm.get("pagination")!).toBeLessThan(weights.byTerm.get("defect")!);
    expect(weights.byTerm.get("acme/storefront")!).toBeGreaterThan(0);
  });

  it("weighs an identifier double a word exactly as rare", () => {
    const weights = weightsFor("defect listInvoices", records);
    expect(weights.byTerm.get("listinvoices")).toBeCloseTo(2 * weights.byTerm.get("defect")!, 10);
  });

  it("weighs nothing for a task that names nothing", () => {
    expect(weightsFor("", records).byTerm.size).toBe(0);
    expect(relevance(weightsFor("", records), records[0]!)).toBe(0);
  });

  describe("names the task's own records hold", () => {
    const counts = records.map(termCountsOf);

    it("rank a record, at the related weight of the identifier they are", () => {
      const weights = weighTaskTerms("defect", counts, { related: "listInvoices" });
      const asTask = weighTaskTerms("defect listInvoices", counts);
      expect(weights.byTerm.get("listinvoices")).toBeCloseTo(
        RELATED_TERM_WEIGHT * asTask.byTerm.get("listinvoices")!,
        10,
      );
      expect(weights.byTerm.get("defect")).toBe(asTask.byTerm.get("defect"));
      expect(relevance(weights, "the listInvoices handler")).toBeGreaterThan(0);
    });

    it("never make a record about the task, nor admit one that holds no word of the task's own", () => {
      const weights = weighTaskTerms("cursor defect", counts, { related: "listInvoices app/api/invoices.ts" });
      const relatedOnly = termsOf("listInvoices app/api/invoices.ts");
      expect(isAboutTheTask(weights, relatedOnly)).toBe(false);
      expect(holdsATaskTerm(weights, relatedOnly)).toBe(false);
      expect(isAboutTheTask(weights, termsOf("the cursor defect"))).toBe(true);
    });

    it("weigh nothing on their own: a task that names nothing is still served as one", () => {
      expect(weighTaskTerms("", counts, { related: "listInvoices" })).toBe(NO_WEIGHTS);
    });

    it("leave a term the task names at the task's own weight", () => {
      const weights = weighTaskTerms("pagination", counts, { related: "pagination" });
      expect(weights.byTerm.get("pagination")).toBe(weighTaskTerms("pagination", counts).byTerm.get("pagination"));
      expect([...weights.byTerm.keys()]).toEqual(["pagination"]);
    });
  });

  describe("the task's name, beside what the session is doing", () => {
    const counts = records.map(termCountsOf);
    const name = "ledger-idempotency-retry";
    const prompt = "check the flaky vitest shard in cli hooks and the eslint ratchet before pushing the branch";

    it("alone decides what is about the task: a long prompt cannot outvote it", () => {
      const weights = weighTaskTerms(`${name}\n${prompt}`, counts, { name });
      const aboutTheName = termsOf("ledger-idempotency-retry: the dedupe uses a unique index");
      expect(isAboutTheTask(weights, aboutTheName)).toBe(true);
      expect(holdsATaskTerm(weights, termsOf("a retry reads Retry-After"))).toBe(true);
    });

    it("leaves the prompt's words ranking a record but never making it about the task", () => {
      const weights = weighTaskTerms(`${name}\n${prompt}`, counts, { name });
      const aboutThePrompt = termsOf(prompt);
      expect(relevance(weights, prompt)).toBeGreaterThan(0);
      expect(isAboutTheTask(weights, aboutThePrompt)).toBe(false);
      expect(holdsATaskTerm(weights, aboutThePrompt)).toBe(false);
    });

    it("weighs every term as the text alone would", () => {
      const named = weighTaskTerms(`${name}\n${prompt}`, counts, { name });
      expect(named.byTerm).toEqual(weighTaskTerms(`${name}\n${prompt}`, counts).byTerm);
    });

    it("falls back to every term of the text when the name holds none of them", () => {
      expect(ownTermsOf(prompt, "")).toEqual(termsOf(prompt));
      expect(ownTermsOf(prompt, "T-1")).toEqual(termsOf(prompt));
      expect(ownTermsOf(`${name} ${prompt}`, name)).toEqual(termsOf(name));
    });
  });
});

describe("rankByRelevance", () => {
  const task = "Fix the invoices pagination cursor in app/api/invoices/route.ts";
  const pool = [
    "Fixed the invoices pagination cursor, pushed.",
    "Pagination of invoices: the cursor fix is in.",
    "The defect is in app/api/invoices/route.ts.",
    "Weekly notes.",
  ];

  it("ranks a record naming the task's path above records sharing more of its common words", () => {
    const weights = weightsFor(task, pool);
    const ranked = rankByRelevance(pool, weights, termCountsOf);
    expect(ranked[0]).toBe("The defect is in app/api/invoices/route.ts.");
  });

  it("ranks a short record naming the task's path twice above a long digest naming every task word once", () => {
    const digest = `Weekly digest. ${"Unrelated items from the week. ".repeat(30)}Fix, invoices, pagination, cursor, app/api/invoices/route.ts.`;
    const focused = "Review: app/api/invoices/route.ts reads the cursor late; app/api/invoices/route.ts needs a test.";
    const others = ["Invoices pagination notes.", "Cursor docs.", "Release notes."];
    const weights = weightsFor(task, [digest, focused, ...others]);
    expect(rankByRelevance([digest, focused], weights, termCountsOf)[0]).toBe(focused);
  });

  it("ranks a record that says the same in fewer words above one padded with others, though the padded one is newer", () => {
    const padded = `Note: the invoices cursor is wrong. ${"Unrelated items from the week. ".repeat(20)}`;
    const short = "Note: the invoices cursor is wrong.";
    const weights = weightsFor(task, [padded, short, "Release notes.", "Pagination notes."]);
    expect(rankByRelevance([padded, short], weights, termCountsOf)[0]).toBe(short);
  });

  it("keeps records that score the same in the order they came, so recency breaks ties", () => {
    const tied = ["newest: invoices", "older: invoices", "oldest: invoices"];
    expect(rankByRelevance(tied, weightsFor(task, tied), termCountsOf)).toEqual(tied);
  });
});

describe("bestPassage", () => {
  const task = "Fix the invoices pagination cursor in app/api/invoices/route.ts";
  const defect = "The defect is in app/api/invoices/route.ts: the cursor is read after the limit.";
  const comment = [
    "QA: changes requested at abc1234, not merged.",
    "Tested at head abc1234.",
    "I ran the full suite against a real Postgres and every test passes.",
    `${defect} Page two repeats the last row of page one.`,
    "Types and lint are clean.",
  ].join("\n");
  const weights = weightsFor(task, [comment, "Pagination notes.", "Release notes."]);

  it("serves the run of sentences that covers the task's terms, from the one that names them", () => {
    const passage = bestPassage(comment, weights, 300);
    expect(passage.startsWith(`… ${defect}`)).toBe(true);
    expect(passage).not.toContain("QA: changes requested");
  });

  it("stays within its length, saying with an ellipsis that text follows", () => {
    const passage = bestPassage(comment, weights, 100);
    expect(Array.from(passage).length).toBeLessThanOrEqual(100);
    expect(passage).toContain("app/api/invoices/route.ts");
    expect(passage.endsWith("…")).toBe(true);
  });

  it("ends at a whole sentence and marks what follows, rather than filling the room and dropping the mark", () => {
    // 61 and 37 characters: the two fit 100 together, but not with the mark that more follows.
    const first = "The invoices cursor is read after the limit, says reviewer-a.";
    const second = "Nothing else here, just filler words.";
    expect([first.length, second.length]).toEqual([61, 37]);
    const passage = bestPassage(`${first} ${second} More filler follows.`, weights, 100);
    expect(passage).toBe(`${first} …`);
  });

  it("serves a record's opening, cut as clip cuts it, when it holds none of the task's terms", () => {
    const unrelated = `Quarterly offsite seating.\n${"Bring a laptop. ".repeat(40)}`;
    expect(bestPassage(unrelated, weights, 300)).toBe(clip(unrelated, 300));
    expect(bestPassage(comment, NO_WEIGHTS, 300)).toBe(clip(comment, 300));
  });

  it("shows a sentence repeated within the run once", () => {
    const repeated = `${defect}\n${defect}\nThe cursor fix needs a test.`;
    const passage = bestPassage(repeated, weights, 400);
    expect(passage.split(defect)).toHaveLength(2);
    expect(passage).toContain("The cursor fix needs a test.");
  });

  it("prefers the earliest of two runs that cover the same terms", () => {
    const twice = `${defect} Intro done.\n${"Filler sentence here. ".repeat(10)}\n${defect.replace("The defect", "Again, the defect")}`;
    expect(bestPassage(twice, weights, 120).startsWith(defect)).toBe(true);
  });

  it("finds the task's terms whatever case a sentence writes them in", () => {
    const record = "Intro line here.\nThe ACTORPICKER RETRY fires twice on a degraded load.\nUnrelated closing words.";
    const weightsHere = weightsFor("ActorPicker retry", [record, "Release notes.", "Other notes."]);
    expect(
      bestPassage(record, weightsHere, 120).startsWith("… The ACTORPICKER RETRY fires twice on a degraded load."),
    ).toBe(true);
  });

  it("reads only the first TEXT_RANKED_CHARS characters of a record", () => {
    const deep = `Opening line.\n${"Filler sentence about nothing. ".repeat(140)}The invoices cursor is wrong.`;
    expect(deep.indexOf("invoices")).toBeGreaterThan(TEXT_RANKED_CHARS);
    expect(bestPassage(deep, weights, 300)).toBe(clip(deep, 300));
  });

  it("stays fast on a huge record, whether its sentences repeat or not", () => {
    const repeated = `${defect} `.repeat(6_000);
    const varied = Array.from({ length: 25_000 }, (_, i) => `Finding ${i} on the invoices cursor.`).join(" ");
    for (const text of [repeated, varied]) {
      expect(text.length).toBeGreaterThan(400_000);
      const started = performance.now();
      bestPassage(text, weights, 560);
      expect(performance.now() - started).toBeLessThan(50);
    }
  });

  it("cuts one sentence longer than the room without splitting a character", () => {
    const long = `The invoices cursor ${"😀".repeat(300)} ends here.`;
    const passage = bestPassage(long, weights, 50);
    expect(Array.from(passage)).toHaveLength(50);
    expect(passage.endsWith("😀…")).toBe(true);
  });

  it("marks text after a middle sentence that fits beside the leading mark but not beside both", () => {
    // Behind "… " a 100-character line has room for 98 characters, or 96 with " …" after them.
    for (const length of [97, 98]) {
      const words = `The invoices cursor is read after the limit${" again".repeat(20)}`.slice(0, length - 1).trimEnd();
      const middle = `${words.padEnd(length - 1, "x")}.`;
      expect(Array.from(middle)).toHaveLength(length);
      const passage = bestPassage(`Opening words. ${middle} Closing words.`, weights, 100);
      expect(Array.from(passage).length).toBeLessThanOrEqual(100);
      expect(passage.startsWith("… The invoices cursor")).toBe(true);
      expect(passage.endsWith("…")).toBe(true);
    }
  });
});
