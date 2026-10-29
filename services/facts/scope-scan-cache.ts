// In-memory, per-process cache for Gate C.2's contradiction scan (item
// handoff-gate-c2-contradiction-detection-20260919's coordinator-ruling cost guard).
// scanForContradictions (app/api/briefs/[id]/staleness/route.ts) makes a real
// paid LLM call on every GET where the brief's changed-fact set is non-empty —
// unbounded and unrated, so a grantee refreshing a still-stale brief repeatedly
// re-buys the same model call for a scope that has not actually changed since
// the last time it ran.
//
// The rule this file enforces: derived data never outlives its source. A cached
// scan holds fact text, so it is reused only while its fingerprint, built from
// services/access/check.ts's scopeCacheStamp(), is unchanged:
//   - the org's removal epoch, which moves on every erasure and removal anywhere in
//     the org (an erasure writes no `memory.*.applied` row, and an erased person's
//     text can sit in any scope);
//   - the count of every applied change under the brief's scope, not a fixed first-N
//     window, which stops seeing changes once it is full.
// The stamp lives in Postgres, so a removal made by another process (an Inngest job,
// another instance) invalidates this process's entries too.
//
// Per-process tradeoff, same as lib/rate-limit.ts — fine for dev and a
// single-instance deploy; swap the store for multi-instance production.
import type { ScopeCacheStamp } from "@/services/access";

interface ScopeContradiction {
  factA: string;
  factB: string;
  note: string;
}

interface CacheEntry {
  fingerprint: string;
  contradictions: ScopeContradiction[];
}

const store = new Map<string, CacheEntry>();

/** Bounds process memory across all cached briefs; oldest entry evicted on overflow. */
const MAX_ENTRIES = 500;

/** A stable fingerprint of what a brief's cached scan was derived from. Reusing the
 *  last scan is safe exactly when this string is unchanged from the last call. */
export function scanFingerprint(stamp: ScopeCacheStamp): string {
  return [`epoch=${stamp.erasureEpoch}`, `changes=${stamp.changeCount}`].join("|");
}

/** The cached scan result for `briefId`, or `undefined` on a genuine miss
 *  (no prior scan, or the changed-fact set has moved since it ran). */
export function getCachedScan(briefId: string, fingerprint: string): ScopeContradiction[] | undefined {
  const hit = store.get(briefId);
  return hit && hit.fingerprint === fingerprint ? hit.contradictions : undefined;
}

export function setCachedScan(briefId: string, fingerprint: string, contradictions: ScopeContradiction[]): void {
  if (!store.has(briefId) && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(briefId, { fingerprint, contradictions });
}
