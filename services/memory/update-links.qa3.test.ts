// The mark now says only "a later record on this
// is shown above", so a link is wrong when the later record is about a different thing. Every
// case in the first block was linked before the fix: the later record names the same noun, but a
// phrase after its value puts it on another business, office, account, fiscal year or trip,
// and the reorder then serves that other thing's value as the answer's first line. Only words
// before the value are read as the thing's name. The second block holds later records the lab
// links today, each with a phrase after its value that does not change the thing; they must
// stay linked.
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

const MQ = "What is my marketing budget?";
const ML = "USER: My marketing budget is $8,000.";

describe("update link round 3: a phrase after the value that names another thing", () => {
  it.each([
    ["another business", MQ, ML, "USER: My marketing budget was increased to $10,000 for my side business."],
    ["another office", MQ, ML, "USER: My marketing budget was increased to $10,000 for the Austin office."],
    ["another account", MQ, ML, "USER: My marketing budget was increased to $10,000 for the Acme account."],
    ["another branch", MQ, ML, "USER: My marketing budget was increased to $10,000 in the Seattle branch."],
    ["another employer", MQ, ML, "USER: My marketing budget was increased to $10,000 at my previous startup."],
    ["someone else's business", MQ, ML, "USER: I increased my marketing budget to $10,000 for my sister's bakery."],
    [
      "another fiscal year",
      MQ,
      "USER: My marketing budget is $8,000 for FY26.",
      "USER: My marketing budget was increased to $10,000 for FY25.",
    ],
    [
      "one trip",
      "What is my food budget?",
      "USER: My food budget is $400 a week.",
      "USER: My food budget was increased to $600 for the Japan trip.",
    ],
  ])("%s", (_, query, lead, later) => {
    expect(served(query, lead, later)).toEqual(["lead", "later"]);
  });
});

describe("update link round 3: a phrase after the value that keeps the thing stays linked", () => {
  it.each([
    [
      "what the new budget is spent on (lab c13-KU-1's shape)",
      "What is my monthly book budget?",
      "USER: I'm $8 over my $35 monthly book budget.",
      "USER: I want to spend my increased monthly book budget of $50 on a new series.",
    ],
    [
      "how long it runs (lab c20-KU-1's shape)",
      "What is my prototype budget?",
      "USER: My prototype budget is $7,000.",
      "USER: My prototype budget was increased to $8,000 through August 2024.",
    ],
    [
      "when it starts and why (lab c16-KU-0's shape)",
      "What is my monthly grocery budget?",
      "USER: My monthly grocery budget is $500.",
      "USER: I've increased my monthly grocery budget to $550 starting Dec 1 due to holiday meals and guests.",
    ],
    [
      "what caused it (lab c1-KU-0's shape)",
      "What is my response time?",
      "USER: My response time is 800ms.",
      "USER: My response time has improved to 250ms after adding some caching tweaks.",
    ],
  ])("%s", (_, query, lead, later) => {
    expect(served(query, lead, later)).toEqual(["later", "lead"]);
  });
});
