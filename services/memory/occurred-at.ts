// When a write's content happened, as its writer states it (memory_ingest `occurredAt`).
//
// A write is stored when it arrives, but what it says may have happened earlier: a
// meeting note filed the next day, a chat imported a month later. Reads date the note
// by this event time and break ties by it (the newest version of a fact first), so it
// has to be an instant the server can trust to compare.
//
// The rule this file enforces: an event time is accepted only as an ISO-8601 calendar
// date (read as midnight UTC) or a date-time with an explicit offset, naming a day the
// calendar has, and never later than the server's clock plus a small allowance for clock
// skew. A write that states none is dated by when it was stored.

/** How far ahead of the server's clock a stated event time may be: a writer's clock can run fast. */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** A stated event time the server refuses; its message names what to send instead. */
export class InvalidOccurredAtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOccurredAtError";
  }
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

const ACCEPTED_FORMS =
  "an ISO-8601 date (2026-03-11) or date-time with an offset (2026-03-11T15:10:00Z or 2026-03-11T08:10:00-07:00)";

/**
 * Parse a stated event time against `now`, returning it as a UTC ISO-8601 string.
 *
 * @throws InvalidOccurredAtError when the value is not one of the accepted forms, names a
 *   day or time the calendar does not have, or lies further ahead of `now` than
 *   {@link MAX_CLOCK_SKEW_MS}.
 */
export function parseOccurredAt(value: string, now: Date = new Date()): string {
  const fields = CALENDAR_DATE.exec(value) ?? DATE_TIME.exec(value);
  if (!fields || !namesRealMoment(fields)) {
    throw new InvalidOccurredAtError(`occurredAt must be ${ACCEPTED_FORMS}; got ${JSON.stringify(value)}.`);
  }
  const at = new Date(fields.length === 4 ? `${value}T00:00:00Z` : value);
  if (at.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw new InvalidOccurredAtError(
      `occurredAt ${value} is in the future: it is after the server's clock (${now.toISOString()}). Send when the content happened, not when it is due.`,
    );
  }
  return at.toISOString();
}

/** Whether the matched year, month, day, hour, minute, second and offset name a moment the calendar has. */
function namesRealMoment(fields: RegExpExecArray): boolean {
  const [, year, month, day, hour = "0", minute = "0", second = "0", offsetHours = "0", offsetMinutes = "0"] = fields;
  const y = Number(year);
  const m = Number(month);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return (
    m >= 1 &&
    m <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= daysInMonth &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    Number(offsetHours) <= 23 &&
    Number(offsetMinutes) <= 59
  );
}
