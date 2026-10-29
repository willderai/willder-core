// Tests for the shared routing policy (services/memory/routing-policy.ts). The policy changes
// no behaviour: the stores a read asks, for every tier and every query shape, are exactly
// today's, and the rest of the policy (the absorb plans, the read legs, the recorded routing
// decisions, the write-routing flag) is data no caller acts on yet.
import { describe, expect, it } from "vitest";
import * as accountTiers from "./account-tiers";
import { ACCOUNT_TIERS, type AccountTier, type RetrievalBackend } from "./account-tiers";
import {
  absorb,
  ALLOWED_STORES,
  allowedOrder,
  CONTENT_SHAPES,
  HYBRID_READ_ORDER,
  POLICY_VERSION,
  QUERY_SHAPES,
  READ_LEGS,
  readStores,
  targetReadLegs,
  ROUTING_DECISIONS,
  routingTierActive,
  shapeOfContent,
  shapeOfQuery,
  WRITE_ROUTING_POLICY_FLAG,
  writeRoutingPolicyEnabled,
  ABSORB_TABLE,
  type ContentRow,
} from "./routing-policy";

// Today's read routing, written out by hand from account-tiers.ts and hybrid-store.ts before
// the policy existed, so a change to the policy cannot also change what it is compared with.
const TODAY_ALLOWED_STORES: Record<AccountTier, RetrievalBackend[]> = {
  starter: ["source", "files"],
  team: ["source", "files", "semantic"],
  enterprise: ["source", "files", "semantic", "graph"],
};
const TODAY_HYBRID_ORDER: RetrievalBackend[] = ["graph", "semantic"];
// allowedOrder(tier, ["graph", "semantic"]) as hybrid-store.ts's retrieve computed it.
const TODAY_READ_STORES: Record<AccountTier, RetrievalBackend[]> = {
  starter: [],
  team: ["semantic"],
  enterprise: ["graph", "semantic"],
};

describe("the store table moved out of account-tiers.ts", () => {
  it("holds exactly today's stores per tier", () => {
    for (const tier of ACCOUNT_TIERS) expect([...ALLOWED_STORES[tier]]).toEqual(TODAY_ALLOWED_STORES[tier]);
  });

  it("is the one source: TIER_LIMITS.allowedStores is the policy's own array, and account-tiers re-exports the policy", () => {
    for (const tier of ACCOUNT_TIERS) expect(accountTiers.TIER_LIMITS[tier].allowedStores).toBe(ALLOWED_STORES[tier]);
    expect(accountTiers.ALLOWED_STORES).toBe(ALLOWED_STORES);
    expect(accountTiers.allowedOrder).toBe(allowedOrder);
  });

  it("keeps the read router's order", () => {
    expect([...HYBRID_READ_ORDER]).toEqual(TODAY_HYBRID_ORDER);
  });
});

describe("read routing with the flags off is today's, for every tier and query shape", () => {
  const queries: Record<(typeof QUERY_SHAPES)[number], string> = {
    entity: "Acme Corp",
    relation: "how is Acme related to the billing service",
    general: "pricing",
    quote: "the deploy freezes every Friday at noon",
  };

  it("names every query shape it routes", () => {
    expect([...QUERY_SHAPES].sort()).toEqual(["entity", "general", "quote", "relation"]);
  });

  for (const tier of ACCOUNT_TIERS) {
    for (const shape of QUERY_SHAPES) {
      it(`${tier} × ${shape} reads ${JSON.stringify(TODAY_READ_STORES[tier])}`, () => {
        expect(shapeOfQuery({ query: queries[shape], entry: shape === "entity" ? "entity" : "retrieve" })).toBe(shape);
        expect(readStores(tier, shape)).toEqual(TODAY_READ_STORES[tier]);
        // The same answer the read router computes today from the tier and its order.
        expect(readStores(tier, shape)).toEqual(allowedOrder(tier, TODAY_HYBRID_ORDER));
      });
    }
  }

  it("allowedOrder filters a preference order exactly as before", () => {
    expect(allowedOrder("enterprise", ["graph", "semantic"])).toEqual(["graph", "semantic"]);
    expect(allowedOrder("team", ["graph", "semantic"])).toEqual(["semantic"]);
    expect(allowedOrder("team", ["files", "source", "graph", "semantic"])).toEqual(["files", "source", "semantic"]);
    expect(allowedOrder("starter", ["graph", "semantic"])).toEqual([]);
  });
});

describe("shapeOfQuery", () => {
  it("an entity lookup or graph tab is entity, whatever its text", () => {
    expect(shapeOfQuery({ query: "the deploy freezes every Friday at noon", entry: "entity" })).toBe("entity");
    expect(shapeOfQuery({ query: "x", entry: "graph" })).toBe("entity");
  });
  it("a long run of words is a quote; a keyword is general", () => {
    expect(shapeOfQuery({ query: "the deploy freezes every Friday at noon" })).toBe("quote");
    expect(shapeOfQuery({ query: "pricing" })).toBe("general");
  });
  it("a question about how things connect is relation", () => {
    expect(shapeOfQuery({ query: "what depends on auth" })).toBe("relation");
    expect(shapeOfQuery({ query: "link between Acme and Globex" })).toBe("relation");
  });
});

