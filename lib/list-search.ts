/**
 * Search text for the paged lists, checked the same way on the server and the client.
 *
 * The one rule: a search the database cannot run is a bad request, never a server
 * error, and the screens never send one. A route refuses text longer than
 * `MAX_LIST_SEARCH_LENGTH` characters or holding NUL, which a Postgres text value
 * cannot hold; the list toolbar caps what can be typed, and `listSearchText` trims a
 * search from a link to what a route accepts.
 */

/** Longest search text a list route accepts. */
export const MAX_LIST_SEARCH_LENGTH = 100;

/** Search text as a screen sends it: NUL removed, trimmed, and cut to what a route accepts. */
export function listSearchText(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, MAX_LIST_SEARCH_LENGTH);
}

/** The search text a list route reads from `?q=`: trimmed, or the reason it is refused. */
export function readSearchParam(
  params: URLSearchParams,
  maxLength = MAX_LIST_SEARCH_LENGTH,
): { search: string } | { error: string } {
  const search = params.get("q")?.trim() ?? "";
  if (search.length > maxLength) return { error: `q must be at most ${maxLength} characters` };
  if (search.includes("\u0000")) return { error: "q must not contain a NUL character" };
  return { search };
}

/** The first query parameter whose value holds a NUL, which no query can be bound to, or null. */
export function paramHoldingNul(params: URLSearchParams): string | null {
  for (const [name, value] of params) if (value.includes("\u0000")) return name;
  return null;
}
