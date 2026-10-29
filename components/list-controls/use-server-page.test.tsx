// @vitest-environment jsdom
//
// useServerPage reads one page of a server-paged list. Two of its rules are about
// time, and each test here fails if its guard is removed: an answer to a request the
// view has moved past never replaces the current answer, and a search waits for the
// typing to pause before it asks the server. A third says which loads may still lean
// on the page before: a new search may, a reload after a write may not.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));

import { pageToShow, useServerPage } from "./use-server-page";

const page = (name: string) => Response.json({ rows: [name], total: 1, count: 1, page: 1, pageSize: 25 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function useList({
  query,
  searching = false,
  revision = 0,
}: {
  query: string;
  searching?: boolean;
  revision?: number;
}) {
  return useServerPage<string>({
    prefix: "x.",
    maxPage: 100,
    rowsKey: "rows",
    viewKey: query,
    urlFor: (p) => `/api/x?q=${query}&page=${p}`,
    searching,
    revision,
  });
}

describe("useServerPage", () => {
  it("keeps the current answer when an older request answers after it", async () => {
    let answerOld: (r: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("q=old")
          ? new Promise<Response>((resolve) => {
              answerOld = resolve;
            })
          : Promise.resolve(page("new")),
      ),
    );

    const { result, rerender } = renderHook(useList, { initialProps: { query: "old" } });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    rerender({ query: "new" });
    await waitFor(() => expect(result.current.state).toMatchObject({ status: "ready", data: { rows: ["new"] } }));

    await act(async () => {
      answerOld(page("old"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(result.current.state).toMatchObject({ status: "ready", data: { rows: ["new"] } });
  });

  it("sends a search only once the typing pauses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => page("hit")),
    );
    const { result, rerender } = renderHook(useList, { initialProps: { query: "a", searching: true } });
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    rerender({ query: "ab", searching: true });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(["/api/x?q=ab&page=1"]);
  });

  it("marks a reload after a write as one whose page before no longer settles the list; a new search is not", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    vi.mocked(fetch).mockResolvedValueOnce(page("first"));
    const { result, rerender } = renderHook(useList, { initialProps: { query: "a", revision: 0 } });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    rerender({ query: "b", revision: 0 });
    expect(result.current.state).toMatchObject({ status: "loading", reloading: false, previous: { rows: ["first"] } });
    expect(pageToShow(result.current.state)).toMatchObject({
      fresh: null,
      shown: { rows: ["first"] },
      settled: { rows: ["first"] },
    });

    rerender({ query: "b", revision: 1 });
    expect(result.current.state).toMatchObject({ status: "loading", reloading: true, previous: { rows: ["first"] } });
    expect(pageToShow(result.current.state)).toMatchObject({ fresh: null, shown: { rows: ["first"] }, settled: null });
  });
});

describe("revisited server page requests", () => {
  it("keeps a revisited URL stale until this request answers", async () => {
    const pending: Array<(response: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
    );
    vi.mocked(fetch).mockResolvedValueOnce(page("first"));
    const { result, rerender } = renderHook(useList, { initialProps: { query: "a" } });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    rerender({ query: "b" });
    await waitFor(() => expect(pending).toHaveLength(1));
    rerender({ query: "a" });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pageToShow(result.current.state)).toMatchObject({ fresh: null, shown: { rows: ["first"] } });
    await act(async () => pending[0](page("old search")));
    expect(result.current.state.status).toBe("loading");
    await act(async () => pending[1](page("new first")));
    expect(pageToShow(result.current.state).fresh?.rows).toEqual(["new first"]);
  });
});
