// @vitest-environment jsdom
//
// Connect Drive folder used to stay on "Connecting…" forever in production:
// a blocked or closed sign-in popup, a Picker that failed to build, and the
// Picker's own "loaded" event each left the button stuck or reset it early.
// Every outcome must end the attempt (or deliberately keep it open) and say why.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { answerSources } from "./sources-test-api";

type TokenConfig = {
  callback: (resp: { access_token?: string; error?: string }) => void;
  error_callback?: (err: { type: string; message?: string }) => void;
};

let tokenConfig: TokenConfig | null;
let pickerCallback: ((data: { action: string; docs?: { id: string; name: string }[] }) => void) | null;
let setVisible: ReturnType<typeof vi.fn>;
let appIds: string[];
let fetcher: ReturnType<typeof vi.fn>;

const ACTION = { PICKED: "picked", CANCEL: "cancel", LOADED: "loaded" };

function pickerApi(overrides: { buildThrows?: Error } = {}) {
  class DocsView {
    setSelectFolderEnabled() {
      return this;
    }
    setIncludeFolders() {
      return this;
    }
    setMimeTypes() {
      return this;
    }
  }
  class PickerBuilder {
    constructor() {
      if (overrides.buildThrows) throw overrides.buildThrows;
    }
    addView() {
      return this;
    }
    setOAuthToken() {
      return this;
    }
    setDeveloperKey() {
      return this;
    }
    setAppId(id: string) {
      appIds.push(id);
      return this;
    }
    enableFeature() {
      return this;
    }
    setCallback(cb: typeof pickerCallback) {
      pickerCallback = cb;
      return this;
    }
    build() {
      return { setVisible };
    }
  }
  return {
    PickerBuilder,
    DocsView,
    Feature: { MULTISELECT_ENABLED: "multi" },
    ViewId: { FOLDERS: "folders" },
    Action: ACTION,
  };
}

/** Stubs Google's globals. `picker: null` simulates a gapi that loads without the picker API. */
function stubGoogle(options: { picker?: ReturnType<typeof pickerApi> | null } = {}) {
  const picker = options.picker === undefined ? pickerApi() : options.picker;
  vi.stubGlobal("google", {
    accounts: {
      oauth2: {
        initTokenClient: (config: TokenConfig) => {
          tokenConfig = config;
          return { requestAccessToken: () => {} };
        },
      },
    },
  });
  const gapi: Record<string, unknown> = {
    load: (_lib: string, config: (() => void) | { callback: () => void }) => {
      if (picker) gapi.picker = picker;
      if (typeof config === "function") config();
      else config.callback();
    },
  };
  vi.stubGlobal("gapi", gapi);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_GDRIVE_MOCK", "false");
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "123456789012-test.apps.googleusercontent.com");
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_API_KEY", "test-api-key");
  tokenConfig = null;
  pickerCallback = null;
  setVisible = vi.fn();
  appIds = [];
  fetcher = vi.fn(answerSources([]));
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

async function clickConnect() {
  const { SourcesPanel } = await import("./sources-panel");
  render(<SourcesPanel />);
  fireEvent.click(await screen.findByText("+ Connect Drive folder"));
  expect(screen.getAllByText("Connecting…").length).toBeGreaterThan(0);
  await waitFor(() => expect(tokenConfig).not.toBeNull());
}

function expectIdle() {
  expect(screen.getByText("+ Connect Drive folder")).toBeTruthy();
  expect(screen.queryByText("Connecting…")).toBeNull();
}

async function signInAndOpenPicker() {
  await act(async () => {
    tokenConfig!.callback({ access_token: "tok-123" });
  });
  await waitFor(() => expect(setVisible).toHaveBeenCalledWith(true));
}

describe("SourcesPanel — Drive connect ends every attempt (real Drive mode)", () => {
  it("resets and asks to allow popups when the sign-in popup is blocked", async () => {
    stubGoogle();
    await clickConnect();
    act(() => tokenConfig!.error_callback!({ type: "popup_failed_to_open" }));
    expect(await screen.findByText(/blocked the Google sign-in popup\. Allow popups for this site/)).toBeTruthy();
    expectIdle();
  });

  it("resets and says it was cancelled when the sign-in popup is closed", async () => {
    stubGoogle();
    await clickConnect();
    act(() => tokenConfig!.error_callback!({ type: "popup_closed" }));
    expect(await screen.findByText(/Google sign-in was closed before it finished/)).toBeTruthy();
    expectIdle();
  });

  it("resets and shows Google's error when the Picker fails to build", async () => {
    stubGoogle({ picker: pickerApi({ buildThrows: new Error("The API developer key is invalid.") }) });
    await clickConnect();
    await act(async () => {
      tokenConfig!.callback({ access_token: "tok-123" });
    });
    expect(
      await screen.findByText("Could not open the Google Drive picker: The API developer key is invalid."),
    ).toBeTruthy();
    expectIdle();
  });

  it("resets and says so when the picker library loads without the picker API", async () => {
    stubGoogle({ picker: null });
    await clickConnect();
    await act(async () => {
      tokenConfig!.callback({ access_token: "tok-123" });
    });
    expect(await screen.findByText(/Could not open the Google Drive picker: .*picker API is missing/)).toBeTruthy();
    expectIdle();
  });

  it("keeps connecting while the Picker is open (LOADED), and resets on CANCEL", async () => {
    stubGoogle();
    await clickConnect();
    await signInAndOpenPicker();

    await act(async () => {
      pickerCallback!({ action: ACTION.LOADED });
    });
    expect(screen.getAllByText("Connecting…").length).toBeGreaterThan(0);

    await act(async () => {
      pickerCallback!({ action: ACTION.CANCEL });
    });
    expectIdle();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("posts the picked folder and token to /api/sources on PICKED", async () => {
    stubGoogle();
    await clickConnect();
    await signInAndOpenPicker();
    await act(async () => {
      pickerCallback!({ action: ACTION.LOADED });
    });

    await act(async () => {
      pickerCallback!({ action: ACTION.PICKED, docs: [{ id: "folder-1", name: "Sales" }] });
    });

    const post = fetcher.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(post?.[0]).toBe("/api/sources");
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      type: "gdrive",
      folderId: "folder-1",
      folderName: "Sales",
      token: "tok-123",
    });
    await waitFor(expectIdle);
  });

  it("gives up with a message when Google never answers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubGoogle();
    await clickConnect();
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(await screen.findByText(/Google did not respond within 5 minutes/)).toBeTruthy();
    expectIdle();

    // A token that arrives after the attempt was abandoned opens nothing.
    await act(async () => {
      tokenConfig!.callback({ access_token: "late" });
    });
    expect(setVisible).not.toHaveBeenCalled();
  });

  // Under drive.file, Google grants a picked folder to the app only when the
  // Picker names the Cloud project; without it the sync lists nothing.
  it("names the Cloud project number from the client ID as the Picker's app ID", async () => {
    stubGoogle();
    await clickConnect();
    await signInAndOpenPicker();
    expect(appIds).toEqual(["123456789012"]);
  });

  it("refuses to open the Picker when the client ID carries no project number", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "test-client-id");
    stubGoogle();
    const { SourcesPanel } = await import("./sources-panel");
    render(<SourcesPanel />);
    fireEvent.click(await screen.findByText("+ Connect Drive folder"));
    expect(await screen.findByText(/NEXT_PUBLIC_GOOGLE_CLIENT_ID is not a Google OAuth client ID/)).toBeTruthy();
    expect(tokenConfig).toBeNull();
    expectIdle();
  });
});
