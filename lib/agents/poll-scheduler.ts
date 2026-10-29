// Serialises a repeating async poll so at most one call is ever in flight.
// A fixed `setInterval(load, 4000)` fires again even while an earlier `load()` is
// still pending; `createLatestResponseGuard()` (lib/agents/latest-response-guard.ts)
// stops a stale response from overwriting fresher state once that happens,
// but if a single response ever takes longer than the interval, every later
// tick's own response is invalidated the same way before it can apply —
// entries stop landing, `setLoading(false)` stops firing, and the
// finishedAt-triggered stop never runs, all silently, for as long as the
// slow stretch lasts.
//
// `poll` is called immediately, then again `intervalMs` after each call
// SETTLES rather than on a fixed clock, so the next call never starts while
// the previous one is still outstanding. Return `false` from `poll` to stop
// scheduling for good (e.g. the run behind it has finished); any other
// return value (including a rejection, which is swallowed the same way a
// caller's own `.catch()` already handles its errors) keeps polling.
export function createPollScheduler(poll: () => Promise<boolean | void>, intervalMs: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const settled = (keepGoing: boolean | void) => {
    if (stopped || keepGoing === false) return;
    timer = setTimeout(tick, intervalMs);
  };

  function tick() {
    timer = null;
    Promise.resolve(poll()).then(settled, () => settled(true));
  }

  tick();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
