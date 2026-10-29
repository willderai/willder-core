// @vitest-environment jsdom
//
// With real Drive mode on, a blocked Google script must not leave the panel's
// loader promise pending and "+ Connect Drive folder" spinning with no
// explanation. A blocked script must surface as an error, and clicking Connect before the
// Google globals exist must stop the spinner and say why.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { answerSources } from "./sources-test-api";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_GDRIVE_MOCK", "false");
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "test-client-id");
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_API_KEY", "test-api-key");
  vi.stubGlobal("fetch", vi.fn(answerSources([])));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

function googleScripts(): HTMLScriptElement[] {
  return Array.from(document.head.querySelectorAll<HTMLScriptElement>("script")).filter((s) =>
    /accounts\.google\.com|apis\.google\.com/.test(s.src),
  );
}

describe("SourcesPanel — Google scripts blocked (real Drive mode)", () => {
  it("shows why when a Google script fails to load", async () => {
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    await waitFor(() => expect(googleScripts()).toHaveLength(2));

    googleScripts()[0].dispatchEvent(new Event("error"));

    expect(
      await screen.findByText(
        /Could not load https:\/\/accounts\.google\.com\/gsi\/client\. Check the Content-Security-Policy/,
      ),
    ).toBeTruthy();
  });

  it("stops connecting and explains when Connect is clicked before the scripts load", async () => {
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);

    fireEvent.click(await screen.findByText("+ Connect Drive folder"));

    expect(await screen.findByText(/Google sign-in scripts have not loaded/)).toBeTruthy();
    expect(screen.getByText("+ Connect Drive folder")).toBeTruthy();
    expect(screen.queryByText("Connecting…")).toBeNull();
  });

  it("explains an unavailable Google sign-in before requesting a Drive re-sync", async () => {
    const fetcher = vi.fn(
      answerSources([
        {
          id: "drive-1",
          type: "gdrive",
          name: "Team Drive",
          scopePath: "org.team",
          status: "active",
          meta: null,
          createdAt: "2026-10-01T00:00:00Z",
          _count: { files: 1 },
        },
      ]),
    );
    vi.stubGlobal("fetch", fetcher);
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
    expect(
      await screen.findByText("Google sign-in is not ready. Reload this page before syncing your Drive folder."),
    ).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Requesting…")).toBeNull();
  });
});
