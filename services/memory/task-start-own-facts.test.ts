// The order the task-start block serves a task's own facts in (services/memory/task-start.ts,
// rankTaskFacts): the facts a writer declared decide the task first; within each role tier, the
// newest source on the session's subject that quotes none of it, its parts in written order, then the
// writes most relevant to what the session is doing, the newest first among equals, and a write
// that restates the session's own text last. Which facts are the
// task's is decided by its identity alone and is covered in the database suites; this file
// covers only their order.
import { describe, expect, it } from "vitest";
import { NO_WEIGHTS } from "./relevance";
import { factRoleTier } from "./fact-roles";
import { rankTaskFacts, weighTaskFacts, writesOf, type ServedFact } from "./task-start";

const NAME = "acme/storefront pull request #140";

/** A fact the task wrote; `minutesAgo` orders them, the read hands them over newest first. */
function fact(id: string, content: string, minutesAgo: number, role: ServedFact["role"] = null): ServedFact {
  const writtenAt = new Date(Date.UTC(2026, 9, 1, 12, 0) - minutesAgo * 60_000).toISOString();
  return { id, entityName: NAME, content, role, writtenAt, ofTask: true };
}

/** Weights for `prompt` among `facts`' writes, as the read weighs them. */
const weightsFor = (prompt: string, facts: readonly ServedFact[]) => weighTaskFacts(prompt, facts);

const ids = (facts: readonly ServedFact[]) => facts.map((f) => f.id);

describe("rankTaskFacts", () => {
  const header = `On pull request #140 of acme/storefront, reviewer-a wrote a comment:`;
  const facts = [
    fact("ack", `${header}\nThanks, on it.`, 1),
    fact("bot", `${header}\nAutomated review: consider renaming the helper.`, 2),
    fact(
      "decision",
      `${header}\nKickback: the cursor in app/api/invoices/route.ts is read after the limit, so a row repeats.`,
      3,
    ),
    fact("pr", `Pull request #140 of acme/storefront, opened by builder-b.`, 4),
  ];

  it("serves the write most relevant to the session's words first, ahead of newer ones on something else", () => {
    const prompt = "Fix the invoices pagination cursor in app/api/invoices/route.ts";
    expect(ids(rankTaskFacts(facts, weightsFor(prompt, facts)))[0]).toBe("decision");
  });

  it("keeps the order read, newest first, among writes equally relevant", () => {
    const prompt = "zz9 nothing any record holds";
    expect(ids(rankTaskFacts(facts, weightsFor(prompt, facts)))).toEqual(["ack", "bot", "decision", "pr"]);
    // Two writes that hold the same terms the same number of times: the newer one first.
    const twins = [
      fact("newer", "The ledger retry fires twice.", 1),
      fact("older", "The ledger retry fires twice.", 2),
    ];
    expect(ids(rankTaskFacts(twins, weightsFor("ledger retry", twins)))).toEqual(["newer", "older"]);
  });

  it("changes nothing when the session's words name no term", () => {
    expect(ids(rankTaskFacts(facts, NO_WEIGHTS))).toEqual(ids(facts));
  });

  it("gives a term every write holds no say: the repository name does not reorder them by their length", () => {
    const prompt = "acme/storefront pull request #140";
    // Every fact holds these words; weighed at all, the shortest would come first.
    expect(ids(rankTaskFacts(facts, weightsFor(prompt, facts)))).toEqual(["ack", "bot", "decision", "pr"]);
    // They still weigh in cutting an excerpt.
    expect([...weightsFor(prompt, facts).byTerm.keys()]).toContain("storefront");
  });

  it("still ranks by the session's words when fewer than two writes may be weighed", () => {
    const due = (f: ServedFact) => ({ ...f, erasureCheckDue: true as const });
    const older = due(fact("older-hit", "The invoices cursor repeats a row.", 2));
    const newer = due(fact("newer-miss", "Thanks, on it.", 1));
    expect(ids(rankTaskFacts([newer, older], weightsFor("invoices cursor", [newer, older])))).toEqual([
      "older-hit",
      "newer-miss",
    ]);
    const clear = fact("clear-miss", "Noted.", 0);
    expect(ids(rankTaskFacts([clear, newer, older], weightsFor("invoices cursor", [clear, newer, older])))[0]).toBe(
      "older-hit",
    );
  });

  it("weighs no write due the erased-person check: a fact the check may withhold never reorders the rest", () => {
    const a = fact("a", "Note on alpha.", 1);
    const b = fact("b", "Note on beta.", 2);
    const due = { ...fact("e", "Someone raised alpha.", 3), erasureCheckDue: true as const };
    const without = rankTaskFacts([a, b], weightsFor("alpha beta", [a, b]));
    const withDue = rankTaskFacts([a, b, due], weightsFor("alpha beta", [a, b, due])).filter((f) => f.id !== "e");
    expect(ids(withDue)).toEqual(ids(without));
    expect(weightsFor("alpha beta", [a, b, due])).toEqual(weightsFor("alpha beta", [a, b]));
  });

  it("serves a fact its writer declared decides the task ahead of a more relevant one with no role, and progress last", () => {
    const declared = [
      fact("progress-hit", "Progress: the invoices cursor test now covers app/api/invoices/route.ts.", 1, "progress"),
      fact("plain-hit", "The invoices cursor in app/api/invoices/route.ts repeats a row.", 2),
      fact("decided", "Ship behind a flag, off by default.", 3, "decision"),
      fact("plain-miss", "Thanks, on it.", 4),
    ];
    const prompt = "invoices cursor app/api/invoices/route.ts";
    expect(ids(rankTaskFacts(declared, weightsFor(prompt, declared)))).toEqual([
      "decided",
      "plain-hit",
      "plain-miss",
      "progress-hit",
    ]);
    expect(declared.map((f) => factRoleTier(f.role))).toEqual([2, 1, 0, 1]);
  });

  it("keeps the parts of one write together and in written order, ranked by all their text", () => {
    const at = 5;
    const parts = [
      fact("p1", `${header}\nQA: rejected at abc1234.`, at),
      fact("p2", `${header}\nThe defect: the invoices cursor is read after the limit.`, at),
      fact("p3", `${header}\nAdd a test for app/api/invoices/route.ts.`, at),
    ];
    const newer = fact("newer", `${header}\nLGTM.`, 1);
    const ranked = rankTaskFacts(
      [newer, ...parts],
      weightsFor("invoices cursor app/api/invoices/route.ts", [newer, ...parts]),
    );
    expect(ids(ranked)).toEqual(["p1", "p2", "p3", "newer"]);
  });
});

