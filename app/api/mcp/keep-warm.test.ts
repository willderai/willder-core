import { describe, expect, it, vi } from "vitest";

// isVercelCronPing compares in constant time: SHA-256 digests of the sent header and of
// `Bearer <secret>`, through crypto.timingSafeEqual. Digests make both sides 32 bytes, so a
// header of any length is compared without throwing and without a length-dependent early exit.

const { timingSafeEqual } = vi.hoisted(() => ({ timingSafeEqual: vi.fn() }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqual.mockImplementation(actual.timingSafeEqual);
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});

import { MIN_SECRET_LENGTH, isVercelCronPing } from "./keep-warm";

const SECRET = "0123456789abcdef0123456789abcdef";

function req(authorization?: string): Request {
  return new Request("https://willder.ai/api/mcp", { headers: authorization === undefined ? {} : { authorization } });
}

describe("isVercelCronPing", () => {
  it("accepts exactly `Bearer <secret>`", () => {
    expect(isVercelCronPing(req(`Bearer ${SECRET}`), SECRET)).toBe(true);
  });

  it("compares 32-byte digests with timingSafeEqual, whatever the header's length", () => {
    timingSafeEqual.mockClear();
    for (const header of ["x", `Bearer ${SECRET}`, `Bearer ${SECRET}${"z".repeat(500)}`]) {
      expect(() => isVercelCronPing(req(header), SECRET)).not.toThrow();
    }

    expect(timingSafeEqual).toHaveBeenCalledTimes(3);
    for (const [a, b] of timingSafeEqual.mock.calls) {
      expect((a as Buffer).length).toBe(32);
      expect((b as Buffer).length).toBe(32);
    }
  });

  it("refuses a different secret of the same length", () => {
    const other = SECRET.replace(/.$/, "0");
    expect(isVercelCronPing(req(`Bearer ${other}`), SECRET)).toBe(false);
  });

  it("is off, and compares nothing, without a usable secret", () => {
    timingSafeEqual.mockClear();
    const short = "s".repeat(MIN_SECRET_LENGTH - 1);
    expect(isVercelCronPing(req("Bearer undefined"), undefined)).toBe(false);
    expect(isVercelCronPing(req("Bearer "), "")).toBe(false);
    expect(isVercelCronPing(req(`Bearer ${short}`), short)).toBe(false);
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("refuses a request with no Authorization header", () => {
    expect(isVercelCronPing(req(), SECRET)).toBe(false);
  });
});
