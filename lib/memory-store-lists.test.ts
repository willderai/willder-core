// The store list query the Explore page sends and GET /api/memory/stores accepts:
// absent `list` means the overview, defaults fill what is left out, and a value a
// list does not offer is refused with the accepted ones named.
import { describe, expect, it } from "vitest";
import { parseStoreListQuery } from "./memory-store-lists";

const parse = (query: string) => parseStoreListQuery(new URLSearchParams(query));

describe("parseStoreListQuery", () => {
  it("reads no list as the overview", () => {
    expect(parse("scope=org_1.sales")).toBeNull();
  });

  it("fills each list's default order, newest first, page 1, no search or filter", () => {
    expect(parse("list=records")).toEqual({
      list: "records",
      search: "",
      sort: "updated",
      order: "desc",
      filter: null,
      page: 1,
    });
    expect(parse("list=files&q=%20deck%20&type=gdrive&sort=chunks&order=asc&page=3")).toEqual({
      list: "files",
      search: "deck",
      sort: "chunks",
      order: "asc",
      filter: "gdrive",
      page: 3,
    });
  });

  it("reads each list's own filter parameter and no other", () => {
    expect(parse("list=chunks&version=superseded")).toMatchObject({ filter: "superseded" });
    expect(parse("list=chunks&kind=brief")).toMatchObject({ filter: null });
  });

  it("refuses an order or filter value from another list", () => {
    expect(parse("list=records&sort=chunks")).toEqual({ error: "sort must be one of updated, title for records" });
    expect(parse("list=files&type=contact")).toEqual({
      error: "type must be one of gdrive, website, slack, figma, posthog, github for files",
    });
  });
});
