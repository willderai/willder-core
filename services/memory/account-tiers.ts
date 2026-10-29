// Account tiers: the hard limits a retrieval runs under, per paid tier.
//
// A tier is a set of limits, not a blended score: "the best answer within this token
// budget and this latency ceiling, using only these stores." Presets are fixed per
// tier rather than learned per customer: with more than two or three objectives, a
// weighted sum misses Pareto points and online learning converges slowly.
//
// The one rule this file enforces: a tier only ever NARROWS a read. It chooses which
// already-authorized stores are asked and how much of their already-authorized answer
// is kept. Access is decided before any of this runs (GuardedMemoryStore's check())
// and is identical on every tier; nothing here can add a store, a scope or a fact.

import { db } from "@/lib/db";
import type { AccountTier, MemoryFact, RetrievalBackend } from "@/types/memory";
import { excerptForQuery } from "./query-excerpt";
import { ALLOWED_STORES } from "./routing-policy";

export type { AccountTier, RetrievalBackend };
// The store table and the order filter live in the routing policy, the one source the
// read router and the write router share (services/memory/routing-policy.ts).
export { ALLOWED_STORES, allowedOrder } from "./routing-policy";
export const ACCOUNT_TIERS: readonly AccountTier[] = ["starter", "team", "enterprise"];

export interface TierLimits {
  /** Most tokens of retrieved evidence one answer may carry (estimated, see {@link estimateTokens}). */
  tokenBudget: number;
  /**
   * How long one store call may take, its one retry included. A call that has not
   * answered by then is dropped from the result (not aborted); see the note on
   * {@link TIER_LIMITS}.
   */
  latencyCeilingMs: number;
  /** Stores this tier may query, from {@link ALLOWED_STORES}. Anything else is never called. */
  allowedStores: readonly RetrievalBackend[];
}

/**
 * Provisional presets, to be tuned by measuring per-tier cost per correct answer
 * and p50/p95 latency.
 *
 * The latency ceiling applies to each store call, not to a whole read. The hybrid
 * store races each of its store calls against the ceiling on its own clock and
 * drops one that misses it; a call that fails before the ceiling may be asked once
 * more, inside the same ceiling. A guarded read makes up to three rounds of those
 * calls one after another (its scope, the bare org, then every descendant scope in
 * one call), so a whole read takes up to about three ceilings, plus its database
 * lookups.
 */
export const TIER_LIMITS: Readonly<Record<AccountTier, TierLimits>> = {
  starter: { tokenBudget: 2_000, latencyCeilingMs: 1_500, allowedStores: ALLOWED_STORES.starter },
  team: { tokenBudget: 6_000, latencyCeilingMs: 4_000, allowedStores: ALLOWED_STORES.team },
  enterprise: { tokenBudget: 16_000, latencyCeilingMs: 10_000, allowedStores: ALLOWED_STORES.enterprise },
};

/** The widest limits and every store. An org with no tier recorded must not be
 *  narrowed by the tier system, so the default is the least restrictive tier. */
export const DEFAULT_ACCOUNT_TIER: AccountTier = "enterprise";

function isAccountTier(value: unknown): value is AccountTier {
  return typeof value === "string" && (ACCOUNT_TIERS as readonly string[]).includes(value);
}

/**
 * Reads the tier from an org's `settings` JSON (`settings.accountTier`). Absent
 * means {@link DEFAULT_ACCOUNT_TIER}. A value that is present but not a known tier
 * throws: guessing would silently give an account the wrong limits.
 */
export function accountTierFromSettings(settings: unknown): AccountTier {
  const raw =
    settings !== null && typeof settings === "object" ? (settings as Record<string, unknown>).accountTier : undefined;
  if (raw === undefined || raw === null) return DEFAULT_ACCOUNT_TIER;
  if (!isAccountTier(raw)) {
    throw new Error(
      `Unknown account tier ${JSON.stringify(raw)} in org settings; expected one of ${ACCOUNT_TIERS.join(", ")}.`,
    );
  }
  return raw;
}

/** Loads an org's tier from the database. An org that does not exist is an error, not a default. */
export async function loadAccountTier(orgId: string): Promise<AccountTier> {
  const org = await db.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  if (!org) throw new Error(`Org ${orgId} not found while resolving its account tier.`);
  return accountTierFromSettings(org.settings);
}

/** Rough token count for budgeting: four characters per token. An estimate, not a tokenizer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The fewest tokens worth serving as an excerpt. Below this, what is left of the
 * budget would hold a fragment too short to answer anything, so the page ends instead.
 */
export const MIN_EXCERPT_TOKENS = 50;

/**
 * Keeps facts in their given (already ranked) order until the next one would
 * exceed the tier's token budget. That next fact is served as a query-focused
 * excerpt in the room that is left (services/memory/query-excerpt.ts), marked with
 * its full length in `excerptOfChars`, and the page ends there. Nothing after it is
 * taken, so a lower-ranked fact never displaces a higher-ranked one; and a long fact
 * at the top of the ranking no longer leaves the page empty.
 *
 * Excerpting only removes text from a fact that was already authorized and
 * erasure-checked whole by the store that returned it.
 */
export function packWithinTokenBudget(facts: readonly MemoryFact[], tokenBudget: number, query: string): MemoryFact[] {
  const packed: MemoryFact[] = [];
  let used = 0;
  for (const fact of facts) {
    const cost = estimateTokens(fact.fact);
    if (used + cost <= tokenBudget) {
      packed.push(fact);
      used += cost;
      continue;
    }
    const roomTokens = tokenBudget - used;
    if (roomTokens >= MIN_EXCERPT_TOKENS) {
      const excerpt = excerptForQuery(fact.fact, query, roomTokens * 4);
      if (excerpt) packed.push({ ...fact, fact: excerpt, excerptOfChars: fact.fact.length });
    }
    break;
  }
  return packed;
}
