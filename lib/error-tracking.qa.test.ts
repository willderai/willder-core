// Server error tracking: a PostHog host that accepts the
// connection and never answers must not hold the failing request open. Next.js
// awaits onRequestError before it sends the error response, so the report's own
// timeout is the only bound on how long a hung host delays that response
// (measured on a built server: a 500 went from 0.1 s to 2.1 s, then completed).
import { afterEach, expect, it, vi } from "vitest";
import { reportServerError } from "./error-tracking";

const context = { method: "POST", path: "/api/mcp", routePath: "/api/mcp", routeType: "route" };

afterEach(() => vi.unstubAllEnvs());

it("gives up on a PostHog host that never answers, and resolves", async () => {
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
  const hangsUntilAborted = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      }),
  );

  // AbortSignal.timeout runs on the real clock, so this waits on it for real.
  const outcome = await Promise.race([
    reportServerError(new Error("boom"), context, hangsUntilAborted as unknown as typeof fetch).then(() => "resolved"),
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 4_000)),
  ]);
  expect(hangsUntilAborted).toHaveBeenCalledOnce();
  expect(outcome).toBe("resolved");
}, 10_000);
