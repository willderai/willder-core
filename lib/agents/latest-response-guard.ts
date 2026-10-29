// Guards against a stale async response overwriting state a later, faster-
// resolving request already wrote. A fixed setInterval(load, 4000) can start
// a new fetch while the previous one is still in flight, and network timing
// gives no guarantee responses land in request order.
//
// `start()` issues a monotonic token per request; `isCurrent(token)` is true
// only for the token from the MOST RECENT `start()` call, so a caller can
// drop a response that arrives after a newer request has already been
// issued, instead of letting it overwrite fresher state (or, for a slow
// 403, re-forbid a viewer whose access is actually fine by the time it
// resolves).
export function createLatestResponseGuard() {
  let latest = 0;
  return {
    start(): number {
      latest += 1;
      return latest;
    },
    isCurrent(token: number): boolean {
      return token === latest;
    },
  };
}
