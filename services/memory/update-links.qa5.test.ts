// The false-link
// rate on fresh paraphrases is under the 5% bar, so these are the after-value scope wordings left.
// Every case in the first block was linked before the fix. The first two are new at this head: the
// neutral list ("for everyone", "at my annual review") is tested as a prefix, so a real scope
// that follows it in the same clause is dropped with it. The rest are a preposition the scope
// list does not hold ("through", "via"), and short codes that fold to a stopword ("IT") or are
// written with a mark ("R&D"). The second block must stay as it is: a neutral phrase alone still
// links, and a name that merely contains a neutral word is still a scope.
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
const HQ = "What is my hourly rate?";
const HL = "USER: My hourly rate is $95.";

describe("update link round 5: a phrase after the value that names another thing, still linked", () => {
  it.each([
    [
      "a neutral word followed by another team",
      MQ,
      ML,
      "USER: My marketing budget was increased to $10,000 for everyone on the Denver team.",
    ],
    [
      "a review followed by another gig",
      MQ,
      ML,
      "USER: My marketing budget was increased to $10,000 at my annual review for the side gig.",
    ],
    ["through another agency", HQ, HL, "USER: I raised my hourly rate to $140 through the staffing agency."],
    ["via another program", MQ, ML, "USER: My marketing budget was bumped to $10,000 via the partner program."],
    [
      "a department code that folds to a stopword",
      MQ,
      ML,
      "USER: My marketing budget was increased to $10,000 for IT.",
    ],
    ["a department code written with a mark", MQ, ML, "USER: My marketing budget was increased to $10,000 for R&D."],
  ])("%s", (_, query, lead, later) => {
    expect(served(query, lead, later)).toEqual(["lead", "later"]);
  });
});

describe("update link round 5: the neutral list stays narrow", () => {
  it("a neutral phrase alone still links", () => {
    expect(
      served(
        "What is my monthly grocery budget?",
        "USER: My monthly grocery budget is $500.",
        "USER: My monthly grocery budget was increased to $550 for good.",
      ),
    ).toEqual(["later", "lead"]);
  });

  it("a name that contains a neutral word is still a scope", () => {
    expect(served(MQ, ML, "USER: My marketing budget was increased to $10,000 for the Good Samaritan clinic.")).toEqual(
      ["lead", "later"],
    );
  });
});
