import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExceptionEvent, pathWithoutQuery, reportServerError } from "./error-tracking";

const context = { method: "POST", path: "/api/mcp?token=secret#frag", routePath: "/api/mcp", routeType: "route" };

afterEach(() => vi.unstubAllEnvs());

describe("server error tracking", () => {
  it("drops the query string and fragment from the reported path", () => {
    expect(pathWithoutQuery("/api/mcp?token=secret#frag")).toBe("/api/mcp");
    const event = buildExceptionEvent(new Error("boom"), context, "phc_test");
    expect(JSON.stringify(event)).not.toContain("secret");
    expect((event?.properties as Record<string, unknown>).path).toBe("/api/mcp");
  });

  it("reports the error type, message and route", () => {
    const event = buildExceptionEvent(new TypeError("bad input"), context, "phc_test");
    const props = event?.properties as Record<string, unknown>;
    expect(event?.event).toBe("$exception");
    expect(props.$exception_list).toEqual([
      { type: "TypeError", value: "bad input", mechanism: { handled: false, synthetic: false } },
    ]);
    expect(props.route_path).toBe("/api/mcp");
  });

  it("sends nothing when no PostHog key is configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const send = vi.fn();
    await reportServerError(new Error("boom"), context, send as unknown as typeof fetch);
    expect(send).not.toHaveBeenCalled();
  });

  it("posts to the configured host when a key is set", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    vi.stubEnv("POSTHOG_HOST", "https://eu.i.posthog.com/");
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await reportServerError(new Error("boom"), context, send as unknown as typeof fetch);
    expect(send).toHaveBeenCalledWith("https://eu.i.posthog.com/i/v0/e/", expect.objectContaining({ method: "POST" }));
  });

  it("never throws when reporting fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test");
    const send = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      reportServerError(new Error("boom"), context, send as unknown as typeof fetch),
    ).resolves.toBeUndefined();
  });
});
