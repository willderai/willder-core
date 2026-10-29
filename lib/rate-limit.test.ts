import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRateLimited } from "./rate-limit";

// Reset internal state between tests by re-importing a fresh module.
// Vitest's module isolation (vi.resetModules) gives each test a clean store.

describe("isRateLimited — sliding window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the limit", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited(key, 5, 60_000)).toBe(false);
    }
  });

  it("blocks the request that exceeds the limit", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 5; i++) isRateLimited(key, 5, 60_000);
    expect(isRateLimited(key, 5, 60_000)).toBe(true);
  });

  it("allows again after the window slides past old timestamps", () => {
    const key = `test:${Math.random()}`;
    vi.setSystemTime(0);
    for (let i = 0; i < 5; i++) isRateLimited(key, 5, 60_000);
    expect(isRateLimited(key, 5, 60_000)).toBe(true);

    // Advance past the 60 s window so all old timestamps expire.
    vi.setSystemTime(61_000);
    expect(isRateLimited(key, 5, 60_000)).toBe(false);
  });

  it("different keys are tracked independently", () => {
    const keyA = `test-a:${Math.random()}`;
    const keyB = `test-b:${Math.random()}`;
    for (let i = 0; i < 3; i++) isRateLimited(keyA, 3, 60_000);
    // keyA is now at its limit; keyB should still be free
    expect(isRateLimited(keyA, 3, 60_000)).toBe(true);
    expect(isRateLimited(keyB, 3, 60_000)).toBe(false);
  });

  it("limit=1 allows exactly one request and blocks the second", () => {
    const key = `test:${Math.random()}`;
    expect(isRateLimited(key, 1, 60_000)).toBe(false);
    expect(isRateLimited(key, 1, 60_000)).toBe(true);
  });

  it("very short window (1 ms) expires almost immediately", () => {
    vi.setSystemTime(1000);
    const key = `test:${Math.random()}`;
    isRateLimited(key, 1, 1); // uses up the one slot
    expect(isRateLimited(key, 1, 1)).toBe(true);
    vi.setSystemTime(1002); // 2 ms later — past the 1 ms window
    expect(isRateLimited(key, 1, 1)).toBe(false);
  });

  it("large burst: 1000-request limit correctly tracks big windows", () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 1000; i++) isRateLimited(key, 1000, 3_600_000);
    expect(isRateLimited(key, 1000, 3_600_000)).toBe(true);
  });
});
