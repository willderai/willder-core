import { describe, expect, it } from "vitest";
import {
  accessListParams,
  GRANT_LIST_SPEC,
  TOKEN_LIST_SPEC,
  parseAccessListQuery,
  type GrantListQuery,
} from "./access-lists";

const parse = (qs: string, spec: typeof GRANT_LIST_SPEC | typeof TOKEN_LIST_SPEC = GRANT_LIST_SPEC) =>
  parseAccessListQuery(new URLSearchParams(qs), spec);

describe("parseAccessListQuery", () => {
  it("reads no page as a request for every row, the shape the pickers outside the Access page use", () => {
    expect(parse("")).toBeNull();
    expect(parse("q=sales&sort=scope")).toBeNull();
  });

  it("fills the defaults: newest first, no search, no filter", () => {
    expect(parse("page=1")).toEqual({ search: "", sort: "created", order: "desc", filters: {}, page: 1 });
  });

  it("reads the search, the order and each list's own filters", () => {
    expect(parse("page=3&q=%20maya%20&sort=grantee&order=asc&permission=write&expiry=soon")).toEqual({
      search: "maya",
      sort: "grantee",
      order: "asc",
      filters: { permission: "write", expiry: "soon" },
      page: 3,
    });
    expect(parse("page=1&status=deactivated", TOKEN_LIST_SPEC)).toMatchObject({ filters: { status: "deactivated" } });
  });

  it("refuses a value the list does not offer, naming the accepted ones", () => {
    expect(parse("page=0")).toEqual({ error: "page must be a whole number from 1 to 100000" });
    expect(parse("page=1.5")).toMatchObject({ error: expect.stringContaining("whole number") });
    expect(parse("page=1&sort=agent")).toEqual({ error: "sort must be one of created, scope, grantee, expires" });
    expect(parse("page=1&order=up")).toEqual({ error: "order must be asc or desc" });
    expect(parse("page=1&status=active")).toEqual({ page: 1, search: "", sort: "created", order: "desc", filters: {} });
    expect(parse("page=1&status=paused", TOKEN_LIST_SPEC)).toEqual({
      error: "status must be one of active, expired, revoked, deactivated",
    });
    expect(parse(`page=1&q=${"x".repeat(101)}`)).toEqual({ error: "q must be at most 100 characters" });
  });

  it("round-trips through accessListParams", () => {
    const query: GrantListQuery = {
      search: "a b",
      sort: "expires",
      order: "asc",
      filters: { grantee: "agent" },
      page: 2,
    };
    expect(parseAccessListQuery(accessListParams(query), GRANT_LIST_SPEC)).toEqual(query);
  });
});
