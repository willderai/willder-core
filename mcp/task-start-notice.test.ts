// renderTaskStartBlock at its seams: ranked records in, bounded text and a revision out;
// and the client hints a call carries in `_meta`. The database side is covered in
// task-start-notice.realdb.test.ts; what counts as relevant, in services/memory/relevance.test.ts.
import { describe, expect, it } from "vitest";
import { NO_WEIGHTS, TEXT_RANKED_CHARS, termCountsOf, weighTaskTerms } from "@/services/memory/relevance";
import { recordRevisionKey, revisionToken } from "@/services/memory/revision";
import { weighTaskFacts } from "@/services/memory/task-start";
import {
  RESERVED_RULE_LINES,
  RULE_TEXT_MAX_CHARS,
  TASK_FACT_EXCERPT_CHARS,
  TASK_START_MAX_TOKENS,
  TASK_START_TOKEN_BUDGET,
  connectionTaskOf,
  estimateTokens,
  headerPromptOf,
  rankingTextOf,
  renderTaskStartBlock,
  sessionKeyOf,
  taskKeyOf,
  taskTextOf,
} from "./task-start-notice";
import { TASK_START_HEADER, TASK_START_HEADINGS, TASK_START_PREMISE_CHECK } from "./task-start-headings";
import { withoutSources } from "./task-start-headings";

/**
 * Whether `text` keeps its records within the budget and the whole block within its maximum: the
 * premise check is a line that shows no record, added on top of the records' room (recordRoom), and
 * the lines' sources ride on their own allowance (SOURCE_ALLOWANCE_TOKENS).
 */
function expectWithinBudget(text: string): void {
  expect(estimateTokens(withoutSources(text.replace(`\n${TASK_START_PREMISE_CHECK}`, "")))).toBeLessThanOrEqual(
    TASK_START_TOKEN_BUDGET,
  );
  expect(estimateTokens(text)).toBeLessThanOrEqual(TASK_START_MAX_TOKENS);
}

const rule = (id: string, text = "Dedupe accounts by email domain.") => ({
  id,
  kind: "convention" as const,
  subject: "Account dedupe",
  text,
});
const write = (id: string) => ({
  id,
  recordType: "brief",
  recordId: `brief-${id}`,
  op: "create" as const,
  actorId: "agent-a",
  summary: "Handoff for item-42",
});