describe("rankTaskFacts: the newest source leads", () => {
  const link = (n: number) => `https://github.com/acme/storefront/pull/140#issuecomment-${n}`;
  /** One part of comment `n`, as an import writes a long comment: one write per part, each citing it. */
  const part = (id: string, n: number, text: string, minutesAgo: number) =>
    fact(id, `On pull request #140 of acme/storefront, reviewer-a wrote a comment (${link(n)}): ${text}`, minutesAgo);
  const prompt = "Fix the invoices cursor in app/api/invoices/route.ts";
  // Newest first, as the read hands them over: comment 2 in three parts, written one after another.
  const facts = [
    part("c2-p3", 2, "Add a test for the invoices cursor.", 1),
    part("c2-p2", 2, "Details follow.", 2),
    part("c2-p1", 2, "Rejected at abc1234: a row repeats.", 3),
    part(
      "c1-p1",
      1,
      "The invoices cursor in app/api/invoices/route.ts is read after the limit, and the cursor helper too.",
      4,
    ),
    fact("note", "Thanks, on it.", 5),
  ];

  it("serves every part of the newest source first, in the order written, ahead of more relevant writes", () => {
    expect(ids(rankTaskFacts(facts, weightsFor(prompt, facts), prompt))).toEqual([
      "c2-p1",
      "c2-p2",
      "c2-p3",
      "c1-p1",
      "note",
    ]);
  });

  it("ends the newest source at the first write that cites another link", () => {
    const interleaved = [facts[0]!, facts[1]!, part("c9", 9, "Unrelated.", 2.5), facts[2]!, facts[3]!];
    expect(ids(rankTaskFacts(interleaved, weightsFor(prompt, interleaved), prompt)).slice(0, 2)).toEqual([
      "c2-p2",
      "c2-p3",
    ]);
  });

  it("ends the newest source at a write under another name, even one citing the same link", () => {
    const renamed = [facts[0]!, { ...facts[1]!, entityName: "acme/other" }, facts[2]!, facts[3]!];
    expect(ids(rankTaskFacts(renamed, weightsFor(prompt, renamed), prompt))[0]).toBe("c2-p3");
  });

  it("serves a newest write that cites no link alone ahead of the rest", () => {
    const plain = [fact("plain", "Pushed the invoices cursor fix.", 0), ...facts];
    expect(ids(rankTaskFacts(plain, weightsFor(prompt, plain), prompt)).slice(0, 2)).toEqual(["plain", "c1-p1"]);
  });

  it("passes over a newer source that holds none of the session's telling terms", () => {
    const offTopic = [
      part("deploy", 3, "The docs preview build finished.", 0),
      part("c2-p1", 2, "Rejected: a row repeats in the invoices cursor.", 1),
      ...facts.slice(3),
    ];
    expect(ids(rankTaskFacts(offTopic, weightsFor(prompt, offTopic), prompt))[0]).toBe("c2-p1");
  });

  it("leads with nothing when no source holds the session's telling terms", () => {
    const offTopic = [part("deploy", 3, "The docs preview build finished.", 0), fact("note", "Thanks, on it.", 5)];
    expect(ids(rankTaskFacts(offTopic, weightsFor(prompt, offTopic), prompt))).toEqual(["deploy", "note"]);
  });

  it("passes over a newer source any part of which quotes the session's text", () => {
    const quoting = [
      part("q-p2", 3, "Will push shortly.", 0),
      part("q-p1", 3, `Working on: ${prompt}.`, 0.5),
      ...facts.slice(3),
    ];
    expect(ids(rankTaskFacts(quoting, weightsFor(prompt, quoting), prompt)).slice(0, 1)).toEqual(["c1-p1"]);
  });

  it("takes each role tier's own newest source", () => {
    const onSubject = part("c2-p1", 2, "Rejected: the invoices cursor repeats a row.", 3);
    const olderHit = fact("older-hit", "The invoices cursor in app/api/invoices/route.ts: fix the invoices cursor.", 6);
    const declared = [
      { ...facts[0]!, role: "progress" as const },
      facts[1]!,
      onSubject,
      { ...facts[3]!, role: "decision" as const },
      facts[4]!,
      olderHit,
    ];
    // No role: c2-p2 and c2-p1 are that tier's newest source, ahead of a more relevant older write.
    expect(ids(rankTaskFacts(declared, weightsFor(prompt, declared), prompt))).toEqual([
      "c1-p1",
      "c2-p1",
      "c2-p2",
      "older-hit",
      "note",
      "c2-p3",
    ]);
  });
});

