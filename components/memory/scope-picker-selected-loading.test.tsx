// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScopePicker } from "./scope-picker";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps a deep-linked scope visible while scope names are still loading", async () => {
  let finishLoading: (response: Response) => void = () => {};
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finishLoading = resolve;
        }),
    ),
  );
  const onChange = vi.fn();
  const selected = "org_test.engineering_abcdef.release_operations_123456";
  render(<ScopePicker selected={selected} onChange={onChange} />);

  expect(screen.getByRole("status", { name: "Loading scopes" }).textContent).toBe(selected);
  expect(screen.queryByText("Org root")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();

  finishLoading(
    new Response(
      JSON.stringify({
        scopes: [
          { id: "root", path: "org_test", name: "Organization" },
          { id: "engineering", path: "org_test.engineering_abcdef", name: "Engineering" },
          { id: "releases", path: selected, name: "Release operations" },
        ],
      }),
      { status: 200 },
    ),
  );

  const trigger = await screen.findByRole("button", { name: /Org root.*Engineering.*Release operations/ });
  expect(trigger.title).toBe(selected);
  expect(screen.queryByRole("status", { name: "Loading scopes" })).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
