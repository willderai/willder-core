import { describe, expect, it } from "vitest";
import { MAX_PICK_LIMIT, pickPage, readPickQuery } from "./pick-query";

const read = (query: string) => readPickQuery(new URLSearchParams(query));

describe("readPickQuery", () => {
  it("is not a pick request without a limit", () => {
    expect(read("")).toBeNull();
    expect(read("q=ada")).toBeNull();
  });

  it("reads the limit and the trimmed search", () => {
    expect(read("limit=20&q=%20ada%20")).toEqual({ search: "ada", limit: 20 });
    expect(read("limit=1")).toEqual({ search: "", limit: 1 });
    expect(read(`limit=${MAX_PICK_LIMIT}`)).toEqual({ search: "", limit: MAX_PICK_LIMIT });
  });

  it.each(["0", "-1", "1.5", "abc", "", String(MAX_PICK_LIMIT + 1)])("refuses limit=%s", (limit) => {
    expect(read(`limit=${limit}`)).toEqual({ error: `limit must be a whole number from 1 to ${MAX_PICK_LIMIT}` });
  });

  it("refuses a search a route cannot run", () => {
    expect(read(`limit=5&q=${"a".repeat(101)}`)).toEqual({ error: "q must be at most 100 characters" });
    expect(read("limit=5&q=a%00b")).toEqual({ error: "q must not contain a NUL character" });
  });
});

describe("pickPage", () => {
  it("keeps the first `limit` rows and reports whether the extra one was read", () => {
    expect(pickPage([1, 2, 3], 2)).toEqual({ rows: [1, 2], more: true });
    expect(pickPage([1, 2], 2)).toEqual({ rows: [1, 2], more: false });
    expect(pickPage([], 2)).toEqual({ rows: [], more: false });
  });
});
