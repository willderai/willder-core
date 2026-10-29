// @vitest-environment jsdom
//
// The Drive connect flow's guards against hanging, one test each (stale-attempt checks, the picker ERROR action,
// readable token errors, retry after a failed library load, the timer being
// stopped once the person acts or the panel unmounts, and the Sync popup path).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { answerSources } from "./sources-test-api";

type TokenConfig = {
  callback: (resp: { access_token?: string; error?: string; error_description?: string }) => void;
  error_callback?: (err: { type: string; message?: string }) => void;
};
type LoadConfig = { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void };

let tokenConfig: TokenConfig | null;
let pickerCallback: ((data: { action: string; docs?: { id: string; name: string }[] }) => void) | null;
let setVisible: ReturnType<typeof vi.fn>;
let fetcher: ReturnType<typeof vi.fn>;

const ACTION = { PICKED: "picked", CANCEL: "cancel", LOADED: "loaded", ERROR: "error" };
const TIMEOUT_MS = 5 * 60_000;

function pickerApi() {
  class DocsView {
    setSelectFolderEnabled() {
      return this;
    }
    setIncludeFolders() {
      return this;
    }
  }
  class PickerBuilder {
    addView() {
      return this;
    }
    setOAuthToken() {
      return this;
    }
    setDeveloperKey() {
      return this;
    }
    setAppId() {
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

/** `load` decides how each gapi.load("picker") call settles; the default succeeds at once. */
function stubGoogle(load?: (config: LoadConfig, gapi: Record<string, unknown>) => void) {
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
    load: (_lib: string, config: LoadConfig) => {
      if (load) {
        load(config, gapi);
        return;
      }
      gapi.picker = pickerApi();
      config.callback();
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
  fetcher = vi.fn(answerSources([]));
  vi.stubGlobal("fetch", fetcher);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  document.head.querySelectorAll("script").forEach((s) => s.remove());
});

async function renderPanel() {
  const { SourcesPanel } = await import("./sources-panel");
  return render(<SourcesPanel />);
}

async function clickConnect() {
  fireEvent.click(await screen.findByText("+ Connect Drive folder"));
  await waitFor(() => expect(tokenConfig).not.toBeNull());
}

function expectIdle() {
  expect(screen.getByText("+ Connect Drive folder")).toBeTruthy();
  expect(screen.queryByText("Connecting…")).toBeNull();
}

async function openPicker() {
  await act(async () => {
    tokenConfig!.callback({ access_token: "tok-123" });
  });
  await waitFor(() => expect(setVisible).toHaveBeenCalledWith(true));
  await act(async () => {
    pickerCallback!({ action: ACTION.LOADED });
  });
}

describe("SourcesPanel Drive connect guards", () => {
  it("resets with an actionable message when the picker reports ERROR", async () => {
    stubGoogle();
    await renderPanel();
    await clickConnect();
    await openPicker();
    await act(async () => {
      pickerCallback!({ action: ACTION.ERROR });
    });
    expect(await screen.findByText(/picker reported an error\. Check that the Picker API is enabled/)).toBeTruthy();
    expectIdle();
  });

  it("says access was not granted when the person declines the Drive scope", async () => {
    stubGoogle();
    await renderPanel();
    await clickConnect();
    await act(async () => {
      tokenConfig!.callback({ error: "access_denied" });
    });
    expect(await screen.findByText("Google Drive access was not granted, so nothing was connected.")).toBeTruthy();
    expectIdle();
  });

  it("ignores a token error that arrives after the attempt timed out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubGoogle();
    await renderPanel();
    await clickConnect();
    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS);
    });
    expect(await screen.findByText(/Google did not respond within 5 minutes/)).toBeTruthy();
    await act(async () => {
      tokenConfig!.callback({ error: "access_denied" });
    });
    expect(screen.getByText(/Google did not respond within 5 minutes/)).toBeTruthy();
    expect(screen.queryByText(/access was not granted/)).toBeNull();
  });

  it("does not open the picker if the attempt timed out while the picker library was loading", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let finishLoad: (() => void) | null = null;
    stubGoogle((config, gapi) => {
      finishLoad = () => {
        gapi.picker = pickerApi();
        config.callback();
      };
    });
    await renderPanel();
    await clickConnect();
    await act(async () => {
      tokenConfig!.callback({ access_token: "tok-123" });
    });
    await waitFor(() => expect(finishLoad).not.toBeNull());
    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS);
    });
    expect(await screen.findByText(/Google did not respond within 5 minutes/)).toBeTruthy();
    await act(async () => {
      finishLoad!();
    });
    expect(setVisible).not.toHaveBeenCalled();
    expectIdle();
  });

  it("retries the picker library on the next attempt after a failed load", async () => {
    let loads = 0;
    stubGoogle((config, gapi) => {
      loads += 1;
      if (loads === 1) {
        config.onerror();
        return;
      }
      gapi.picker = pickerApi();
      config.callback();
    });
    await renderPanel();
    await clickConnect();
    await act(async () => {
      tokenConfig!.callback({ access_token: "tok-1" });
    });
    expect(await screen.findByText(/Picker library failed to load/)).toBeTruthy();
    expectIdle();

    tokenConfig = null;
    await clickConnect();
    await act(async () => {
      tokenConfig!.callback({ access_token: "tok-2" });
    });
    await waitFor(() => expect(setVisible).toHaveBeenCalledWith(true));
    expect(loads).toBe(2);
  });

  it("shows no timeout error after the person cancels the picker before it reported LOADED", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubGoogle();
    await renderPanel();
    await clickConnect();
    await act(async () => {
      tokenConfig!.callback({ access_token: "tok-123" });
    });
    await waitFor(() => expect(setVisible).toHaveBeenCalledWith(true));
    await act(async () => {
      pickerCallback!({ action: ACTION.CANCEL });
    });
    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS);
    });
    expect(screen.queryByText(/did not respond within 5 minutes/)).toBeNull();
    expectIdle();
  });

  it("shows no timeout error while the picked folder is still being saved", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubGoogle();
    await renderPanel();
    await clickConnect();
    await act(async () => {
      tokenConfig!.callback({ access_token: "tok-123" });
    });
    await waitFor(() => expect(setVisible).toHaveBeenCalledWith(true));
    let finishPost: ((r: Response) => void) | null = null;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Promise<Response>((r) => {
            finishPost = r;
          })
        : answerSources([])(url, init),
    );
    await act(async () => {
      pickerCallback!({ action: ACTION.PICKED, docs: [{ id: "f1", name: "Sales" }] });
    });
    act(() => {
      vi.advanceTimersByTime(TIMEOUT_MS);
    });
    expect(screen.queryByText(/did not respond within 5 minutes/)).toBeNull();
    await act(async () => {
      finishPost!(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    await waitFor(expectIdle);
  });

  it("clears the connect timer when the panel unmounts mid-attempt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubGoogle();
    const view = await renderPanel();
    await clickConnect();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Sync of a Drive source stops 'Requesting…' and asks to allow popups when the popup is blocked", async () => {
    fetcher.mockImplementation(
      answerSources([
        {
          id: "s1",
          type: "gdrive",
          name: "Sales",
          scopePath: "/org/sales",
          status: "active",
          meta: null,
          createdAt: "2026-10-01T00:00:00Z",
          _count: { files: 0 },
        },
      ]),
    );
    stubGoogle();
    await renderPanel();
    fireEvent.click(await screen.findByText("Sync"));
    expect(screen.getByText("Requesting…")).toBeTruthy();
    await waitFor(() => expect(tokenConfig).not.toBeNull());
    act(() => tokenConfig!.error_callback!({ type: "popup_failed_to_open" }));
    expect(await screen.findByText(/blocked the Google sign-in popup/)).toBeTruthy();
    expect(screen.queryByText("Requesting…")).toBeNull();
  });
});
