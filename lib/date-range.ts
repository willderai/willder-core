/**
 * The date filter on the time-ordered lists, read the same way on the server and the client.
 *
 * The one rule: a range is `from` inclusive and `to` exclusive, as instants. A person picks
 * days in their own time zone (the lists show times in it too), so the screen turns each day
 * into the instant it starts there and sends that; the route never guesses a zone. A day the
 * person picked as "through" is inclusive, so the request's `to` is the start of the day after.
 */
import { parseInstant } from "@/services/audit/export";

/** The days a list is narrowed to, as `YYYY-MM-DD` in the viewer's time zone; null is open-ended. */
export type DayRange = { fromDay: string | null; throughDay: string | null };

export const NO_DAY_RANGE: DayRange = { fromDay: null, throughDay: null };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local midnight a `YYYY-MM-DD` day starts at, `offset` days later; null for a day that does not exist. */
function localDayStart(day: string, offset = 0): Date | null {
  const match = DAY.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const start = new Date(year, month, date);
  if (start.getFullYear() !== year || start.getMonth() !== month || start.getDate() !== date) return null;
  return offset === 0 ? start : new Date(year, month, date + offset);
}

/**
 * The range a link holds. A day that does not exist reads as open-ended, and a range whose
 * first day is after its last reads as no range at all, so a hand-edited link never asks for
 * a range the route refuses.
 */
export function readDayRange(fromParam: string | null, throughParam: string | null): DayRange {
  const fromDay = fromParam !== null && localDayStart(fromParam) ? fromParam : null;
  const throughDay = throughParam !== null && localDayStart(throughParam) ? throughParam : null;
  if (fromDay && throughDay && fromDay > throughDay) return NO_DAY_RANGE;
  return { fromDay, throughDay };
}

/** Whether the range narrows the list at all. */
export function isDayRangeSet(range: DayRange): boolean {
  return range.fromDay !== null || range.throughDay !== null;
}

/** Adds the range to a list request as `from` and `to` instants; an open end adds nothing. */
export function setDayRangeParams(params: URLSearchParams, range: DayRange): void {
  const from = range.fromDay ? localDayStart(range.fromDay) : null;
  const to = range.throughDay ? localDayStart(range.throughDay, 1) : null;
  if (from) params.set("from", from.toISOString());
  if (to) params.set("to", to.toISOString());
}

/** A list route's time bounds; either end may be open. */
export type TimeRange = { from: Date | null; to: Date | null };

/**
 * The last instant with a four-digit year. A bound that parses can still land past it once its
 * offset is applied (9999-12-31T23:00:00-05:00 is 10000-01-01T04:00:00Z); that instant reaches
 * Postgres as `+010000-01-01T04:00:00.000Z`, which it refuses and fails the whole query, so the
 * route refuses the bound first.
 */
const LAST_STORABLE_INSTANT = new Date("9999-12-31T23:59:59.999Z");

/**
 * Reads `from` and `to` from a list route's query: each optional, an ISO date or a timestamp
 * with an explicit zone. A value that is neither, one past {@link LAST_STORABLE_INSTANT}, or a
 * `from` not before `to`, is refused.
 */
export function readTimeRangeParams(params: URLSearchParams): TimeRange | { error: string } {
  const bounds: TimeRange = { from: null, to: null };
  for (const name of ["from", "to"] as const) {
    const value = params.get(name);
    if (value === null) continue;
    const at = parseInstant(value);
    if (!at) return { error: `${name} must be an ISO 8601 date or a timestamp with a zone, e.g. 2026-10-01T07:00:00Z` };
    if (at > LAST_STORABLE_INSTANT)
      return { error: `${name} must be no later than ${LAST_STORABLE_INSTANT.toISOString()}` };
    bounds[name] = at;
  }
  if (bounds.from && bounds.to && bounds.from >= bounds.to) return { error: "from must be earlier than to" };
  return bounds;
}
