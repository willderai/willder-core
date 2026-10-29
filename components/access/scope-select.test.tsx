import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ScopeSelect, scopeTreeRows, type ScopeOption } from "./scope-select";

// An org shaped like a real one: a root, five teams, children under each and
// a third level under one. Two scopes share the name "notes" under different
// parents, which a flat list of names cannot tell apart. Sorted by path, the
// way GET /api/access/scopes returns them.
const TEAMS: Array<[string, string, string[]]> = [
  ["crew_1c5b79", "crew", ["atlas_36c2d6", "orbit_a1", "notes_c1", "routines_c2"]],
  ["dept_eng", "Engineering", ["platform", "mobile", "web", "infra", "notes_e1"]],
  ["dept_sales", "Sales", ["emea", "apac", "americas", "partners"]],
  ["dept_research", "Research", ["papers", "evals", "datasets"]],
  ["dept_ops", "Operations", ["finance", "legal", "hiring"]],
];

function fixture(): ScopeOption[] {
  const scopes: ScopeOption[] = [{ id: "s-root", path: "org_1", name: "Organization" }];
  for (const [team, teamName, kids] of TEAMS) {
    scopes.push({ id: `s-${team}`, path: `org_1.${team}`, name: teamName });
    for (const kid of kids) {
      const name = kid.startsWith("notes") ? "notes" : kid.replace(/_[0-9a-f]+$|_[a-z]\d$/, "");
      scopes.push({ id: `s-${kid}`, path: `org_1.${team}.${kid}`, name });
    }
  }
  scopes.push(
    { id: "s-p1", path: "org_1.dept_eng.platform.api", name: "api" },
    { id: "s-p2", path: "org_1.dept_eng.platform.workers", name: "workers" },
  );
  return scopes.sort((a, b) => a.path.localeCompare(b.path));
}

const ATLAS = "org_1.crew_1c5b79.atlas_36c2d6";

function Harness({ emptyLabel, onChange }: { emptyLabel?: string; onChange: (path: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <ScopeSelect
      label="Scope"
      scopes={fixture()}
      emptyLabel={emptyLabel}
      value={value}
      onChange={(path) => {
        setValue(path);
        onChange(path);
      }}
    />
  );
}

function openList() {
  fireEvent.click(screen.getByRole("button", { name: /^Scope:/ }));
  return screen.getByRole("listbox", { name: "Scope" });
}

describe("ScopeSelect", () => {
  it("has more than 25 scopes to pick from", () => {
    expect(fixture().length).toBeGreaterThanOrEqual(25);
  });

  it("lists each scope under its parent, not beside it", () => {
    render(<Harness onChange={() => {}} />);
    const list = openList();
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(fixture().length);

    const crew = within(list).getByRole("option", { name: "crew, in Organization" });
    const atlas = within(list).getByRole("option", { name: "atlas, in Organization › crew" });
    expect(crew.getAttribute("data-depth")).toBe("1");
    expect(atlas.getAttribute("data-depth")).toBe("2");
    // atlas sits inside its parent's run of children, before the next team.
    const index = (el: HTMLElement) => options.indexOf(el);
    const engineering = within(list).getByRole("option", { name: "Engineering, in Organization" });
    expect(index(crew)).toBeLessThan(index(atlas));
    expect(index(atlas)).toBeLessThan(index(engineering));
    expect(
      within(list)
        .getByRole("option", { name: "api, in Organization › Engineering › platform" })
        .getAttribute("data-depth"),
    ).toBe("3");
  });

  it("narrows to the scopes that match what is typed, each named with its parents", () => {
    render(<Harness onChange={() => {}} />);
    openList();
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "atlas" } });

    const options = within(screen.getByRole("listbox", { name: "Scope" })).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-label"))).toEqual(["atlas, in Organization › crew"]);
    expect(screen.getByText("Organization › crew")).toBeTruthy();
  });

  it("tells two scopes with one name apart by their parents", () => {
    render(<Harness onChange={() => {}} />);
    openList();
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "notes" } });

    const options = within(screen.getByRole("listbox", { name: "Scope" })).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-label"))).toEqual([
      "notes, in Organization › crew",
      "notes, in Organization › Engineering",
    ]);
  });

  it("matches a parent's name, so typing a team lists what is inside it", () => {
    render(<Harness onChange={() => {}} />);
    openList();
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "crew" } });

    expect(within(screen.getByRole("listbox", { name: "Scope" })).getAllByRole("option")).toHaveLength(5);
  });

  it("matches a parent's display name even when its path label differs", () => {
    render(<Harness onChange={() => {}} />);
    openList();
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "engineering" } });

    // Engineering's path label is dept_eng, so only the name trail can match its
    // children: itself, five children, and the two under platform.
    expect(within(screen.getByRole("listbox", { name: "Scope" })).getAllByRole("option")).toHaveLength(8);
  });

  it("matches a scope by a segment of its path", () => {
    render(<Harness onChange={() => {}} />);
    openList();
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "36c2d6" } });

    const options = within(screen.getByRole("listbox", { name: "Scope" })).getAllByRole("option");
    expect(options.map((o) => o.getAttribute("aria-label"))).toEqual(["atlas, in Organization › crew"]);
  });

  it("keeps Enter in the filter from submitting the surrounding form", () => {
    const onSubmit = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <Harness onChange={() => {}} />
      </form>,
    );
    openList();
    const input = screen.getByRole("combobox", { name: "Search scope" });
    fireEvent.change(input, { target: { value: "atlas" } });

    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
  });

  it("picks from the keyboard and reports the full scope path", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole("button", { name: "Scope: Choose a scope" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const input = screen.getByRole("combobox", { name: "Search scope" });
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "atlas" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(ATLAS);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Scope: Organization › crew › atlas" })).toBe(document.activeElement);
  });

  it("moves through the list with the arrow keys and closes on Escape without choosing", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    openList();
    const input = screen.getByRole("combobox", { name: "Search scope" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(
      within(screen.getByRole("listbox")).getByRole("option", { name: "crew, in Organization" }).id,
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("says so when nothing matches", () => {
    render(<Harness onChange={() => {}} />);
    openList();
    fireEvent.change(screen.getByRole("combobox", { name: "Search scope" }), { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No scopes match “zzz”.")).toBeTruthy();
  });

  it("offers an empty choice in place of the org root, and nests the teams under it", () => {
    const onChange = vi.fn();
    render(<Harness emptyLabel="Org root" onChange={onChange} />);
    const list = openList();
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(fixture().length);
    expect(options[0].getAttribute("aria-label")).toBe("Org root");
    expect(within(list).queryByRole("option", { name: "Organization" })).toBeNull();
    expect(within(list).getByRole("option", { name: "atlas, in Org root › crew" }).getAttribute("data-depth")).toBe(
      "2",
    );

    fireEvent.click(options[0]);
    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("scopeTreeRows", () => {
  it("nests a scope under its nearest listed ancestor when its parent is absent", () => {
    const rows = scopeTreeRows([
      { id: "a", path: "org_1", name: "Organization" },
      { id: "b", path: "org_1.team.child", name: "child" },
    ]);
    expect(rows.map((r) => [r.name, r.depth])).toEqual([
      ["Organization", 0],
      ["child", 1],
    ]);
  });
  it("orders siblings by name, not by path", () => {
    const rows = scopeTreeRows([
      { id: "a", path: "org_1", name: "Organization" },
      { id: "b", path: "org_1.a_team", name: "Zebra" },
      { id: "c", path: "org_1.z_team", name: "Alpha" },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Organization", "Alpha", "Zebra"]);
  });
});