describe("renderTaskStartBlock", () => {
  it("says nothing when there is nothing to serve", () => {
    expect(renderTaskStartBlock({ rules: [], writes: [], stale: [] })).toEqual({
      text: null,
      revision: revisionToken([]),
      factVersionIds: [],
      shownFactIds: [],
      lines: [],
      readScopes: [],
    });
  });

  it("lists the scope's rules as settled, then the writes and stale flags related to the task", () => {
    const flaggedAt = new Date("2026-09-26T00:00:00Z");
    const { text } = renderTaskStartBlock({
      rules: [rule("r1")],
      writes: [write("w1")],
      stale: [
        { id: "p1", scopePath: "org_a.eng", graphitiFactUuid: "f1", sourceType: "pr", sourceRef: "12", flaggedAt },
      ],
    });
    expect(text).toBe(
      [
        TASK_START_HEADER,
        TASK_START_HEADINGS.rules,
        "- [convention r1] Account dedupe: Dedupe accounts by email domain. — unknown",
        TASK_START_HEADINGS.related,
        "- create brief brief-w1 by agent-a: Handoff for item-42",
        "- fact f1: its pr 12 moved since it was recorded",
      ].join("\n"),
    );
  });

  it("cuts a long rule to a compact line and marks the cut", () => {
    const { text } = renderTaskStartBlock({ rules: [rule("r1", "y".repeat(400))], writes: [], stale: [] });
    expect(text).toContain(`${"y".repeat(RULE_TEXT_MAX_CHARS - 1)}…`);
    expect(text).not.toContain("y".repeat(RULE_TEXT_MAX_CHARS));
  });

  it("stays within its budget, whole lines only, and counts what it left out", () => {
    const rules = Array.from({ length: 20 }, (_, i) => rule(`r${i}`, "z".repeat(100)));
    const { text } = renderTaskStartBlock({ rules, writes: [], stale: [] }, 300);
    expect(estimateTokens(withoutSources(text!))).toBeLessThanOrEqual(300);
    const served = text!.split("\n").filter((line) => line.startsWith("- [convention"));
    expect(served.every((line) => withoutSources(line).endsWith("z".repeat(100)))).toBe(true);
    expect(text).toMatch(new RegExp(`\\(${20 - served.length} more left out: ask memory_query for them\\)$`));
  });

  describe("the scope's rules, on compact lines", () => {
    /** A rule shaped like a team's recorded decision, a person's: a long id, a name for a subject and a paragraph of text. */
    const decisionRule = (i: number) => ({
      id: `cm${String(i).padStart(23, "0")}`,
      kind: "decision" as const,
      by: "person" as const,
      subject: `team-decision-release-process-step-${i}-20261001`,
      text: Array.from(
        { length: 10 },
        (_, k) => `Clause ${k} of decision ${i} says how releases are cut and checked.`,
      ).join(" "),
    });

    it("fits at least nine long decisions in the budget, where lines of the full length fit five", () => {
      const rules = Array.from({ length: 20 }, (_, i) => decisionRule(i));
      const { text } = renderTaskStartBlock({ rules, writes: [], stale: [] });
      expect(estimateTokens(withoutSources(text!))).toBeLessThanOrEqual(TASK_START_TOKEN_BUDGET);
      expect(text!.split("\n").filter((line) => line.startsWith("- [decision"))).toHaveLength(9);
    });

    it("serves the task's own decision at the full line length, and the same text as a scope rule compact", () => {
      const own = { ...decisionRule(1), text: "y".repeat(400) };
      const scope = { ...decisionRule(2), text: "y".repeat(400) };
      const { text } = renderTaskStartBlock({ decisions: [own], facts: [], rules: [scope], writes: [], stale: [] });
      const [ownLine, scopeLine] = text!.split("\n").filter((line) => line.startsWith("- [decision"));
      expect(ownLine).toContain(`${"y".repeat(299)}…`);
      expect(scopeLine).toContain(`${"y".repeat(RULE_TEXT_MAX_CHARS - 1)}…`);
      expect(scopeLine).not.toContain("y".repeat(RULE_TEXT_MAX_CHARS));
    });

    it("never gives a scope rule the longer passage, though it is about the task and a write of the same text gets it", () => {
      const task = "Fix invoices pagination in app/api/invoices/route.ts";
      const about = Array.from(
        { length: 8 },
        (_, k) => `Finding ${k}: the invoices pagination cursor in app/api/invoices/route.ts skips a row.`,
      ).join(" ");
      const weights = weighTaskTerms(task, [termCountsOf(about)]);
      const ruleAbout = { id: "r-about", kind: "convention" as const, subject: "Invoices", text: about };
      const writeAbout = { ...write("w1"), recordType: "fact", recordId: "v-w1", summary: "Invoices", content: about };
      const { text } = renderTaskStartBlock({ rules: [ruleAbout], writes: [writeAbout], stale: [], weights }, 2000);
      const passageOf = (prefix: string) => {
        const line = text!.split("\n").find((l) => l.startsWith(prefix))!;
        return Array.from(line.slice(line.indexOf(": ") + 2)).length;
      };
      expect(passageOf("- [convention r-about]")).toBeLessThanOrEqual(RULE_TEXT_MAX_CHARS);
      expect(passageOf("- create fact v-w1")).toBeGreaterThan(300);
    });
  });

  it("names the fact versions its shown lines create, and none it left out or that are not facts", () => {
    const fact = (id: string, op: "create" | "supersede" = "create") => ({
      ...write(id),
      recordType: "fact",
      recordId: `v-${id}`,
      op,
    });
    const writes = [
      fact("w1"),
      fact("w2", "supersede"),
      write("w3"),
      ...Array.from({ length: 30 }, (_, i) => fact(`late${i}`)),
    ];
    const { text, factVersionIds } = renderTaskStartBlock({ rules: [], writes, stale: [] }, 300);
    const shown = text!
      .split("\n")
      .filter((line) => line.startsWith("- create fact"))
      .map((line) => line.split(" ")[3]);
    expect(shown.length).toBeLessThan(31);
    expect(factVersionIds).toEqual(shown);
    expect(factVersionIds[0]).toBe("v-w1");
  });

  it("revises by exactly what was served, whatever order it was gathered in", () => {
    const served = renderTaskStartBlock({ rules: [rule("r1"), rule("r2")], writes: [write("w1")], stale: [] });
    const reordered = renderTaskStartBlock({ rules: [rule("r2"), rule("r1")], writes: [write("w1")], stale: [] });
    expect(served.revision).toBe(reordered.revision);
    expect(served.revision).toBe(
      revisionToken([
        recordRevisionKey("convention", "r1", 1),
        recordRevisionKey("convention", "r2", 1),
        recordRevisionKey("change", "w1", 1),
      ]),
    );
    expect(renderTaskStartBlock({ rules: [rule("r1")], writes: [], stale: [] }).revision).not.toBe(served.revision);
  });

  describe("with what an earlier session of the task left", () => {
    const decision = { id: "d1", kind: "decision" as const, subject: "Retry policy", text: "At most 5 attempts." };
    const fact = (id: string, content: string, entityName: string | null = "Release plan") => ({
      id,
      entityName,
      content,
      role: null,
    });

    it("prints a rule's subject and a fact's name on one line, whatever whitespace the writer put in them", () => {
      const { text } = renderTaskStartBlock({
        decisions: [{ ...decision, subject: "approach\n\nnotes" }],
        facts: [fact("v2", "Ship on Monday.", "cause\r\n\n\t detail")],
        rules: [],
        writes: [],
        stale: [],
      });
      expect(text).toBe(
        [
          TASK_START_HEADER,
          TASK_START_HEADINGS.leads,
          TASK_START_PREMISE_CHECK,
          "- [decision d1] [untested plan: verify before following] approach notes: At most 5 attempts. — unknown",
          "- [plan · proposed] Ship on Monday. [fact v2] cause detail — unknown",
        ].join("\n"),
      );
    });

    it("labels a fact by what backs it, never by its writer's role alone: a person's is settled, anyone else's a lead", () => {
      const { text, factVersionIds } = renderTaskStartBlock({
        decisions: [],
        facts: [
          { ...fact("v4", "Retries double-charge."), role: "cause", by: "agent" },
          { ...fact("v5", "Retries go through the ledger."), role: "decision", by: "person" },
          { ...fact("v6", "Rejected: retry forever."), role: "rejected" },
          fact("v2", "Ship on Monday."),
        ],
        rules: [],
        writes: [],
        stale: [],
      });
      expect(text).toBe(
        [
          TASK_START_HEADER,
          TASK_START_HEADINGS.settled,
          "- [decision · verified: recorded by a person] Retries go through the ledger. [fact v5] Release plan — unknown",
          TASK_START_HEADINGS.leads,
          TASK_START_PREMISE_CHECK,
          "- [cause · proposed] Retries double-charge. [fact v4] Release plan — unknown",
          "- [rejected option · proposed] Rejected: retry forever. [fact v6] Release plan — unknown",
          "- [plan · proposed] Ship on Monday. [fact v2] Release plan — unknown",
        ].join("\n"),
      );
      expect(factVersionIds).toEqual(["v5", "v4", "v6", "v2"]);
    });

    it("serves the task's decisions and facts ahead of the scope's rules, saying nothing twice", () => {
      const { text, factVersionIds } = renderTaskStartBlock({
        decisions: [decision],
        facts: [fact("v2", "Ship on Monday."), fact("v3", "No entity.", null)],
        rules: [decision, rule("r1")],
        writes: [{ ...write("w1"), recordType: "fact", recordId: "v2" }, write("w2")],
        stale: [],
      });
      expect(text).toBe(
        [
          TASK_START_HEADER,
          TASK_START_HEADINGS.leads,
          TASK_START_PREMISE_CHECK,
          "- [decision d1] [untested plan: verify before following] Retry policy: At most 5 attempts. — unknown",
          "- [plan · proposed] Ship on Monday. [fact v2] Release plan — unknown",
          "- [plan · proposed] No entity. [fact v3] — unknown",
          TASK_START_HEADINGS.rules,
          "- [convention r1] Account dedupe: Dedupe accounts by email domain. — unknown",
          TASK_START_HEADINGS.related,
          "- create brief brief-w2 by agent-a: Handoff for item-42",
        ].join("\n"),
      );
      expect(factVersionIds).toEqual(["v2", "v3"]);
    });

    it("spends the budget on the task first", () => {
      const rules = Array.from({ length: 20 }, (_, i) => rule(`r${i}`, "z".repeat(200)));
      const { text } = renderTaskStartBlock(
        { decisions: [], facts: [fact("v2", "Ship on Monday.")], rules, writes: [], stale: [] },
        200,
      );
      expect(text).toContain("- [plan · proposed] Ship on Monday. [fact v2] Release plan — unknown");
    });

    it("puts a fact on one line, cut to its excerpt", () => {
      const { text } = renderTaskStartBlock({
        decisions: [],
        facts: [fact("v1", `first line\nsecond line ${"😀".repeat(400)}`)],
        rules: [],
        writes: [],
        stale: [],
      });
      expect(text!.split("\n")[3]).toBe(
        `- [plan · proposed] first line second line ${"😀".repeat(TASK_FACT_EXCERPT_CHARS - 24)}… [fact v1] Release plan — unknown`,
      );
    });
  });
});

