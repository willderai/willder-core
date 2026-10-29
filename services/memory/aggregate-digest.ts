// The aggregate digest: how memory_query lays out the page for a question whose answer is spread
// over many records ("how many", "in total", "list all"), behind RETRIEVAL_AGGREGATE_DIGEST.
//
// An agent asked to count, total or compare has to find every relevant record, tell a new event
// from a restatement of one it already counted, and keep track of when each happened. A ranked
// list of excerpts makes all three harder: the same conversation's records sit wherever their
// scores put them, a fact said three times reads as three facts, and each line repeats its own
// date. The digest serves the same guarded read as the compact aggregate page
// (query-shapes.ts, `compactAggregatePage`), chosen a little differently and laid out as a
// timeline:
//
// - picked for counting: from each record, the sentences that share the question's topic,
//   matched on its terms that most candidates do not hold (`SnippetPolicy.informativeTerms`),
//   the user's first-person statements and quantities first and bare questions last
//   (`statementsFirst`); then the user's other first-person statements of a quantity
//   (`statedQuantities`); a sentence restating one already served for the same day is left out
//   (`restatementsOnce`); and the read is asked wider, since these lines are short;
// - laid out by day: one heading per day, oldest first, each naming its weekday and how many
//   records it holds, under a header naming the span the page covers.
//
// The one rule this file enforces: with the flag off, `aggregateDigestOfQuery` answers false and
// memory_query serves what it served before. Like query-shapes.ts, nothing here reads a store
// or calls a model: it orders and labels facts a guarded read already returned, and every
// fact keeps its own citation line.

import type { MemoryFact } from "@/types/memory";
import { isAggregateQuestion, recordDate, type SnippetPolicy } from "./query-shapes";

/** The flag. Not a secret: a plain variable, off by default. */
export const RETRIEVAL_AGGREGATE_DIGEST_FLAG = "RETRIEVAL_AGGREGATE_DIGEST";

/** True when RETRIEVAL_AGGREGATE_DIGEST is 1, true, on or yes. */
export function aggregateDigestEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = env[RETRIEVAL_AGGREGATE_DIGEST_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

/** Whether memory_query serves `query` as a digest: the flag is on and the question is an aggregate one. */
export function aggregateDigestOfQuery(
  query: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return aggregateDigestEnabled(env) && isAggregateQuestion(query);
}

/** How the digest picks its sentences (query-shapes.ts, SnippetPolicy). */
export const DIGEST_SNIPPET_POLICY: Readonly<SnippetPolicy> = {
  statementsFirst: true,
  statedQuantities: true,
  restatementsOnce: true,
  informativeTerms: true,
  inflections: true,
};

/** How much wider than its page a digest read is asked: its lines are short, so more records fit. */
export const DIGEST_WIDEN = 8;

/** One day of the digest: its date (YYYY-MM-DD, or null for records with no date) and its facts, in served order. */
export interface DigestDay {
  day: string | null;
  facts: MemoryFact[];
}

/** The day a record happened (YYYY-MM-DD), from its date line or stored date; null when it has neither. */
export function dayOf(fact: MemoryFact): string | null {
  return recordDate(fact)?.slice(0, 10) ?? null;
}

/** `facts` by the day each happened, oldest day first and undated records last; within a day, in the order given. */
export function digestDays(facts: readonly MemoryFact[]): DigestDay[] {
  const byDay = new Map<string | null, MemoryFact[]>();
  for (const fact of facts) {
    const day = dayOf(fact);
    byDay.set(day, [...(byDay.get(day) ?? []), fact]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1))
    .map(([day, dayFacts]) => ({ day, facts: dayFacts }));
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The weekday of a YYYY-MM-DD date, or null when it is not one. */
export function weekdayOf(day: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(date.getTime()) ? null : WEEKDAYS[date.getUTCDay()]!;
}

const records = (n: number) => `${n} record${n === 1 ? "" : "s"}`;

/** A day's heading: "2023-05-21 (Sun), 3 records:", or "Undated, 1 record:". */
export function dayHeading(day: DigestDay): string {
  if (day.day === null) return `Undated, ${records(day.facts.length)}:`;
  const weekday = weekdayOf(day.day);
  return `${day.day}${weekday ? ` (${weekday})` : ""}, ${records(day.facts.length)}:`;
}

/** The line above the days: what the page holds and how it is laid out. */
export function digestHeader(days: readonly DigestDay[]): string {
  const dated = days.filter((d) => d.day !== null).map((d) => d.day!);
  const total = days.reduce((n, d) => n + d.facts.length, 0);
  const span =
    dated.length === 0
      ? ""
      : dated.length === 1
        ? ` on ${dated[0]}`
        : ` on ${dated.length} days from ${dated[0]} to ${dated[dated.length - 1]}`;
  return `${records(total)} matching this question${span}, grouped by day, oldest first. A statement repeated within a day is served once.`;
}

/**
 * The digest's text: the header, then each day's heading followed by its facts' lines.
 * `lineOf` gives a fact's served line (its text and citation); every fact of `days` gets exactly one.
 */
export function digestText(days: readonly DigestDay[], lineOf: (fact: MemoryFact) => string): string {
  const parts = [digestHeader(days)];
  for (const day of days) parts.push(`\n${dayHeading(day)}\n${day.facts.map(lineOf).join("\n")}`);
  return parts.join("\n");
}
