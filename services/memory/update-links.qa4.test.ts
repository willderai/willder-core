// A phrase after the value is now read as part of
// the thing, but only when it opens with "for", "in" or "at", and only through words of three or
// more letters. Every case in the first block was linked before the fix: the later record names the
// same noun, and a phrase after its value puts it on another project, region, division, half-year,
// country, city or department, so the reorder serves that other thing's value as the answer's
// first line. The second block holds later records whose phrase after the value names the
// thing the question or the first line already names; they must stay linked.
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

describe("update link round 4: a phrase after the value that names another thing, worded another way", () => {
  it.each([
    ["on another project", MQ, ML, "USER: I increased my marketing budget to $10,000 on Sam's project."],
    [
      "on another side of the business",
      MQ,
      ML,
      "USER: My marketing budget was increased to $10,000 on the European side.",
    ],
    ["on a spinoff", MQ, ML, "USER: I increased my marketing budget to $10,000 on the podcast spinoff."],
    ["across a region", MQ, ML, "USER: My marketing budget was bumped to $10,000 across the APAC region."],
    ["within a division", MQ, ML, "USER: My marketing budget was raised to $10,000 within the hardware division."],
    [
      "another half-year",
      "What is my marketing budget for H1?",
      "USER: My marketing budget for H1 is $8,000.",
      "USER: My marketing budget was increased to $10,000 for H2.",
    ],
    ["another country, two letters", MQ, ML, "USER: My marketing budget was increased to $10,000 for the UK."],
    ["another city, two letters", MQ, ML, "USER: My marketing budget was increased to $10,000 in LA."],
    ["another department, two letters", MQ, ML, "USER: My marketing budget was increased to $10,000 for HR."],
  ])("%s", (_, query, lead, later) => {
    expect(served(query, lead, later)).toEqual(["lead", "later"]);
  });
});

describe("update link round 4: a phrase after the value that the question or first line names stays linked", () => {
  it.each([
    [
      "only the first line names the same office",
      MQ,
      "USER: My marketing budget is $8,000 for the Austin office.",
      "USER: My marketing budget was increased to $10,000 for the Austin office.",
    ],
    [
      "the question and first line name the same two-letter country",
      "What is my marketing budget for the UK?",
      "USER: My marketing budget is $8,000 for the UK.",
      "USER: My marketing budget was increased to $10,000 for the UK.",
    ],
  ])("%s", (_, query, lead, later) => {
    expect(served(query, lead, later)).toEqual(["later", "lead"]);
  });
});
