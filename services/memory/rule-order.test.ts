// The order the task-start block serves a scope's rules in (services/memory/rule-order.ts).
import { describe, expect, it } from "vitest";
import { NO_WEIGHTS, termCountsOf, weighTaskTerms } from "./relevance";
import { NEWEST_RULES_FIRST, citedNames, orderRules } from "./rule-order";

interface Rule {
  id: string;
  subject: string;
  text: string;
}

const rule = (id: string, subject: string, text = "Ship small pull requests with tests.") => ({ id, subject, text });
/** `rules` as ranked candidates, in the order given, which is newest first. */
const candidates = (rules: Rule[]) =>
  rules.map((item) => ({ item, terms: termCountsOf(`${item.subject} ${item.text}`) }));
const weightsFor = (task: string, rules: Rule[]) =>
  weighTaskTerms(
    task,
    candidates(rules).map(({ terms }) => terms),
  );
const idsOf = (rules: Rule[]) => rules.map(({ id }) => id);

/** `count` rules no task names, newest first: n0 is the newest. */
const unrelated = (count: number) =>
  Array.from({ length: count }, (_, i) => rule(`n${i}`, `Office note ${i}`, `Bring a charger on day ${i}.`));

describe("citedNames", () => {
  it("collects the names a text writes: tokens holding a digit or a joiner, lowercased", () => {
    expect([...citedNames(["Per Decision-Merge-Gate-20260921, fix app/api/route.ts in v2 today"])].sort()).toEqual(
      ["app/api/route.ts", "decision-merge-gate-20260921", "v2"].sort(),
    );
  });

  it("collects no plain words, so a word in a task never cites a rule named by it", () => {
    expect(citedNames(["Fix the naming of the billing page"]).size).toBe(0);
  });

  it("reads every text it is given", () => {
    expect(citedNames(["one rule-a", "another rule-b"])).toEqual(new Set(["rule-a", "rule-b"]));
  });
});

describe("orderRules", () => {
  it("serves first a rule the task cites by its subject, though it is the oldest and shares no word with the task", () => {
    const rules = [...unrelated(12), rule("old", "decision-merge-gate-20260921", "Merge after review.")];
    const task = "Tidy the settings page, per decision-merge-gate-20260921";
    const ordered = orderRules(candidates(rules), weightsFor(task, rules), citedNames([task]));
    expect(ordered[0]!.id).toBe("old");
  });

  it("serves first a rule the task cites by its id", () => {
    const rules = [...unrelated(12), rule("cmrule0042", "Merge policy")];
    const task = "Follow rule cmrule0042 when merging";
    expect(orderRules(candidates(rules), weightsFor(task, rules), citedNames([task]))[0]!.id).toBe("cmrule0042");
  });

  it("does not count a subject written as plain words as cited, though the task holds those words", () => {
    const rules = [...unrelated(NEWEST_RULES_FIRST + 2), rule("plain", "billing")];
    const task = "Fix billing";
    const ordered = idsOf(orderRules(candidates(rules), NO_WEIGHTS, citedNames([task])));
    expect(ordered.indexOf("plain")).toBe(rules.length - 1);
  });

  it("does not count a subject that only holds a name as cited by that name", () => {
    const rules = [...unrelated(NEWEST_RULES_FIRST + 2), rule("holds", "Pricing v2")];
    const ordered = idsOf(orderRules(candidates(rules), NO_WEIGHTS, citedNames(["Ship v2 of the importer"])));
    expect(ordered.indexOf("holds")).toBe(rules.length - 1);
  });

  it("serves cited rules newest first among themselves", () => {
    const rules = [rule("c-new", "rule-a"), ...unrelated(8), rule("c-old", "rule-b")];
    const ordered = idsOf(orderRules(candidates(rules), NO_WEIGHTS, citedNames(["rule-b and rule-a"])));
    expect(ordered.slice(0, 2)).toEqual(["c-new", "c-old"]);
  });

  it("serves the newest rules next, newest first, ahead of an older rule that shares more of the task's words", () => {
    const relevant = rule("relevant", "Invoices pagination", "The invoices pagination cursor must be stable.");
    const rules = [...unrelated(NEWEST_RULES_FIRST), relevant, ...unrelated(20).map((r) => ({ ...r, id: `o${r.id}` }))];
    const task = "Fix the invoices pagination cursor";
    const ordered = idsOf(orderRules(candidates(rules), weightsFor(task, rules), citedNames([task])));
    expect(NEWEST_RULES_FIRST).toBeGreaterThan(0);
    expect(ordered[0]).toBe("n0");
    expect(ordered.slice(0, NEWEST_RULES_FIRST)).toEqual(idsOf(unrelated(NEWEST_RULES_FIRST)));
    expect(ordered[NEWEST_RULES_FIRST]).toBe("relevant");
  });

  it("keeps the newest rules newest first, though an older one among them shares more of the task's words", () => {
    const newest = [
      ...unrelated(NEWEST_RULES_FIRST - 1),
      rule("relevant", "Invoices pagination", "The invoices pagination cursor must be stable."),
    ];
    const rules = [...newest, ...unrelated(5).map((r) => ({ ...r, id: `o${r.id}` }))];
    const task = "Fix the invoices pagination cursor";
    const ordered = idsOf(orderRules(candidates(rules), weightsFor(task, rules), citedNames([task])));
    expect(ordered.slice(0, NEWEST_RULES_FIRST)).toEqual(idsOf(newest));
  });

  it("serves the rest by relevance to the task, newest first among equals", () => {
    const older = [
      rule("o1", "Lunch", "Lunch is at noon."),
      rule("o2", "Invoices", "Invoices close on the 5th."),
      rule("o3", "Desks", "Clear desks on Friday."),
    ];
    const rules = [...unrelated(NEWEST_RULES_FIRST), ...older];
    const task = "Reconcile invoices";
    const ordered = idsOf(orderRules(candidates(rules), weightsFor(task, rules), citedNames([task])));
    expect(ordered.slice(NEWEST_RULES_FIRST)).toEqual(["o2", "o1", "o3"]);
  });

  it("serves every rule newest first when the task names nothing and cites nothing", () => {
    const rules = unrelated(15);
    expect(idsOf(orderRules(candidates(rules), NO_WEIGHTS, new Set()))).toEqual(idsOf(rules));
  });

  it("serves each rule once, cited or not", () => {
    const rules = [rule("c", "rule-a"), ...unrelated(10)];
    const ordered = idsOf(orderRules(candidates(rules), NO_WEIGHTS, citedNames(["rule-a"])));
    expect(ordered).toHaveLength(rules.length);
    expect(new Set(ordered).size).toBe(rules.length);
  });
});
