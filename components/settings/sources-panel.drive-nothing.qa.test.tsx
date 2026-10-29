// @vitest-environment jsdom
//
// The "No files synced" warning must fire only for a finished Drive sync whose
// listing held no readable file, and the Picker's app ID must come from the
// leading project number of a real OAuth client ID.
//
// Each case below kills a mutant the panel's other tests let through:
// - an unchanged folder re-syncs with synced 0 and skipped N; keying the
//   warning on `synced` instead of `fileCount` would flag every healthy re-sync;
// - connector-sync writes `fileCount` for Slack, Figma and PostHog too, so an
//   empty Slack channel must not get the Drive pill and copy;
// - an errored Drive sync already says "Needs attention" and its own error;
// - a client ID with a number later in the string is not a project number.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { answerSources } from "./sources-test-api";

const NOTHING = /Nothing from this folder is in memory/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function sourceRow(type: string, meta: Record<string, unknown>, status = "active") {
  return { id: "s1", type, name: "Source One", scopePath: "org.s1", status, meta, createdAt: "", _count: { files: 0 } };
}

async function renderWith(row: ReturnType<typeof sourceRow>) {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(answerSources([row])));
  const { SourcesPanel } = await import("./sources-panel");
  render(<SourcesPanel />);
  await screen.findByText("Source One");
}

const finished = (counts: Record<string, number>) => ({ lastSyncAt: "2026-10-10T03:00:00Z", ...counts });

describe("SourcesPanel — the no-files warning fires only for an empty Drive listing", () => {
  it("does not warn on a re-sync that skipped every unchanged file", async () => {
    await renderWith(sourceRow("gdrive", finished({ fileCount: 3, synced: 0, skipped: 3, failed: 0 })));
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByText("No files synced")).toBeNull();
    expect(screen.queryByText(NOTHING)).toBeNull();
  });

  it("does not put the Drive warning on an empty Slack source", async () => {
    await renderWith(sourceRow("slack", finished({ fileCount: 0, synced: 0, skipped: 0, failed: 0 })));
    expect(screen.queryByText("No files synced")).toBeNull();
    expect(screen.queryByText(NOTHING)).toBeNull();
  });

  it("leaves an errored Drive sync to its own error, not the no-files warning", async () => {
    await renderWith(
      sourceRow(
        "gdrive",
        { ...finished({ fileCount: 0, synced: 0, skipped: 0, failed: 0 }), error: "Drive files.list failed: 401" },
        "error",
      ),
    );
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.queryByText(NOTHING)).toBeNull();
  });
});

describe("SourcesPanel — Picker app ID is the client ID's leading project number", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_GDRIVE_MOCK", "false");
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_API_KEY", "test-api-key");
  });

  it("refuses a client ID whose number is not at the start", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "web-123456789012-test.apps.googleusercontent.com");
    let tokenRequested = false;
    vi.stubGlobal("google", {
      accounts: {
        oauth2: {
          initTokenClient: () => {
            tokenRequested = true;
            return { requestAccessToken() {} };
          },
        },
      },
    });
    vi.stubGlobal("gapi", { load() {} });
    await renderWith(sourceRow("website", {}));
    fireEvent.click(await screen.findByText("+ Connect Drive folder"));
    expect(await screen.findByText(/NEXT_PUBLIC_GOOGLE_CLIENT_ID is not a Google OAuth client ID/)).toBeTruthy();
    expect(tokenRequested).toBe(false);
  });
});