describe("serving what a record says, not how it starts", () => {
  const task = "Fix invoices pagination in app/api/invoices/route.ts";
  const defect =
    "The defect is in app/api/invoices/route.ts: the cursor is read after the limit, so page two repeats a row.";
  const review = [
    "QA: rejected at abc1234, not merged.",
    "On pull request #140 of acme/storefront, reviewer-a wrote a comment:",
    "I ran the full suite against a real Postgres and every test passes. ".repeat(4).trim(),
    `${defect} Add a test with two rows on one timestamp.`,
  ].join("\n");
  const weightsOver = (texts: string[]) => weighTaskTerms(task, texts.map(termCountsOf));
  const items = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));

  describe("the scope's other records, by their passage most relevant to the task", () => {
    const write = (id: string, content: string, actorId = "agent-a") => ({
      id,
      recordType: "fact",
      recordId: `v-${id}`,
      op: "create" as const,
      actorId,
      summary: content.split("\n", 1)[0]!,
      content,
    });
    type Write = ReturnType<typeof write>;
    const render = (writes: Write[], weights = weightsOver(writes.map((w) => w.content)), budget?: number) =>
      renderTaskStartBlock({ rules: [], writes, stale: [], weights }, budget).text!;
    const passageOf = (line: string) => Array.from(line.slice(line.indexOf(": ") + 2)).length;

    it("serves the sentence that names the task, though it sits four sentences in", () => {
      const [line] = items(render([write("w1", review)]));
      expect(line).toContain(defect);
      expect(line).not.toContain("QA: rejected");
      expect(line!.startsWith("- create fact v-w1 by agent-a: … The defect is in")).toBe(true);
    });

    it("gives the first three records about the task the longer passage, and the rest the short one", () => {
      const long = (i: number) =>
        Array.from(
          { length: 8 },
          (_, k) =>
            `Finding ${k} of note ${i}: the invoices pagination cursor in app/api/invoices/route.ts skips a row.`,
        ).join(" ");
      const passages = items(
        render(
          Array.from({ length: 4 }, (_, i) => write(`w${i}`, long(i))),
          undefined,
          2000,
        ),
      ).map(passageOf);
      expect(passages.slice(0, 3).every((length) => length > 300 && length <= 560)).toBe(true);
      expect(passages[3]).toBeLessThanOrEqual(300);
    });

    it("serves a record's short passage when its longer one does not fit the budget", () => {
      const text = render([write("w1", review.repeat(3))], undefined, 120);
      expect(estimateTokens(text)).toBeLessThanOrEqual(120);
      const [line] = items(text);
      expect(passageOf(line!)).toBeLessThanOrEqual(300);
      expect(line).toContain("app/api/invoices/route.ts");
    });

    it("serves a record that holds none of the task's terms exactly as it would with no task named", () => {
      const rule = {
        id: "r1",
        kind: "convention" as const,
        subject: "Seating",
        text: `Quarterly offsite seating. ${"Bring a laptop and a charger. ".repeat(20)}`,
      };
      const render = (weights: typeof NO_WEIGHTS) =>
        renderTaskStartBlock({ rules: [rule], writes: [], stale: [], weights }).text;
      expect(render(weightsOver([rule.text, review]))).toBe(render(NO_WEIGHTS));
    });

    it("gives no longer-passage slot to a line about the task that fits in neither form", () => {
      const sentences = (i: number) =>
        Array.from(
          { length: 8 },
          (_, k) =>
            `Finding ${k} of note ${i}: the invoices pagination cursor in app/api/invoices/route.ts skips a row.`,
        ).join(" ");
      // A writer id so long that the line fits with no passage, but not with even the short one.
      const writes = [
        write("w0", sentences(0), "x".repeat(2120)),
        ...Array.from({ length: 3 }, (_, i) => write(`w${i + 1}`, sentences(i + 1))),
      ];
      const lines = items(render(writes));
      expect(lines.some((line) => line.includes("v-w0"))).toBe(false);
      expect(lines.map(passageOf)).toHaveLength(3);
      expect(lines.map(passageOf).every((length) => length > 300)).toBe(true);
    });

    // The cost claim, stated without a clock: only the first TEXT_RANKED_CHARS characters of a rule
    // are ever searched for the passage, however long the rule is. A sentence about the task past
    // that point is therefore never found, which is also why a huge rule costs no more than a
    // 4,000-character one. The wall-clock budget is in task-start-notice.perf.test.ts.
    describe("cuts a rule's text before looking for its passage, so a huge rule costs little", () => {
      const filler = "Quarterly offsite seating is arranged by the facilities team each spring. ";
      const hugeRuleWith = (before: string) => {
        const text = `${before}${filler.repeat(Math.ceil(TEXT_RANKED_CHARS / filler.length))}${defect} ${filler.repeat(2_000)}`;
        return { id: "r-huge", kind: "convention" as const, subject: "Invoices", text };
      };
      const renderRule = (rule: ReturnType<typeof hugeRuleWith>) =>
        renderTaskStartBlock({ rules: [rule], writes: [], stale: [], weights: weightsOver([rule.text]) }).text;

      it("never finds a sentence about the task that lies past the characters it reads", () => {
        const rule = hugeRuleWith("");
        expect(rule.text.indexOf(defect)).toBeGreaterThan(TEXT_RANKED_CHARS);
        const text = renderRule(rule);
        expect(text).not.toContain(defect);
        // Served as a rule that holds none of the task's terms is: its opening, as with no task named.
        expect(text).toBe(renderTaskStartBlock({ rules: [rule], writes: [], stale: [], weights: NO_WEIGHTS }).text);
      });

      it("finds the same sentence when it lies inside the characters it reads", () => {
        const rule = {
          id: "r-huge",
          kind: "convention" as const,
          subject: "Invoices",
          text: `${filler.repeat(3)}${defect} ${filler.repeat(2_000)}`,
        };
        expect(rule.text.indexOf(defect)).toBeLessThan(TEXT_RANKED_CHARS);
        expect(renderRule(rule)).toContain("route.ts");
      });
    });

    it("marks a write's passage as superseded before its text, when a conflict retired the version it created", () => {
      const retired = {
        ...write("w1", review),
        recordId: "v9",
        summary: "[superseded by v10] QA: rejected",
        supersededById: "v10",
      };
      const { text } = renderTaskStartBlock({
        rules: [],
        writes: [retired],
        stale: [],
        weights: weightsOver([review]),
      });
      expect(text).toContain(`- create fact v9 by agent-a: [superseded by v10] … ${defect}`);
    });
  });

  describe("the task's own writes, one excerpt each", () => {
    const at = "2026-10-01T10:00:00.000Z";
    const name = "acme/storefront pull request #140";
    const fact = (id: string, content: string, writtenAt = at) => ({
      id,
      entityName: name,
      content,
      role: null,
      writtenAt,
    });
    const header = "On pull request #140 of acme/storefront, reviewer-a wrote a comment:";
    const filler = (n: number, id: string) =>
      Array.from({ length: n }, (_, k) => `Check ${k} of ${id} passed on the branch.`).join(" ");
    /** A comment of about 1,500 characters, its defect sentence about 900 characters in. */
    const longReview = (id: string, minute: number) =>
      fact(
        id,
        `QA: rejected.\n${header}\n${filler(22, id)} ${defect} ${filler(12, id)}`,
        `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`,
      );
    const parts = [
      fact("p1", `QA: rejected at abc1234, not merged.\n${header}\nTested at head abc1234. Every test passes.`),
      fact("p2", `${header}\n${defect}`),
      fact("p3", `${header}\nAdd a test with two rows on one timestamp.`),
    ];
    const older = fact("old", "Progress: step 3 done.", "2026-10-01T09:00:00.000Z");
    type Fact = ReturnType<typeof fact>;
    const render = (
      facts: Fact[],
      factWeights = weighTaskFacts(task, facts),
      more: { rules?: ReturnType<typeof rule>[] } = {},
      budget?: number,
    ) =>
      renderTaskStartBlock(
        { decisions: [], facts, rules: more.rules ?? [], writes: [], stale: [], factWeights },
        budget,
      );
    /** What a fact line says: its text between its status label and " [fact". */
    const excerptOf = (line: string) => line.slice(line.indexOf("] ") + 2, line.indexOf(" [fact "));

    it("serves a long write as one excerpt, cut at the sentence the session's words hit", () => {
      const [line] = items(render([longReview("review", 0)]).text!);
      expect(excerptOf(line!)).toContain(defect);
      expect(Array.from(excerptOf(line!)).length).toBeLessThanOrEqual(200);
      expect(TASK_FACT_EXCERPT_CHARS).toBe(200);
      expect(line).not.toContain("QA: rejected");
    });

    it("cuts the excerpt around the session's terms though a short write repeats all of them", () => {
      const fixNote = fact(
        "fix",
        `${header}\nFixed the invoices pagination cursor in app/api/invoices/route.ts.`,
        "2026-10-01T11:00:00.000Z",
      );
      const lines = items(render([fixNote, longReview("review", 0)]).text!);
      expect(lines.find((line) => line.includes("[fact review]"))).toContain("app/api/invoices/route.ts");
    });

    it("leaves the rules' room though notes on other tasks are named before them", () => {
      const facts = Array.from({ length: 12 }, (_, i) => longReview(`r${i}`, 59 - i));
      const rules = Array.from({ length: 6 }, (_, i) =>
        rule(`r${i}`, `Rule ${i} says how this team ships a change, and who signs it off before release.`),
      );
      const note = (id: string) => ({
        id,
        agentId: "agent-b",
        scopePath: "org_a.eng",
        task: `other ${id}`,
        kind: "claim" as const,
        body: "b",
        expiresAt: new Date("2026-10-14T12:00:00Z"),
        ofTask: false,
      });
      const { text } = renderTaskStartBlock({
        decisions: [],
        facts,
        rules,
        writes: [],
        stale: [],
        factWeights: weighTaskFacts(task, facts),
        notes: { served: [note("n1"), note("n2")], total: 9 },
      });
      expectWithinBudget(text!);
      expect(items(text!).filter((line) => line.startsWith("- [convention")).length).toBeGreaterThanOrEqual(
        RESERVED_RULE_LINES,
      );
    });

    it("serves a write's opening, cut short, when the session's words hit nothing in it", () => {
      const [line] = items(render([longReview("review", 0)], NO_WEIGHTS).text!);
      expect(excerptOf(line!).startsWith("QA: rejected. On pull request #140")).toBe(true);
      expect(Array.from(excerptOf(line!)).length).toBeLessThanOrEqual(TASK_FACT_EXCERPT_CHARS);
    });

    it("fits seven long writes in the budget, where serving each whole fit two", () => {
      const facts = Array.from({ length: 20 }, (_, i) => longReview(`r${i}`, 59 - i));
      const { text } = render(facts);
      expectWithinBudget(text!);
      expect(items(text!).length).toBeGreaterThanOrEqual(7);
      expect(items(text!).length).toBeLessThan(20);
      expect(text!.endsWith(`(${20 - items(text!).length} more left out: ask memory_query for them)`)).toBe(true);
    });

    it("still fits five beside the room it leaves for the scope's first rules", () => {
      const facts = Array.from({ length: 12 }, (_, i) => longReview(`r${i}`, 59 - i));
      const rules = Array.from({ length: 6 }, (_, i) =>
        rule(`r${i}`, `Rule ${i} says how this team ships a change, and who signs it off before release.`),
      );
      const { text } = render(facts, undefined, { rules });
      expectWithinBudget(text!);
      expect(items(text!).filter((line) => line.includes("[fact ")).length).toBeGreaterThanOrEqual(5);
      expect(items(text!).filter((line) => line.startsWith("- [convention")).length).toBeGreaterThanOrEqual(
        RESERVED_RULE_LINES,
      );
    });

    it("says once, in the section's heading, that each line is an excerpt memory_version opens whole", () => {
      const lines = render([longReview("review", 0)]).text!.split("\n");
      expect(lines[1]).toBe(TASK_START_HEADINGS.leads);
      expect(lines[2]).toBe(TASK_START_PREMISE_CHECK);
      expect(TASK_START_HEADINGS.leads).toContain("memory_version");
      expect(lines.filter((line) => line.includes("memory_version"))).toHaveLength(1);
    });

    it("serves every part of a write on one line, naming the first, and counts every part as shown", () => {
      const { text, factVersionIds, shownFactIds, lines } = render([...parts, older]);
      const [first, second] = items(text!);
      expect(first).toContain("[fact p1] (+2 parts) acme/storefront pull request #140");
      expect(excerptOf(first!)).toContain(defect);
      expect(second).toBe(
        "- [plan · proposed] Progress: step 3 done. [fact old] acme/storefront pull request #140 — unknown, 10-01",
      );
      expect(factVersionIds).toEqual(["p1", "p2", "p3", "old"]);
      expect(shownFactIds).toEqual(["p1", "p2", "p3", "old"]);
      expect(lines.map((keys) => keys.length)).toEqual([3, 1]);
      expect(render([...parts, older]).revision).toBe(
        revisionToken(["p1", "p2", "p3", "old"].map((id) => recordRevisionKey("fact", id, 1))),
      );
    });

    it("reads a write's parts line by line, so a part's last line never runs into the next one's passage", () => {
      const split = [
        fact("q1", "Reviewed at head abc1234"),
        fact("q2", "The cursor in app/api/invoices/route.ts is read after the limit."),
      ];
      const [line] = items(render(split).text!);
      expect(excerptOf(line!)).toBe("… The cursor in app/api/invoices/route.ts is read after the limit.");
    });

    it("leaves a write out whole when its line does not fit, counting it once", () => {
      // Room for the header, the leads' heading and the short write, not the long one. The premise
      // check takes none of it (recordRoom).
      const { text } = render(
        [...parts, older],
        NO_WEIGHTS,
        {},
        estimateTokens(TASK_START_HEADER) + estimateTokens(`\n${TASK_START_HEADINGS.leads}`) + 64,
      );
      expect(items(text!).map((line) => line.match(/\[fact (\w+)\]/)![1])).toEqual(["old"]);
      expect(text!.endsWith("\n(1 more left out: ask memory_query for them)")).toBe(true);
    });

    it("never splits a character when it cuts", () => {
      const { text } = render([fact("emoji", `first line\nsecond line ${"😀 ".repeat(1200)}`)], NO_WEIGHTS);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text!)).toBe(false);
      expect(estimateTokens(withoutSources(text!))).toBeLessThanOrEqual(TASK_START_TOKEN_BUDGET);
    });

    it("serves records stored at one instant under different names as separate writes", () => {
      const otherName = { ...fact("other", "Billing export: rows land in UTC."), entityName: "acme/billing export" };
      const { text } = render([fact("pr", "Review: the cursor skips a row."), otherName], NO_WEIGHTS);
      expect(items(text!)).toEqual([
        "- [plan · proposed] Review: the cursor skips a row. [fact pr] acme/storefront pull request #140 — unknown, 10-01",
        "- [plan · proposed] Billing export: rows land in UTC. [fact other] acme/billing export — unknown, 10-01",
      ]);
    });

    it("serves the facts in the order the read ranked them: the renderer reorders nothing", () => {
      const facts = [fact("b", "Second."), fact("a", "First.", "2026-10-01T11:00:00.000Z")];
      expect(items(render(facts, NO_WEIGHTS).text!).map((line) => line.match(/\[fact (\w+)\]/)![1])).toEqual([
        "b",
        "a",
      ]);
    });
  });
});

