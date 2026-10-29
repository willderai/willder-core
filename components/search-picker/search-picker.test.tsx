import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SearchPicker, type PickOption, type PickResult, type PickSearch } from "./search-picker";

/** A search whose answers the test releases by hand, in any order. */
function controlledSearch() {
  const calls: { query: string; signal: AbortSignal; resolve: (r: PickResult) => void; reject: () => void }[] = [];
  const search: PickSearch = (query, signal) =>
    new Promise<PickResult>((resolve, reject) =>
      calls.push({ query, signal, resolve, reject: () => reject(new Error("down")) }),
    );
  return { search, calls };
}

const option = (name: string): PickOption => ({ value: `id-${name}`, label: name });

function Harness({ search, onPick = () => {} }: { search: PickSearch; onPick?: (o: PickOption) => void }) {
  const [selected, setSelected] = useState<PickOption | null>(null);
  return (
    <SearchPicker
      label="Member"
      placeholder="Choose a member"
      searchPlaceholder="Search by name"
      selected={selected}
      onChange={(o) => {
        setSelected(o);
        onPick(o);
      }}
      search={search}
    />
  );
}

async function settle() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

function openPicker() {
  fireEvent.click(screen.getByRole("button", { name: /Member/ }));
}

function type(text: string) {
  fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });
}

describe("SearchPicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the server nothing until opened, then once for the empty search", async () => {
    const { search, calls } = controlledSearch();
    render(<Harness search={search} />);
    await settle();
    expect(calls).toHaveLength(0);

    openPicker();
    await settle();
    expect(calls.map((c) => c.query)).toEqual([""]);
    expect(screen.getByRole("status").textContent).toBe("Searching…");
    await act(async () => calls[0].resolve({ options: [option("Ada"), option("Bea")], more: false }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Ada", "Bea"]);
  });

  it("sends one request for a typed word, not one per keystroke", async () => {
    const { search, calls } = controlledSearch();
    render(<Harness search={search} />);
    openPicker();
    await settle();
    // Keystrokes 100 ms apart, as a person types.
    for (const text of ["a", "ad", "ada"]) {
      type(text);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    await settle();
    expect(calls.map((c) => c.query)).toEqual(["", "ada"]);
  });

  it("never shows a slower answer to an earlier search over the current one", async () => {
    const { search, calls } = controlledSearch();
    render(<Harness search={search} />);
    openPicker();
    await settle();
    type("bea");
    await settle();
    // The newer search answers first; the empty search's answer arrives late.
    await act(async () => calls[1].resolve({ options: [option("Bea")], more: false }));
    await act(async () => calls[0].resolve({ options: [option("Ada"), option("Bea"), option("Cy")], more: true }));
    expect(calls[0].signal.aborted).toBe(true);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Bea"]);
    expect(screen.queryByText(/Keep typing/)).toBeNull();
  });

  it("says when more match than it shows", async () => {
    const { search, calls } = controlledSearch();
    render(<Harness search={search} />);
    openPicker();
    await settle();
    await act(async () => calls[0].resolve({ options: [option("Ada"), option("Bea")], more: true }));
    expect(screen.getByRole("status").textContent).toBe("Showing the first 2. Keep typing to narrow.");
  });

  it("says nothing matched, naming the search", async () => {
    const { search, calls } = controlledSearch();
    render(<Harness search={search} />);
    openPicker();
    await settle();
    type("zed");
    await settle();
    await act(async () => calls[1].resolve({ options: [], more: false }));
    expect(screen.getByRole("status").textContent).toBe("No matches for “zed”.");
  });

  it("shows a failed search as a failure with a retry, never as no matches", async () => {
    const { search, calls } = controlledSearch();
    render(<Harness search={search} />);
    openPicker();
    await settle();
    await act(async () => calls[0].reject());
    expect(screen.getByRole("alert").textContent).toContain("Could not load matches.");
    expect(screen.queryByText(/Nothing to pick/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(calls).toHaveLength(2);
    await act(async () => calls[1].resolve({ options: [option("Ada")], more: false }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Ada"]);
  });

  it("picks with the keyboard and shows the choice on the closed field", async () => {
    const { search, calls } = controlledSearch();
    const onPick = vi.fn();
    render(<Harness search={search} onPick={onPick} />);
    openPicker();
    await settle();
    await act(async () => calls[0].resolve({ options: [option("Ada"), option("Bea")], more: false }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(option("Bea"));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "Member: Bea" })).toBeTruthy();
  });

  it("keeps the first match active when ArrowDown is pressed before any match arrives", async () => {
    const { search, calls } = controlledSearch();
    const onPick = vi.fn();
    render(<Harness search={search} onPick={onPick} />);
    openPicker();
    await settle();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    await act(async () => calls[0].resolve({ options: [option("Ada"), option("Bea")], more: false }));
    expect(screen.getByRole("combobox").getAttribute("aria-activedescendant")).toMatch(/-option-0$/);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(option("Ada"));
  });

  it("does not show one search's answer after the search itself changes", async () => {
    const members = controlledSearch();
    const accounts = controlledSearch();
    const { rerender } = render(<Harness search={members.search} />);
    openPicker();
    await settle();
    await act(async () => members.calls[0].resolve({ options: [option("Ada")], more: false }));
    rerender(<Harness search={accounts.search} />);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await settle();
    expect(accounts.calls.map((c) => c.query)).toEqual([""]);
  });
});
