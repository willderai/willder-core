// Sliding-window in-memory rate limiter.
// Works per-process — fine for dev and single-instance deploy.
// For multi-instance production swap the store: import from @upstash/ratelimit
// and replace `increment` with Upstash's sliding-window algorithm.

interface Window {
  timestamps: number[];
}

const store = new Map<string, Window>();

/**
 * Returns true when the caller is over their limit.
 *
 * @param key     Unique key for the bucket (e.g. `"memory:ingest:org_123"`).
 * @param limit   Max requests allowed in the window.
 * @param windowMs  Window length in milliseconds.
 */
export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;

  const w = store.get(key) ?? { timestamps: [] };
  // Drop timestamps outside the window.
  w.timestamps = w.timestamps.filter((t) => t > cutoff);

  if (w.timestamps.length >= limit) {
    store.set(key, w);
    return true;
  }

  w.timestamps.push(now);
  store.set(key, w);
  return false;
}

/** Millisecond helpers for readability. */
export const per = {
  minute: 60_000,
  hour: 3_600_000,
} as const;
