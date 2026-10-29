// A true current value must not get a later line
// served above it, marked "a later record on this is shown above" (an earlier version of the mark read
// "updated by a later record above"), when that line does not change it. Every case
// below was linked before the fix. The first group are wordings the PR body says are not read
// (asked, temporary, dated to another time, a different period); the rest are structural:
// a change undone in the same line, progress toward a goal or limit read as a new goal, a
// broader or another owner's thing, and a value scoped by words after it.
import { describe, expect, it } from "vitest";
import { serveLaterUpdatesFirst } from "./update-links";
import type { MemoryFact } from "@/types/memory";

const rank = () => 1;
const EARLY = "2026-03-01T10:00:00.000Z";
const LATER = "2026-03-08T10:00:00.000Z";
const record = (uuid: string, fact: string, validAt: string): MemoryFact => ({
  uuid,
  fact,
  validAt,
  actorType: "agent",
  store: "semantic",
  scopePath: "org_1.home",
});

/** The page memory_query would serve after the update link ran on [lead, later]. */
function served(query: string, lead: string, later: string): string[] {
  return serveLaterUpdatesFirst([record("lead", lead, EARLY), record("later", later, LATER)], query, rank).map(
    (f) => f.uuid,
  );
}

const Q = "What is my monthly grocery budget?";
const LEAD = "USER: My monthly grocery budget is $500.";

describe("update link round 2: wordings the PR says are not read", () => {
  it.each([
    ["asked without '?'", "USER: Do you remember when my monthly grocery budget was raised to $550"],
    ["temporary, 'for a month'", "USER: I raised my monthly grocery budget to $550 for a month."],
    [
      "another time, 'when I was in college'",
      "USER: My monthly grocery budget was raised to $550 when I was in college.",
    ],
    ["another time, 'back when'", "USER: My monthly grocery budget was raised to $550 back when I lived alone."],
    ["another time, 'during the pandemic'", "USER: My monthly grocery budget was raised to $550 during the pandemic."],
    [
      "a scenario, not a change",
      "USER: Two scenarios to compare.\nScenario A. My monthly grocery budget was raised to $550.\nScenario B. It stays at $500.",
    ],
  ])("%s", (_, later) => {
    expect(served(Q, LEAD, later)).toEqual(["lead", "later"]);
  });

  it("a yearly total does not update a monthly value", () => {
    expect(
      served(
        "What is my grocery budget?",
        "USER: My grocery budget is $1,000 a month.",
        "USER: I increased my grocery budget to $12,000 for the year.",
      ),
    ).toEqual(["lead", "later"]);
  });
});

describe("update link round 2: a change undone in the same line", () => {
  it.each([
    [
      "cut back to the first line's value",
      "USER: My monthly grocery budget was increased to $550, then cut back to $500.",
    ],
    [
      "went back to the first line's value",
      "USER: I raised my monthly grocery budget to $550 for a month but went back to $500.",
    ],
  ])("%s", (_, later) => {
    expect(served(Q, LEAD, later)).toEqual(["lead", "later"]);
  });
});

describe("update link round 2: progress toward a goal or limit is not a new goal", () => {
  it.each([
    [
      "savings reached",
      "What is my savings goal?",
      "USER: My savings goal is $15,000.",
      "USER: My savings reached $10,000.",
    ],
    [
      "steps reached",
      "What is my step goal?",
      "USER: My step goal is 10,000 steps.",
      "USER: My steps reached 12,000 steps.",
    ],
    [
      "essay reached",
      "What is my essay word limit?",
      "USER: My essay word limit is 5,000 words.",
      "USER: My essay reached 4,800 words.",
    ],
  ])("%s", (_, query, lead, later) => {
    expect(served(query, lead, later)).toEqual(["lead", "later"]);
  });
});

describe("update link round 2: another thing, another owner, another period", () => {
  it.each([
    [
      "a broader budget",
      "What is my monthly budget for groceries?",
      "USER: My grocery budget is $500 a month.",
      "USER: I increased my monthly budget to $3,000.",
    ],
    [
      "the central bank's rate",
      "What is my mortgage interest rate?",
      "USER: I locked in a mortgage at a rate of 6.5%.",
      "USER: The Fed raised the rate to 5.5% yesterday.",
    ],
    [
      "another quarter, after the value",
      "What is my Q4 marketing budget?",
      "USER: My Q4 marketing budget is $8,000.",
      "USER: I increased my marketing budget to $10,000 for Q3.",
    ],
    [
      "another year, after the value",
      "What is my marketing budget?",
      "USER: My marketing budget is $8,000 for 2026.",
      "USER: I increased my marketing budget to $10,000 for 2025.",
    ],
    [
      "another report's deadline",
      "When is my report deadline?",
      "USER: My report deadline is March 15.",
      "USER: The deadline for the March 22 report was moved to April 1.",
    ],
  ])("%s", (_, query, lead, later) => {
    expect(served(query, lead, later)).toEqual(["lead", "later"]);
  });
});
