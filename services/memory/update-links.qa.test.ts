// A true current value must not get a later line served above it,
// with the mark "a later record on this is shown above" (an earlier version of the mark read "updated by a
// later record above"), when that line states no change of it. Each case below linked before the fix.
// The first group are the classes the PR and mcp/README.md say are excluded (denied, asked
// about, offered); the second are hypotheticals and reports; the third are false links taken
// from a lab run, trimmed to the sentences that link.
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

describe("update link: no link where the PR says there is none", () => {
  it.each([
    ["denied, with an adverb between", "USER: The monthly grocery budget wasn't actually ever increased to $550."],
    ["denied, 'no longer'", "USER: The monthly grocery budget is no longer going to be increased to $550."],
    ["asked, a question with no question-word opener", "USER: So the monthly grocery budget was increased to $550?"],
    ["asked, a tag question", "USER: The monthly grocery budget was increased to $550, right?"],
    [
      "offered by the assistant",
      "ASSISTANT: You could consider having the monthly grocery budget increased to $550 if prices rise.",
    ],
    ["proposed", "USER: I'd like to propose that the monthly grocery budget be raised to $550."],
  ])("%s", (_, later) => {
    expect(served(Q, LEAD, later)).toEqual(["lead", "later"]);
  });
});

describe("update link: no link for a change that did not happen", () => {
  it.each([
    ["a condition", "USER: If my monthly grocery budget were increased to $550, I'd buy organic."],
    ["a possibility", "USER: The monthly grocery budget might be increased to $550 next year."],
    ["a refused request", "USER: Alexis asked for the monthly grocery budget to be increased to $550; I refused."],
    ["a wish that failed", "USER: I wanted the monthly grocery budget increased to $550 but it didn't happen."],
  ])("%s", (_, later) => {
    expect(served(Q, LEAD, later)).toEqual(["lead", "later"]);
  });
});

describe("update link: false links from the PR's own lab run", () => {
  it("beam-c8-KU-1: 'it's now July 20' is today's date, not a new start date for remote work", () => {
    expect(
      served(
        "How many days a week am I scheduled to work remotely?",
        "USER: I'm starting remote work three days a week beginning June 15, how can I ensure a smooth transition and maintain productivity in this new setup?",
        "USER: I've just completed my first 30 days as senior producer and I'm thinking about my next steps, I started on June 15 and it's now July 20, 2024, can you give me some advice on how to keep improving my team's performance and communication, given that Greg and I reviewed my progress and I've been working on project planning?",
      ),
    ).toEqual(["lead", "later"]);
  });

  it("beam-c19-KU-1: a raised exemption threshold does not update the estate tax rate", () => {
    expect(
      served(
        "What is the estimated estate tax rate applied to assets above $200,000?",
        "ASSISTANT: The estate tax rate of 12% applies to the portion of your estate that exceeds $200,000.",
        "ASSISTANT: I, Crystal [Last Name], hereby acknowledge that the lifetime gift and estate tax exemption in Montserrat has increased to $13.57 million effective January 2025.",
      ),
    ).toEqual(["lead", "later"]);
  });
});
