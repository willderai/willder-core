// Guards for two recall rules the module's own tests do
// not pin. Each case turns red under one mutant of the rule it guards.
// - An "and" after a scope phrase that named something lists more of it, unless a contraction
//   that opens a new statement follows ("… for marketing and that's great"). Removing that stop
//   reads "great" as a scope term and drops a real update.
// - "Everybody" is a neutral after-value phrase, as "everyone" is. Removing it from the neutral
//   list drops "… for everybody" as another thing.
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

describe("update link round 6: real updates that must still link", () => {
  it.each([
    [
      "a contraction after 'and' opens a new statement, not a list",
      "USER: My marketing budget was raised to $10,000 for marketing and that's great.",
    ],
    [
      "'it's' after 'and' opens a new statement too",
      "USER: My marketing budget was raised to $10,000 for marketing and it's about time.",
    ],
    [
      "'for everybody' is neutral, as 'for everyone' is",
      "USER: My marketing budget was raised to $10,000 for everybody.",
    ],
  ])("%s", (_label, later) => {
    expect(served(MQ, ML, later)[0]).toBe("later");
  });
});