describe("working notes in the block", () => {
  const note = (id: string, task: string, ofTask: boolean) => ({
    id,
    agentId: "agent-b",
    scopePath: `org_a.eng.${id}`,
    task,
    kind: "claim" as const,
    body: `${task} body`,
    expiresAt: new Date("2026-10-14T12:00:00Z"),
    ofTask,
  });
  const decision = {
    id: "d1",
    kind: "decision" as const,
    subject: "Approach",
    text: "Retry with the ledger key.",
    ofTask: true as const,
  };

  it("serves the notes on this task first, live, and names the others on one line among what is related", () => {
    const { text, revision } = renderTaskStartBlock({
      decisions: [decision],
      facts: [],
      rules: [rule("r1")],
      writes: [],
      stale: [],
      notes: {
        served: [note("n1", "item-42", true), note("n2", "release window", false), note("n3", "docs", false)],
        total: 5,
      },
    });
    expect(text!.split("\n")).toEqual([
      TASK_START_HEADER,
      TASK_START_HEADINGS.live,
      `- [claim n1] agent-b on "item-42", live until 2026-10-14T12:00:00Z: item-42 body`,
      TASK_START_HEADINGS.leads,
      TASK_START_PREMISE_CHECK,
      "- [decision d1] [untested plan: verify before following] Approach: Retry with the ledger key. — unknown",
      TASK_START_HEADINGS.rules,
      "- [convention r1] Account dedupe: Dedupe accounts by email domain. — unknown",
      TASK_START_HEADINGS.related,
      'Also live in this scope, on other tasks: agent-b on "release window" [claim n2]; agent-b on "docs" [claim n3]; 2 more.',
    ]);
    expect(text).not.toContain("release window body");
    // The line names the two notes, so the revision covers them.
    const key = (id: string) => recordRevisionKey("note", id, "2026-10-14T12:00:00.000Z");
    expect(revision).toBe(
      revisionToken([
        key("n1"),
        recordRevisionKey("convention", "d1", 1),
        recordRevisionKey("convention", "r1", 1),
        recordRevisionKey("notes", "unnamed", 2),
        key("n2"),
        key("n3"),
      ]),
    );
  });

  it("never lets a note on another task take one of the first record lines", () => {
    const others = [note("n1", "a", false), note("n2", "b", false), note("n3", "c", false)];
    const { text } = renderTaskStartBlock({
      decisions: [decision],
      facts: [],
      rules: [],
      writes: [],
      stale: [],
      notes: { served: others, total: 3 },
    });
    expect(text!.split("\n").filter((line) => line.startsWith("- "))[0]).toBe(
      "- [decision d1] [untested plan: verify before following] Approach: Retry with the ledger key. — unknown",
    );
  });

  it("reports the scope of every note and source link it shows, and of none it leaves out", () => {
    const flag = {
      id: "p1",
      scopePath: "org_a.eng.links",
      graphitiFactUuid: "f1",
      sourceType: "pr",
      sourceRef: "#12",
      flaggedAt: new Date("2026-09-26T00:00:00Z"),
    };
    const notes = { served: [note("n1", "item-42", true), note("n2", "docs", false)], total: 2 };
    expect(renderTaskStartBlock({ rules: [], writes: [], stale: [flag], notes }).readScopes).toEqual([
      { scopePath: "org_a.eng.n1", writtenBy: "agent-b" },
      { scopePath: "org_a.eng.n2", writtenBy: "agent-b" },
      { scopePath: "org_a.eng.links" },
    ]);
    // A budget with room for the header and the first note only: the rest are left out, and so are their scopes.
    const tight = renderTaskStartBlock({ rules: [], writes: [], stale: [flag], notes }, 70);
    expect(tight.text).toContain("[claim n1]");
    expect(tight.text).not.toContain("#12");
    expect(tight.readScopes).toEqual([{ scopePath: "org_a.eng.n1", writtenBy: "agent-b" }]);
  });

  it("says how many more notes are live when every note it shows is on this task", () => {
    const { text } = renderTaskStartBlock({
      rules: [],
      writes: [],
      stale: [],
      notes: { served: [note("n1", "item-42", true)], total: 2 },
    });
    expect(text!.split("\n").at(-1)).toBe("Also live in this scope: 1 more working note.");
  });
});

