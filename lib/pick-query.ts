/**
 * The query behind a type-to-search picker: `?limit=N&q=text` on a list route returns
 * the first N rows whose name matches, ordered by name, and whether more match.
 *
 * The one rule: a picker never loads a whole table. It asks for one short page of
 * matches and tells the person to keep typing when there are more, so an org with
 * ten rows and one with ten thousand get the same small response. A route without
 * `limit` keeps its existing whole-list answer for the callers that need it.
 */
import { readSearchParam } from "./list-search";

/** Matches a picker shows at once. */
export const PICK_LIMIT = 20;

/** The most matches one picker request may ask for. */
export const MAX_PICK_LIMIT = 50;

export type PickQuery = { search: string; limit: number };

/**
 * The pick query a route reads from its URL: null when the request carries no
 * `limit` (an ordinary list request), or the reason it is refused.
 */
export function readPickQuery(params: URLSearchParams): PickQuery | { error: string } | null {
  const limitText = params.get("limit");
  if (limitText === null) return null;
  const limit = Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PICK_LIMIT) {
    return { error: `limit must be a whole number from 1 to ${MAX_PICK_LIMIT}` };
  }
  const searched = readSearchParam(params);
  if ("error" in searched) return searched;
  return { search: searched.search, limit };
}

/**
 * One picker page from rows read with `take: limit + 1`: the first `limit`, and
 * whether the extra row existed.
 */
export function pickPage<T>(rows: T[], limit: number): { rows: T[]; more: boolean } {
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}
