// Unit tests for the tier table and its two pure helpers: resolving a tier from
// an org's settings (absent means the default, unknown throws) and packing facts
// within a token budget without letting a lower-ranked fact jump a higher one.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { org: { findUnique: vi.fn() } },
}));

import { db } from "@/lib/db";
import {
  accountTierFromSettings,
  allowedOrder,
  estimateTokens,
  loadAccountTier,
  MIN_EXCERPT_TOKENS,
  packWithinTokenBudget,
  TIER_LIMITS,
} from "./account-tiers";
import type { MemoryFact } from "@/types/memory";

function fact(uuid: string, chars: number): MemoryFact {
  return { uuid, fact: "x".repeat(chars), validAt: null };
}

describe("TIER_LIMITS presets", () => {
  it("match the brief's store table: Starter typed records and full-text, Team adds vector, Enterprise adds graph", () => {
    expect(TIER_LIMITS.starter.allowedStores).toEqual(["source", "files"]);
    expect(TIER_LIMITS.team.allowedStores).toEqual(["source", "files", "semantic"]);
    expect(TIER_LIMITS.enterprise.allowedStores).toEqual(["source", "files", "semantic", "graph"]);
  });

  it("loosen strictly from Starter to Team to Enterprise", () => {
    const { starter, team, enterprise } = TIER_LIMITS;
    expect(starter.tokenBudget).toBeLessThan(team.tokenBudget);
    expect(team.tokenBudget).toBeLessThan(enterprise.tokenBudget);
    expect(starter.latencyCeilingMs).toBeLessThan(team.latencyCeilingMs);
    expect(team.latencyCeilingMs).toBeLessThan(enterprise.latencyCeilingMs);
  });
});

describe("accountTierFromSettings", () => {
  it("defaults to enterprise when no tier is recorded, so existing orgs keep every store", () => {
    expect(accountTierFromSettings({})).toBe("enterprise");
    expect(accountTierFromSettings({ accountTier: null })).toBe("enterprise");
    expect(accountTierFromSettings(null)).toBe("enterprise");
  });

  it("returns a recorded tier", () => {
    expect(accountTierFromSettings({ accountTier: "starter" })).toBe("starter");
    expect(accountTierFromSettings({ accountTier: "team" })).toBe("team");
  });

  it("throws on a value that is not a tier instead of guessing limits", () => {
    expect(() => accountTierFromSettings({ accountTier: "platinum" })).toThrow(/Unknown account tier "platinum"/);
    expect(() => accountTierFromSettings({ accountTier: 3 })).toThrow(/Unknown account tier 3/);
  });
});

describe("loadAccountTier", () => {
  it("reads the tier from the org's settings", async () => {
    vi.mocked(db.org.findUnique).mockResolvedValueOnce({ settings: { accountTier: "team" } } as never);

    await expect(loadAccountTier("org_a")).resolves.toBe("team");
    expect(db.org.findUnique).toHaveBeenCalledWith({ where: { id: "org_a" }, select: { settings: true } });
  });

  it("throws for an org that does not exist rather than defaulting its limits", async () => {
    vi.mocked(db.org.findUnique).mockResolvedValueOnce(null);

    await expect(loadAccountTier("org_missing")).rejects.toThrow("Org org_missing not found");
  });
});

describe("allowedOrder", () => {
  it("keeps the router's order and drops stores the tier does not allow", () => {
    expect(allowedOrder("enterprise", ["graph", "semantic"])).toEqual(["graph", "semantic"]);
    expect(allowedOrder("team", ["graph", "semantic"])).toEqual(["semantic"]);
    expect(allowedOrder("team", ["files", "source", "graph", "semantic"])).toEqual(["files", "source", "semantic"]);
    expect(allowedOrder("starter", ["graph", "semantic"])).toEqual([]);
  });
});

describe("packWithinTokenBudget", () => {
  it("estimates four characters per token, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("keeps facts in rank order while they fit, and stops at the first that does not", () => {
    // 40 + 40 = 80 tokens fit a budget of 100; the third (40) would make 120, and the
    // 20 tokens left are under MIN_EXCERPT_TOKENS, so it is not excerpted either.
    const facts = [fact("a", 160), fact("b", 160), fact("c", 160), fact("d", 4)];

    const packed = packWithinTokenBudget(facts, 100, "");

    // "d" would fit on its own, but taking it would let a lower-ranked fact
    // through while a higher-ranked one was dropped.
    expect(packed.map((f) => f.uuid)).toEqual(["a", "b"]);
  });

  it("keeps a fact that lands exactly on the budget", () => {
    expect(packWithinTokenBudget([fact("a", 400)], 100, "").map((f) => f.uuid)).toEqual(["a"]);
  });

  // A review whose deciding sentence sits far past its opening, as in real agent traces.
  const review = [
    "Thanks for the PR.",
    ...Array.from({ length: 60 }, (_, i) => `Formatting note ${i} on the style of this module.`),
    "The real defect is that revoked tokens still pass the cache check.",
    "Please fix that before merge.",
  ].join(" ");

  it("serves the next fact that does not fit as an excerpt of its query-matching sentences, then stops", () => {
    const facts = [fact("a", 160), { uuid: "review", fact: review, validAt: null }, fact("c", 4)];

    const packed = packWithinTokenBudget(facts, 140, "why do revoked tokens pass the cache");

    expect(packed.map((f) => f.uuid)).toEqual(["a", "review"]);
    expect(packed[1].fact).toContain("The real defect is that revoked tokens still pass the cache check.");
    expect(packed[1].fact).not.toContain("Thanks for the PR.");
    expect(packed[1].excerptOfChars).toBe(review.length);
    expect(estimateTokens(packed[0].fact) + estimateTokens(packed[1].fact)).toBeLessThanOrEqual(140);
  });

  it("excerpts a top-ranked fact longer than the whole budget instead of serving an empty page", () => {
    const packed = packWithinTokenBudget([{ uuid: "long", fact: review, validAt: null }], 60, "revoked tokens cache");

    expect(packed).toHaveLength(1);
    expect(packed[0].fact).toContain("revoked tokens still pass the cache check");
  });

  it("ends the page without an excerpt when less than MIN_EXCERPT_TOKENS remain", () => {
    const facts = [fact("a", (100 - MIN_EXCERPT_TOKENS + 1) * 4), { uuid: "review", fact: review, validAt: null }];

    expect(packWithinTokenBudget(facts, 100, "revoked tokens").map((f) => f.uuid)).toEqual(["a"]);
  });

  it("leaves facts that fit untouched, with no excerpt mark", () => {
    const packed = packWithinTokenBudget([fact("a", 40)], 100, "anything");

    expect(packed[0]).toEqual(fact("a", 40));
  });
});
