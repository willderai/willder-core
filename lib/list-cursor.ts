/**
 * A keyset cursor for a list ordered by time: the `(at, id)` of the last row a page
 * returned, so the next page starts strictly after it. Unlike an OFFSET, a cursor
 * never skips or repeats a row when new rows arrive while someone reads, and its
 * cost does not grow with how far down the list they are.
 *
 * The one rule: a cursor the route did not issue is refused, never guessed at. It
 * travels as `<ISO time>_<id>`; the time must parse and the id must look like a row id.
 */

/** The last row a page returned: its timestamp and its id, the tie-break. */
export type ListCursor = { at: Date; id: string };

/** A row id as the tables these lists read issue them (cuid, or a seeded slug). */
const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `{ at, id }` as the query parameter a route reads back with `parseListCursor`. */
export function encodeListCursor(cursor: ListCursor): string {
  return `${cursor.at.toISOString()}_${cursor.id}`;
}

/** Reads a cursor parameter; null when absent, `{ error }` naming the fix when malformed. */
export function parseListCursor(value: string | null): ListCursor | { error: string } | null {
  if (value === null) return null;
  const split = value.indexOf("_");
  const at = new Date(split > 0 ? value.slice(0, split) : Number.NaN);
  const id = value.slice(split + 1);
  if (split <= 0 || Number.isNaN(at.getTime()) || !CURSOR_ID.test(id)) {
    return { error: "cursor must be the nextCursor a previous page returned" };
  }
  return { at, id };
}