describe("shapeOfContent", () => {
  const base: ContentRow = { content: "Acme renews in March." };
  it("classifies each kind of write", () => {
    expect(shapeOfContent(base)).toBe("fact");
    expect(shapeOfContent({ ...base, conversation: true })).toBe("conversation");
    expect(shapeOfContent({ ...base, recordType: "document" })).toBe("document");
    expect(shapeOfContent({ ...base, uploadId: "u1" })).toBe("document");
    expect(shapeOfContent({ content: "x".repeat(6_001) })).toBe("document");
    expect(shapeOfContent({ content: "x".repeat(6_000) })).toBe("fact");
    expect(shapeOfContent({ ...base, recordType: "decision" })).toBe("seed");
    expect(shapeOfContent({ ...base, skipGraphExtraction: true })).toBe("handoff");
    expect(shapeOfContent({ ...base, sessionStateCapture: true, recordType: "document" })).toBe("handoff");
  });
  it("names every content shape", () => {
    expect([...CONTENT_SHAPES].sort()).toEqual(["conversation", "document", "fact", "handoff", "seed"]);
  });
});

describe("absorb: inert data that reproduces today's write path", () => {
  it("enterprise keeps full extraction everywhere it is full today; a handoff stays graph-free", () => {
    expect(ABSORB_TABLE.enterprise).toEqual({
      fact: "full",
      conversation: "full",
      document: "full",
      seed: "full",
      handoff: "none",
    });
  });
  it("the target table absorbs nothing into the graph below enterprise", () => {
    for (const tier of ["starter", "team"] as const) {
      for (const shape of CONTENT_SHAPES) expect(ABSORB_TABLE[tier][shape]).toBe("none");
    }
  });
  it("no tier below enterprise is active yet, so every tier's absorb is today's enterprise plan", () => {
    expect(ROUTING_DECISIONS.D6.activeTiers).toEqual(["enterprise"]);
    for (const tier of ACCOUNT_TIERS) expect(routingTierActive(tier)).toBe(tier === "enterprise");
    for (const tier of ACCOUNT_TIERS) {
      expect(absorb({ content: "a fact" }, tier)).toEqual({
        graph: "full",
        version: POLICY_VERSION,
        shape: "fact",
        tier: "enterprise",
      });
      expect(absorb({ content: "where I stopped", skipGraphExtraction: true }, tier).graph).toBe("none");
    }
  });
  it("carries a policy version", () => {
    expect(POLICY_VERSION).toBe(1);
  });
});

describe("the target read legs (in force where the policy is)", () => {
  it("starter reads the text leg; team adds semantic; enterprise adds graph", () => {
    expect(ROUTING_DECISIONS.D1.starterLegs).toEqual(["text"]);
    expect([...READ_LEGS.starter]).toEqual(["text"]);
    expect([...READ_LEGS.team]).toEqual(["text", "semantic"]);
    expect([...READ_LEGS.enterprise]).toEqual(["text", "semantic", "graph"]);
    for (const tier of ACCOUNT_TIERS) {
      for (const shape of QUERY_SHAPES) expect(targetReadLegs(shape, tier)).toEqual([...READ_LEGS[tier]]);
    }
  });
  it("asks the graph exactly where the target absorb table can put something there", () => {
    for (const tier of ACCOUNT_TIERS) {
      const absorbs = CONTENT_SHAPES.some((shape) => ABSORB_TABLE[tier][shape] !== "none");
      expect(READ_LEGS[tier].includes("graph")).toBe(absorbs);
    }
  });
  it("never drops a raw leg: every tier reads text", () => {
    for (const tier of ACCOUNT_TIERS) expect(READ_LEGS[tier]).toContain("text");
  });
});

describe("the routing decisions are recorded as data", () => {
  it("holds the agreed values for documents, downgrades, replay, human writes and the tier source", () => {
    expect(ROUTING_DECISIONS.D2.enterpriseDocumentPlan).toBe("full");
    expect(ROUTING_DECISIONS.D3.downgrade).toBe("hide");
    expect(ROUTING_DECISIONS.D4).toMatchObject({ capMultiplier: 1.5, lazyFill: false });
    expect(ROUTING_DECISIONS.D5.humanWrites).toBe("as-today");
    expect(ROUTING_DECISIONS.D6.tierSource).toBe("Org.plan");
  });
});

describe("the write-routing flag", () => {
  it("is off unless set to a true value", () => {
    expect(WRITE_ROUTING_POLICY_FLAG).toBe("WRITE_ROUTING_POLICY");
    expect(writeRoutingPolicyEnabled({})).toBe(false);
    expect(writeRoutingPolicyEnabled({ WRITE_ROUTING_POLICY: "" })).toBe(false);
    expect(writeRoutingPolicyEnabled({ WRITE_ROUTING_POLICY: "0" })).toBe(false);
    expect(writeRoutingPolicyEnabled({ WRITE_ROUTING_POLICY: "false" })).toBe(false);
    expect(writeRoutingPolicyEnabled({ WRITE_ROUTING_POLICY: "1" })).toBe(true);
    expect(writeRoutingPolicyEnabled({ WRITE_ROUTING_POLICY: "TRUE" })).toBe(true);
  });
});
