// The list rules on their own: what a search, a filter and an order keep, and
// how a view survives the round trip through a query string.
import { describe, expect, it } from "vitest";
import {
  applyListState,
  compareText,
  compareTime,
  defaultListState,
  isNarrowed,
  parseListState,
  showsListControls,
  writeListState,
  type ListConfig,
} from "./list-query";

type Row = { id: string; name: string; kind: "a" | "b"; at: string };

const rows: Row[] = [
  { id: "1", name: "beta", kind: "a", at: "2026-10-02T00:00:00Z" },
  { id: "2", name: "Alpha", kind: "b", at: "2026-10-03T00:00:00Z" },
  { id: "3", name: "gamma", kind: "a", at: "2026-10-01T00:00:00Z" },
  { id: "4", name: "alpha two", kind: "a", at: "2026-10-03T00:00:00Z" },
];

const config: ListConfig<Row> = {
  noun: { one: "row", many: "rows" },
  searchText: (r) => [r.name, r.id],
  sorts: [
    { key: "newest", label: "Created", compare: (a, b) => compareTime(a.at, b.at), defaultDirection: "desc" },
    { key: "name", label: "Name", compare: (a, b) => compareText(a.name, b.name) },
  ],
  filters: [
    {
      key: "kind",
      label: "Kind",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      matches: (r, v) => r.kind === v,
    },
  ],
  paramPrefix: "rows.",
};

const ids = (list: Row[]) => list.map((r) => r.id);

describe("parseListState and a link's search", () => {
  const config = {
    noun: { one: "row", many: "rows" },
    searchText: () => [],
    sorts: [{ key: "a", label: "A", compare: () => 0 }],
  };
  it("cuts the search to what a list route accepts and drops NUL", () => {
    expect(parseListState(new URLSearchParams(`q=${"a".repeat(120)}`), config).query).toBe("a".repeat(100));
    expect(parseListState(new URLSearchParams("q=ac%00me"), config).query).toBe("acme");
  });
});

describe("applyListState", () => {
  it("orders by the default sort in its default direction, ties keeping their incoming order", () => {
    expect(ids(applyListState(rows, config, defaultListState(config)))).toEqual(["2", "4", "1", "3"]);
  });

  it("keeps ties in incoming order when the direction is reversed too", () => {
    const state = { ...defaultListState(config), direction: "asc" as const };
    expect(ids(applyListState(rows, config, state))).toEqual(["3", "1", "2", "4"]);
  });

  it("searches case-insensitively across every search field", () => {
    const state = { ...defaultListState(config), query: "  ALPHA " };
    expect(ids(applyListState(rows, config, state))).toEqual(["2", "4"]);
    expect(ids(applyListState(rows, config, { ...state, query: "3" }))).toEqual(["3"]);
  });

  it("applies a filter and a search together", () => {
    const state = { ...defaultListState(config), query: "alpha", filters: { kind: "a" } };
    expect(ids(applyListState(rows, config, state))).toEqual(["4"]);
  });

  it("sorts names naturally and case-insensitively", () => {
    const state = { ...defaultListState(config), sort: "name", direction: "asc" as const };
    expect(applyListState(rows, config, state).map((r) => r.name)).toEqual(["Alpha", "alpha two", "beta", "gamma"]);
  });

  it("does not change the array it was given", () => {
    const copy = [...rows];
    applyListState(rows, config, { ...defaultListState(config), sort: "name" });
    expect(rows).toEqual(copy);
  });
});

describe("URL round trip", () => {
  it("leaves the defaults out of the URL and keeps parameters the list does not own", () => {
    const written = writeListState(new URLSearchParams("tab=x"), config, defaultListState(config));
    expect(written.toString()).toBe("tab=x");
  });

  it("writes a changed view under the list's prefix and reads it back unchanged", () => {
    const state = { query: "alpha", sort: "name", direction: "desc" as const, filters: { kind: "b" } };
    const written = writeListState(new URLSearchParams("tab=x"), config, state);
    expect(written.get("rows.q")).toBe("alpha");
    expect(written.get("rows.sort")).toBe("name");
    expect(written.get("rows.dir")).toBe("desc");
    expect(written.get("rows.kind")).toBe("b");
    expect(written.get("tab")).toBe("x");
    expect(parseListState(written, config)).toEqual(state);
  });

  it("drops a direction equal to the order's own default", () => {
    const state = { ...defaultListState(config), sort: "name", direction: "asc" as const };
    expect(writeListState(new URLSearchParams(), config, state).has("rows.dir")).toBe(false);
  });

  it("falls back to defaults for values the list does not offer", () => {
    const parsed = parseListState(new URLSearchParams("rows.sort=nope&rows.dir=sideways&rows.kind=z"), config);
    expect(parsed).toEqual(defaultListState(config));
  });

  it("ignores another list's parameters", () => {
    const parsed = parseListState(new URLSearchParams("q=other&sort=name"), config);
    expect(parsed).toEqual(defaultListState(config));
  });
});

describe("isNarrowed", () => {
  it("is true for a search or a filter, never for an order alone", () => {
    expect(isNarrowed(defaultListState(config))).toBe(false);
    expect(isNarrowed({ ...defaultListState(config), sort: "name", direction: "desc" })).toBe(false);
    expect(isNarrowed({ ...defaultListState(config), query: " " })).toBe(false);
    expect(isNarrowed({ ...defaultListState(config), query: "a" })).toBe(true);
    expect(isNarrowed({ ...defaultListState(config), filters: { kind: "a" } })).toBe(true);
  });
});

describe("showsListControls", () => {
  it("hides the controls over one row unless the view is narrowed, so a filtered link can still be cleared", () => {
    expect(showsListControls(0, defaultListState(config))).toBe(false);
    expect(showsListControls(1, defaultListState(config))).toBe(false);
    expect(showsListControls(2, defaultListState(config))).toBe(true);
    expect(showsListControls(1, { ...defaultListState(config), filters: { kind: "a" } })).toBe(true);
  });
});

describe("comparators", () => {
  it("compareText puts missing values last", () => {
    expect(["b", null, "a", ""].sort(compareText)).toEqual(["a", "b", null, ""]);
  });

  it("compareTime puts missing and invalid values first", () => {
    const values = ["2026-10-02T00:00:00Z", "not a date", null, "2026-10-01T00:00:00Z"];
    expect([...values].sort(compareTime)).toEqual(["not a date", null, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"]);
  });
});
