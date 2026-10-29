import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostHogProvider, useAnalytics } from "./posthog-provider";

const analytics = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: analytics }));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("optional analytics", () => {
  it("does not schedule or initialize an SDK when analytics is unconfigured", () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
    const schedule = vi.fn();
    vi.stubGlobal("requestIdleCallback", schedule);
    render(
      <PostHogProvider>
        <span>Usable page</span>
      </PostHogProvider>,
    );
    expect(screen.getByText("Usable page")).toBeTruthy();
    expect(schedule).not.toHaveBeenCalled();
    expect(analytics.init).not.toHaveBeenCalled();
  });

  it("initializes at idle without remounting application children", async () => {
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "test-key");
    let idle: () => void = () => {};
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      idle = callback;
      return 1;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    const mount = vi.fn();
    function Child() {
      const client = useAnalytics();
      useEffect(() => {
        mount();
      }, []);
      return <span>{client ? "Analytics ready" : "Page ready"}</span>;
    }
    render(
      <PostHogProvider>
        <Child />
      </PostHogProvider>,
    );
    expect(screen.getByText("Page ready")).toBeTruthy();
    expect(analytics.init).not.toHaveBeenCalled();
    await act(async () => {
      idle();
    });
    await waitFor(() => expect(screen.getByText("Analytics ready")).toBeTruthy());
    expect(analytics.init).toHaveBeenCalledWith(
      "test-key",
      expect.objectContaining({ capture_pageview: "history_change" }),
    );
    expect(mount).toHaveBeenCalledTimes(1);
  });
});
