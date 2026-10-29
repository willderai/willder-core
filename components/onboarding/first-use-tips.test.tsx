import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FirstUseTips } from "./first-use-tips";

const STORAGE_KEY = "willder:tips:dismissed";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("first-use guidance dismissal", () => {
  it("stays dismissed when returning to memory", () => {
    const firstVisit = render(<FirstUseTips />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss tips" }));
    expect(screen.queryByRole("region")).toBeNull();
    firstVisit.unmount();

    render(<FirstUseTips />);
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("respects a dismissal from another tab", () => {
    render(<FirstUseTips />);
    expect(screen.getByRole("region")).toBeTruthy();
    localStorage.setItem(STORAGE_KEY, "1");
    fireEvent(window, new StorageEvent("storage", { key: STORAGE_KEY, newValue: "1" }));
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("still lets the user dismiss when browser storage cannot be written", () => {
    render(<FirstUseTips />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss tips" }));
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("does not interrupt memory when browser storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage blocked");
    });
    render(<FirstUseTips />);
    expect(screen.queryByRole("region")).toBeNull();
  });
});
