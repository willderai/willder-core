// The "where this came from" figure for one read: which stores answered, how
// many of the returned facts each supplied, and the context those facts cost.
//
// Built from what the caller actually received, after merging, the limit and
// the token budget, so the counts never include a fact the caller was not given.

import type { MemoryFact, RetrievalBackend, RetrievalBreakdown, SearchResult } from "@/types/memory";
import { estimateTokens } from "./account-tiers";

/**
 * Summarizes a read made of several store calls (`legs`) that returned `facts`.
 * A store is listed once, in the order it was first asked, and is marked failed
 * only when every call that asked it failed.
 */
export function retrievalBreakdown(facts: readonly MemoryFact[], legs: readonly SearchResult[]): RetrievalBreakdown {
  const answered = new Map<RetrievalBackend, boolean>();
  // A store some call said is behind (`partial`), with the most rows any call said it owes:
  // calls over different scopes count different rows, so the largest is a lower bound.
  const pending = new Map<RetrievalBackend, number>();
  for (const read of legs.flatMap((leg) => leg.storesRead ?? [])) {
    answered.set(read.store, (answered.get(read.store) ?? false) || !read.failed);
    if (read.partial) pending.set(read.store, Math.max(pending.get(read.store) ?? 0, read.pendingRows ?? 0));
  }
  const stores = [...answered].map(([store, ok]) => {
    const hits = facts.filter((f) => f.store === store).length;
    const behind = pending.has(store) ? { partial: true as const, pendingRows: pending.get(store)! } : {};
    return ok ? { store, hits, ...behind } : { store, hits, failed: true as const };
  });
  const contextTokens = facts.reduce((sum, f) => sum + estimateTokens(f.fact), 0);
  return { stores, contextTokens };
}

/**
 * The stores that failed at least one call of a read made of `legs`, in the order first
 * asked. Unlike the breakdown, one failed call is enough: the facts it would have
 * returned are missing even when another call to the same store answered.
 */
export function failedStores(legs: readonly SearchResult[]): RetrievalBackend[] {
  const failed = legs.flatMap((leg) => leg.storesRead ?? []).filter((read) => read.failed);
  return [...new Set(failed.map((read) => read.store))];
}
