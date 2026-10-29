/**
 * The query a page of a server-paged list accepts (GET /api/access/grants?page=,
 * GET /api/access/capabilities?page=, and the Settings lists in lib/settings-lists.ts):
 * the search text, the filters, the order and the page. The route validates a
 * request against it and the screen builds requests from it, so the two can never
 * offer different orders or filter values.
 *
 * The one rule: only the values listed here reach a query. A sort key or filter
 * value outside them is refused with a message naming the accepted values.
 */
import { readSearchParam } from "./list-search";

/** Rows per page of both lists. */
export const ACCESS_PAGE_SIZE = 25;

/** Highest page number either list accepts: far past any real org, and an OFFSET Postgres takes easily. */
export const MAX_ACCESS_PAGE = 100_000;

/** A list's orders (the first is the default, with its default direction) and its filters. */
export type AccessListSpec = {
  sorts: readonly string[];
  defaultOrder: "asc" | "desc";
  filters: Readonly<Record<string, readonly string[]>>;
};

export const GRANT_LIST_SPEC = {
  sorts: ["created", "scope", "grantee", "expires"],
  defaultOrder: "desc",
  filters: {
    permission: ["read", "write", "admin"],
    grantee: ["user", "role", "agent", "everyone"],
    expiry: ["soon", "expired", "permanent"],
  },
} as const satisfies AccessListSpec;

export const TOKEN_LIST_SPEC = {
  sorts: ["created", "agent", "expires"],
  defaultOrder: "desc",
  filters: {
    status: ["active", "expired", "revoked", "deactivated"],
    permission: ["read", "write", "admin"],
  },
} as const satisfies AccessListSpec;

export type AccessListQuery<S extends AccessListSpec> = {
  /** Case-insensitive literal text; empty for no search. */
  search: string;
  sort: S["sorts"][number];
  order: "asc" | "desc";
  /** Each filter that is on, by its key. */
  filters: { [K in keyof S["filters"]]?: S["filters"][K] extends readonly (infer V)[] ? V : never };
  /** 1-based. */
  page: number;
};

export type GrantListQuery = AccessListQuery<typeof GRANT_LIST_SPEC>;
export type TokenListQuery = AccessListQuery<typeof TOKEN_LIST_SPEC>;

/**
 * Reads one page request from a query string. Returns null when `page` is absent
 * (the caller wants every row, as the pickers outside this page still do), and
 * `{ error }` naming the fix when a parameter holds a value the list does not offer.
 */
export function parseAccessListQuery<S extends AccessListSpec>(
  params: URLSearchParams,
  spec: S,
): AccessListQuery<S> | { error: string } | null {
  const pageText = params.get("page");
  if (pageText === null) return null;
  const page = Number(pageText);
  if (!Number.isInteger(page) || page < 1 || page > MAX_ACCESS_PAGE) {
    return { error: `page must be a whole number from 1 to ${MAX_ACCESS_PAGE}` };
  }
  const searched = readSearchParam(params);
  if ("error" in searched) return searched;

  const sorts: readonly string[] = spec.sorts;
  const sort = params.get("sort") ?? sorts[0];
  if (!sorts.includes(sort)) return { error: `sort must be one of ${sorts.join(", ")}` };
  const order = params.get("order") ?? spec.defaultOrder;
  if (order !== "asc" && order !== "desc") return { error: "order must be asc or desc" };

  const filters: Record<string, string> = {};
  for (const [key, values] of Object.entries(spec.filters) as [string, readonly string[]][]) {
    const value = params.get(key);
    if (value === null) continue;
    if (!values.includes(value)) return { error: `${key} must be one of ${values.join(", ")}` };
    filters[key] = value;
  }
  return { search: searched.search, sort, order, filters, page } as AccessListQuery<S>;
}

/** The request for one page, the inverse of `parseAccessListQuery`. */
export function accessListParams<S extends AccessListSpec>(q: AccessListQuery<S>): URLSearchParams {
  const params = new URLSearchParams({ page: String(q.page), sort: q.sort, order: q.order });
  if (q.search !== "") params.set("q", q.search);
  for (const [key, value] of Object.entries(q.filters)) if (value) params.set(key, value as string);
  return params;
}