describe("what the block is ranked by", () => {
  it("is the task's name and what the session is doing, each bounded and on its own line", () => {
    expect(rankingTextOf("T-3d34c5f1", "Fix the retry dedupe in services/outbound/replies.ts")).toBe(
      "T-3d34c5f1\nFix the retry dedupe in services/outbound/replies.ts",
    );
    expect(rankingTextOf(undefined, "  only the prompt\u0000 ")).toBe("only the prompt");
    expect(rankingTextOf("T-1", "")).toBe("T-1");
    expect(rankingTextOf("T-1", "x".repeat(2000))).toBe(`T-1\n${"x".repeat(512)}`);
  });

  it("reads a tool call's arguments beside the task it names", () => {
    const extra = { _meta: { "willder/task": "T-9" } };
    expect(taskTextOf({ query: "ledger retry", limit: 10 }, extra)).toBe("T-9\nledger retry");
    expect(taskTextOf({ query: "ledger retry" }, {})).toBe("ledger retry");
    expect(taskTextOf(null, extra)).toBe("T-9");
  });

  it("decodes the prompt header, and reads one that does not decode as no prompt", () => {
    expect(headerPromptOf(encodeURIComponent("Corrige le délai ✓"))).toBe("Corrige le délai ✓");
    expect(headerPromptOf("%E0%A4%A")).toBe("");
    expect(headerPromptOf(null)).toBe("");
  });
});

