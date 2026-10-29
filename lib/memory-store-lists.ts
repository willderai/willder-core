/**
 * The query a page of one memory store accepts (GET /api/memory/stores?list=): which
 * store, the search text, one filter, the order and the page. It is shared by the
 * route, which validates a request against it, and the Explore page, which builds
 * requests from it, so the two can never offer different orders or filter values.
 *
 * The one rule: only the values listed here reach a query. A sort key or filter value
 * outside them is refused with a message naming the accepted values, never passed on.
 */
import { readSearchParam } from "./list-search";

export const STORE_LISTS = ["records", "briefs", "rules", "notes", "chunks", "files"] as const;
export type StoreList = (typeof STORE_LISTS)[number];

/** The orders each store offers; the first is the default. */
export const STORE_LIST_SORTS = {
  records: ["updated", "title"],
  briefs: ["created", "title"],
  rules: ["created", "subject"],
  notes: ["created"],
  chunks: ["created"],
  files: ["synced", "name", "chunks"],
} as const satisfies Record<StoreList, readonly string[]>;

/** The one filter each store offers: its query parameter and accepted values. */
export const STORE_LIST_FILTERS = {
  records: { param: "kind", values: ["source", "contact"] },
  briefs: { param: "type", values: ["handoff", "architecture_plan", "qa_review"] },
  rules: { param: "kind", values: ["convention", "decision"] },
  notes: { param: "kind", values: ["claim", "intent", "status", "question"] },
  chunks: { param: "version", values: ["current", "superseded"] },
  files: { param: "type", values: ["gdrive", "website", "slack", "figma", "posthog", "github"] },
} as const satisfies Record<StoreList, { param: string; values: readonly string[] }>;

/** Rows per page of every store. */
export const STORE_PAGE_SIZE = 50;

/** Highest page number a store list accepts: far past any real store, and well inside an OFFSET Postgres can take. */
export const MAX_STORE_PAGE = 100_000;

export type StoreListQuery = {
  list: StoreList;
  /** Case-insensitive literal text; empty for no search. */
  search: string;
  /** One of STORE_LIST_SORTS[list]. */
  sort: string;
  order: "asc" | "desc";
  /** One of STORE_LIST_FILTERS[list].values, or null for no filter. */
  filter: string | null;
  /** 1-based. */
  page: number;
};

/**
 * Reads a store list request from its query string. Returns null when `list` is
 * absent (the caller wants the overview), and `{ error }` naming the fix when a
 * parameter holds a value the list does not offer.
 */
export function parseStoreListQuery(params: URLSearchParams): StoreListQuery | { error: string } | null {
  const list = params.get("list");
  if (list === null) return null;
  if (!STORE_LISTS.includes(list as StoreList)) return { error: `list must be one of ${STORE_LISTS.join(", ")}` };
  const store = list as StoreList;

  const searched = readSearchParam(params);
  if ("error" in searched) return searched;
  const { search } = searched;
  const sorts: readonly string[] = STORE_LIST_SORTS[store];
  const sort = params.get("sort") ?? sorts[0];
  if (!sorts.includes(sort)) return { error: `sort must be one of ${sorts.join(", ")} for ${store}` };
  const order = params.get("order") ?? "desc";
  if (order !== "asc" && order !== "desc") return { error: "order must be asc or desc" };

  const { param, values } = STORE_LIST_FILTERS[store];
  const filter = params.get(param);
  if (filter !== null && !(values as readonly string[]).includes(filter)) {
    return { error: `${param} must be one of ${values.join(", ")} for ${store}` };
  }
  const pageText = params.get("page") ?? "1";
  const page = Number(pageText);
  if (!Number.isInteger(page) || page < 1 || page > MAX_STORE_PAGE) {
    return { error: `page must be a whole number from 1 to ${MAX_STORE_PAGE}` };
  }

  return { list: store, search, sort, order, filter, page };
}