describe("rankTaskFacts: a write restating the session's own text", () => {
  const brief = "Fix the invoices cursor in app/api/invoices/route.ts";
  const facts = [
    fact("ack", "Thanks, on it.", 1),
    fact("pr", `Pull request #140 of acme/storefront, "${brief}", opened by builder-b.`, 2),
    fact("review", "The invoices cursor is read after the limit.", 3),
  ];

  it("serves it after the tier's other writes, however relevant", () => {
    expect(ids(rankTaskFacts(facts, weightsFor(brief, facts), brief))).toEqual(["review", "ack", "pr"]);
  });

  it("counts a clause of the session's text only whole, and only of four words or more", () => {
    expect(
      ids(rankTaskFacts(facts, weightsFor(brief, facts), "Fix the invoices cursor in app/api/refunds")).at(-1),
    ).not.toBe("pr");
    const shortLine = "invoices cursor";
    expect(ids(rankTaskFacts(facts, weightsFor(shortLine, facts), shortLine))[0]).not.toBe("ack");
    expect(ids(rankTaskFacts(facts, weightsFor(brief, facts), `PR-140\n${brief}`)).at(-1)).toBe("pr");
    // A task named as "<repository> pull request #140: <title>": the title is a clause of its own.
    expect(
      ids(rankTaskFacts(facts, weightsFor(brief, facts), `acme/storefront pull request #140: ${brief}`)).at(-1),
    ).toBe("pr");
    // "cursor is read now" is not quoted by "cursor is read nowhere, now": whole words, never part of one.
    const partWord = [fact("plain", "Thanks.", 1), fact("nowhere", "The invoices cursor is read nowhere, now.", 2)];
    expect(
      ids(rankTaskFacts(partWord, weightsFor("invoices cursor", partWord), "The invoices cursor is read now"))[0],
    ).toBe("nowhere");
  });
});

describe("writesOf", () => {
  it("joins the parts stored at one instant under one name and role, and nothing else", () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString();
    const base = { entityName: NAME, role: null, ofTask: true as const };
    const facts: ServedFact[] = [
      { ...base, id: "a1", content: "a", writtenAt: at(1) },
      { ...base, id: "a2", content: "a", writtenAt: at(1) },
      { ...base, id: "other-name", content: "b", writtenAt: at(1), entityName: "acme/other" },
      { ...base, id: "other-role", content: "c", writtenAt: at(1), role: "progress" },
      { ...base, id: "no-time", content: "d" },
      { ...base, id: "no-time-2", content: "d" },
    ];
    expect(writesOf(facts).map((write) => write.map((f) => f.id))).toEqual([
      ["a1", "a2"],
      ["other-name"],
      ["other-role"],
      ["no-time"],
      ["no-time-2"],
    ]);
  });
});
