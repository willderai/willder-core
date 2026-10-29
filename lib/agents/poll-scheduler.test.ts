import { afterEach, describe, expect, it, vi } from "vitest";
import { createPollScheduler } from "./poll-scheduler";

describe("createPollScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls poll immediately, then again after settling, not on a fixed clock", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    createPollScheduler(poll, 4000);

    expect(poll).toHaveBeenCalledTimes(1); // fires immediately, no initial wait

    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("a response slower than the interval is never starved out, and a later poll still lands", async () => {
    // The failure mode at the scheduling layer: a 5s response against a 4s
    // interval. A fixed setInterval(load, 4000) starts a second request at
    // t=4000 while the first is still pending, invalidating it under
    // createLatestResponseGuard() before it can ever apply — so with a
    // sustained >4s response time, NO response ever lands, the panel never
    // leaves its loading skeleton, and it never stops polling even after a
    // finishedAt response arrives, because that response is discarded too.
    vi.useFakeTimers();
    let inFlight = 0;
    let maxConcurrent = 0;
    const landed: number[] = [];
    let call = 0;

    const poll = vi.fn(() => {
      const thisCall = ++call;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      return new Promise<boolean | void>((resolve) => {
        setTimeout(() => {
          inFlight -= 1;
          landed.push(thisCall);
          resolve(undefined);
        }, 5000); // slower than the 4000ms interval
      });
    });

    createPollScheduler(poll, 4000);

    // Advance well past where a fixed setInterval would have fired a second,
    // overlapping call (t=4000) while the first (t=0..5000) was still
    // pending.
    await vi.advanceTimersByTimeAsync(4000); // t=4000
    expect(poll).toHaveBeenCalledTimes(1); // NOT started a second call yet
    expect(maxConcurrent).toBe(1); // never more than one in flight

    await vi.advanceTimersByTimeAsync(999); // t=4999, still one tick before the first settles
    expect(landed).toEqual([]);
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // t=5000, first call settles
    expect(landed).toEqual([1]); // the first response actually landed
    expect(poll).toHaveBeenCalledTimes(1); // second call scheduled from here, not fired yet

    await vi.advanceTimersByTimeAsync(3999); // t=8999, one tick before the next interval elapses
    expect(poll).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1); // t=9000 = settle (5000) + interval (4000)
    expect(poll).toHaveBeenCalledTimes(2); // second call started once the first settled + interval elapsed

    expect(maxConcurrent).toBe(1); // no overlap across the whole run
  });

  it("stops scheduling once poll returns false, e.g. the run behind it has finished", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(false).mockResolvedValue(undefined);
    createPollScheduler(poll, 4000);

    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(2); // returns false here

    await vi.advanceTimersByTimeAsync(20000);
    expect(poll).toHaveBeenCalledTimes(2); // never scheduled again
  });

  it("stop() cancels a call scheduled but not yet fired, and any in-flight poll's own resolution no longer reschedules", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPollScheduler(poll, 4000);

    expect(poll).toHaveBeenCalledTimes(1);
    scheduler.stop();

    await vi.advanceTimersByTimeAsync(60000);
    expect(poll).toHaveBeenCalledTimes(1); // no further calls after stop()
  });

  it("a rejected poll is swallowed and scheduling continues, matching a caller's own .catch() semantics", async () => {
    vi.useFakeTimers();
    const poll = vi.fn().mockRejectedValueOnce(new Error("network error")).mockResolvedValue(undefined);
    createPollScheduler(poll, 4000);

    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(2); // kept polling despite the rejection
  });
});
