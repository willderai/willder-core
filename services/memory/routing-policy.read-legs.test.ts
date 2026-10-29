// The hybrid read asks the legs `readLegs` names, so with the flags off those legs must be
// byte-identical to the stores it asked before reads were split into legs,
// `allowedOrder(tier, ["graph", "semantic"])`, for every tier and every query shape.
//
// Before that split the vector store's read ran the text leg inside itself, so a read of `semantic`
// was a read of both raw legs; that is how today's stores are written as legs below.
//
// Recorded mutant: `readLegs` returning `targetReadLegs` ungated (the starter legs in
// force with the flags off) fails the 4 starter rows of the flags-off table and the starter
// row of the flags-on table (5 failed); with the gate restored all pass.
import { describe, expect, it } from "vitest";
import { ACCOUNT_TIERS, type AccountTier, type RetrievalBackend } from "./account-tiers";
import {
  absorb,
  allowedOrder,
  CONTENT_SHAPES,
  QUERY_SHAPES,
  READ_LEGS,
  readLegs,
  readPolicyInForce,
  storesOfLegs,
  targetReadLegs,
  type ContentRow,
  type ReadLeg,
} from "./routing-policy";

// Today's order, by hand (hybrid-store.ts before the policy), so the policy is never
// compared with itself.
const TODAY_HYBRID_ORDER: RetrievalBackend[] = ["graph", "semantic"];
const TODAY_LEGS: Record<AccountTier, ReadLeg[]> = {
  starter: [],
  team: ["text", "semantic"],
  enterprise: ["text", "semantic", "graph"],
};

const FLAGS_OFF = {};
const FLAGS_ON = { WRITE_ROUTING_POLICY: "true" };

describe("readLegs with the flags off is today's routing, every tier × query shape", () => {
  for (const tier of ACCOUNT_TIERS) {
    for (const shape of QUERY_SHAPES) {
      it(`${tier} × ${shape}`, () => {
        const legs = readLegs(shape, tier, FLAGS_OFF);
        expect(legs).toEqual(TODAY_LEGS[tier]);
        expect(storesOfLegs(legs)).toEqual(allowedOrder(tier, TODAY_HYBRID_ORDER));
      });
    }
  }
});

describe("readLegs with the flag on, while every tier below enterprise is still inactive", () => {
  for (const tier of ACCOUNT_TIERS) {
    it(`${tier} reads today's legs, for every query shape`, () => {
      for (const shape of QUERY_SHAPES) {
        expect(readLegs(shape, tier, FLAGS_ON)).toEqual(TODAY_LEGS[tier]);
        expect(storesOfLegs(readLegs(shape, tier, FLAGS_ON))).toEqual(allowedOrder(tier, TODAY_HYBRID_ORDER));
      }
    });
  }

  it("the policy is in force for enterprise only, and only with the flag on", () => {
    expect(ACCOUNT_TIERS.filter((tier) => readPolicyInForce(tier, FLAGS_ON))).toEqual(["enterprise"]);
    expect(ACCOUNT_TIERS.filter((tier) => readPolicyInForce(tier, FLAGS_OFF))).toEqual([]);
  });

  it("enterprise's target legs are today's legs, so turning the flag on changes no enterprise read's legs", () => {
    for (const shape of QUERY_SHAPES) expect(targetReadLegs(shape, "enterprise")).toEqual(TODAY_LEGS.enterprise);
  });
});

describe("storesOfLegs", () => {
  it("names the stores in the read router's order; the text leg reads the chunk store", () => {
    expect(storesOfLegs(["text", "semantic", "graph"])).toEqual(["graph", "semantic"]);
    expect(storesOfLegs(["text"])).toEqual(["semantic"]);
    expect(storesOfLegs([])).toEqual([]);
  });
});

describe("one policy, read and write: a read asks the graph only where a write can absorb into it", () => {
  const rows: ContentRow[] = [
    { content: "the deploy freezes on Friday" },
    { content: "a decision", recordType: "decision" },
    { content: "x".repeat(7_000) },
    { content: "handoff", skipGraphExtraction: true },
  ];
  for (const env of [FLAGS_OFF, FLAGS_ON]) {
    for (const tier of ACCOUNT_TIERS) {
      it(`${tier}, flag ${env === FLAGS_ON ? "on" : "off"}`, () => {
        const absorbs = rows.some((row) => absorb(row, tier).graph !== "none");
        for (const shape of QUERY_SHAPES) {
          if (readLegs(shape, tier, env).includes("graph")) expect(absorbs).toBe(true);
        }
      });
    }
  }

  it("the target legs and the target absorb table agree for every tier", () => {
    for (const tier of ACCOUNT_TIERS) {
      expect(CONTENT_SHAPES.length).toBeGreaterThan(0);
      for (const shape of QUERY_SHAPES) expect(targetReadLegs(shape, tier)).toEqual([...READ_LEGS[tier]]);
    }
  });
});