describe("client hints in _meta", () => {
  const meta = (values: Record<string, unknown>) => ({ _meta: values });

  it("drops control characters from a task key, NUL included, which Postgres text cannot store", () => {
    expect(taskKeyOf(meta({ "willder/task": "WEB-412\u0000" }))).toBe("WEB-412");
    expect(taskKeyOf(meta({ "willder/task": "WEB-412\u0000\u0007\u009bretry" }))).toBe("WEB-412 retry");
  });

  it("drops control characters from a session key", () => {
    expect(sessionKeyOf(meta({ "willder/session": "\u0000run-7\u007f" }))).toBe("run-7");
  });

  it("names no task when the key is only control characters and spaces", () => {
    expect(taskKeyOf(meta({ "willder/task": "\u0000 \u001f" }))).toBeUndefined();
  });

  it("keeps a key's own spaces and non-ASCII text", () => {
    expect(taskKeyOf(meta({ "willder/task": "  Rückerstattung WEB-412  " }))).toBe("Rückerstattung WEB-412");
  });

  it("names no task when the value is an unexpanded ${...} placeholder, from _meta or the header", () => {
    expect(taskKeyOf(meta({ "willder/task": "${WILLDER_TASK}" }))).toBeUndefined();
    expect(connectionTaskOf("${env:WILLDER_TASK}")).toBeUndefined();
    expect(connectionTaskOf("  ${WILLDER_TASK:-}  ")).toBeUndefined();
    expect(connectionTaskOf("${}")).toBeUndefined();
  });

  it("falls back to the header's task when the _meta task is a placeholder", () => {
    expect(taskKeyOf(meta({ "willder/task": "${WILLDER_TASK}" }), "WEB-412")).toBe("WEB-412");
  });

  it("keeps a task that only contains a placeholder among other text", () => {
    expect(connectionTaskOf("WEB-${N}")).toBe("WEB-${N}");
    expect(connectionTaskOf("${A} and ${B}")).toBe("${A} and ${B}");
  });
});
