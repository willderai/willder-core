// @vitest-environment jsdom
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const navigation = vi.hoisted(() => ({ query: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.query),
  useRouter: () => ({ replace: navigation.replace }),
}));
vi.mock("@/components/reveal", () => ({ Reveal: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("@/components/memory/scope-picker", () => ({
  ScopePicker: ({ selected, onChange }: { selected: string | null; onChange: (scope: string | null) => void }) => (
    <button onClick={() => onChange("org.support")}>Scope: {selected ?? "root"}</button>
  ),
}));
vi.mock("@/components/audit/audit-log", () => ({
  AuditLog: ({ scope }: { scope: string | null }) => <p>Access log for {scope ?? "root"}</p>,
}));
vi.mock("@/components/audit/timeline", () => ({
  AuditTimeline: ({ scope }: { scope: string | null }) => <p>Timeline for {scope ?? "root"}</p>,
}));
vi.mock("@/components/audit/session-starts", () => ({
  SessionStarts: ({ scope }: { scope: string | null }) => <p>Session starts for {scope ?? "root"}</p>,
}));

import AuditPage from "./page";

beforeEach(() => {
  navigation.query = "";
  navigation.replace.mockClear();
});

describe("AuditPage — shareable view and scope", () => {
  it("opens a source scope directly in the timeline", () => {
    navigation.query = "view=timeline&scope=org.product";
    render(<AuditPage />);
    expect(screen.getByText("Timeline for org.product")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scope: org.product" })).toBeTruthy();
    expect(screen.queryByText("Access log for org.product")).toBeNull();
  });

  it("keeps scope in the URL when switching views", () => {
    navigation.query = "view=timeline&scope=org.product";
    render(<AuditPage />);
    fireEvent.click(screen.getByRole("button", { name: "Access log" }));
    expect(navigation.replace).toHaveBeenCalledWith("/audit?view=table&scope=org.product", { scroll: false });
  });

  it("keeps the timeline selected when changing scope", () => {
    navigation.query = "view=timeline&scope=org.product";
    render(<AuditPage />);
    fireEvent.click(screen.getByRole("button", { name: "Scope: org.product" }));
    expect(navigation.replace).toHaveBeenCalledWith("/audit?view=timeline&scope=org.support", { scroll: false });
  });

  it("opens a new scope's lists on page 1, clearing their pages before they remount", () => {
    navigation.query = "view=table&scope=org.product&page=3&sessions.page=2&decision=deny";
    window.history.replaceState(null, "", `/audit?${navigation.query}`);
    render(<AuditPage />);
    fireEvent.click(screen.getByRole("button", { name: "Scope: org.product" }));
    const now = new URLSearchParams(window.location.search);
    expect([now.get("page"), now.get("sessions.page"), now.get("decision")]).toEqual([null, null, "deny"]);
    expect(navigation.replace).toHaveBeenCalledWith("/audit?view=table&scope=org.support&decision=deny", {
      scroll: false,
    });
    window.history.replaceState(null, "", "/");
  });

  it("responds to URL navigation and defaults unknown views to the access log", () => {
    navigation.query = "view=timeline&scope=org.product";
    const { rerender } = render(<AuditPage />);
    navigation.query = "view=unknown&scope=org.support";
    rerender(<AuditPage />);
    expect(screen.getByText("Access log for org.support")).toBeTruthy();
    expect(screen.queryByText("Timeline for org.product")).toBeNull();
  });

  it("opens the session starts view from the URL, with its scope", () => {
    navigation.query = "view=sessions&scope=org.product";
    render(<AuditPage />);
    expect(screen.getByText("Session starts for org.product")).toBeTruthy();
    expect(screen.queryByText("Access log for org.product")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Scope: org.product" }));
    expect(navigation.replace).toHaveBeenCalledWith("/audit?view=sessions&scope=org.support", { scroll: false });
  });
});
