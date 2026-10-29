// SearchPicker's stale-answer handling. The main suite proves a
// late answer to an earlier search is dropped once the newer one has arrived; these
// cover the two windows it leaves open: the gap between a keystroke and its answer,
// where the previous text's matches must not stay pickable, and a late failure of an
// aborted search, which must not replace the answer on screen.
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { SearchPicker, type PickOption, type PickResult, type PickSearch } from "./search-picker";

function controlledSearch() {
  const calls: { query: string; signal: AbortSignal; resolve: (r: PickResult) => void; reject: () => void }[] = [];
  const search: PickSearch = (query, signal) =>
    new Promise<PickResult>((resolve, reject) =>
      calls.push({ query, signal, resolve, reject: () => reject(new Error("aborted")) }),
    );
  return { search, calls };
}

const option = (name: string): PickOption => ({ value: `id-${name}`, label: name });

function Harness({ search, onPick }: { search: PickSearch; onPick: (o: PickOption) => void }) {
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

describe("SearchPicker stale answers (QA)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops offering the previous text's matches as soon as the text changes", async () => {
    const { search, calls } = controlledSearch();
    const onPick = vi.fn();
    render(<Harness search={search} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /Member/ }));
    await settle();
    await act(async () => calls[0].resolve({ options: [option("Ada"), option("Bea")], more: false }));

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "bea" } });
    await settle();
    // The "bea" request is out and unanswered: nothing from the empty search is pickable.
    expect(calls.map((c) => c.query)).toEqual(["", "bea"]);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("Searching…");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps the current answer when an aborted search fails after it", async () => {
    const { search, calls } = controlledSearch();
    render(<Harness search={search} onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Member/ }));
    await settle();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "bea" } });
    await settle();
    expect(calls[0].signal.aborted).toBe(true);

    await act(async () => calls[1].resolve({ options: [option("Bea")], more: false }));
    await act(async () => calls[0].reject());
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Bea"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Searching…")).toBeNull();
  });
});
