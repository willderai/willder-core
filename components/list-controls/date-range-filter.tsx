"use client";

/**
 * The date filter for the time-ordered lists: a first and a last day, kept in the URL
 * (`sessions.from`, `sessions.through`) so a link, reload and back reopen the same range.
 * Days are the viewer's own, the same zone the lists show times in; `lib/date-range.ts`
 * turns them into the instants a route reads.
 */
import { CalendarRange, X } from "lucide-react";
import { useUrlParam } from "@/components/memory/store-list-tab";
import { isDayRangeSet, NO_DAY_RANGE, readDayRange, type DayRange } from "@/lib/date-range";

const FIELD =
  "min-h-10 rounded-full border border-[var(--field-border)] bg-[var(--field-background)] px-3 py-1.5 text-sm text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** The range in the URL under `prefix` (`sessions.`), and a setter that writes both days. */
export function useUrlDayRange(prefix: string): [DayRange, (range: DayRange) => void] {
  const [fromParam, setFromParam] = useUrlParam(`${prefix}from`, "replace");
  const [throughParam, setThroughParam] = useUrlParam(`${prefix}through`, "replace");
  const setRange = (range: DayRange) => {
    setFromParam(range.fromDay);
    setThroughParam(range.throughDay);
  };
  return [readDayRange(fromParam, throughParam), setRange];
}

/**
 * The range after one end is set. A typed day is not held to the other field's bound the
 * way a picked one is, so a first day after the last clears the other end rather than
 * keeping a range that matches nothing.
 */
export function withDay(range: DayRange, end: "fromDay" | "throughDay", day: string | null): DayRange {
  const next = { ...range, [end]: day };
  if (next.fromDay && next.throughDay && next.fromDay > next.throughDay) {
    return end === "fromDay" ? { fromDay: day, throughDay: null } : { fromDay: null, throughDay: day };
  }
  return next;
}

/**
 * Two day fields and a clear button. Each field bounds the other's picker; an emptied field
 * leaves that end open.
 */
export function DateRangeFilter({
  range,
  onChange,
  noun,
}: {
  range: DayRange;
  onChange: (range: DayRange) => void;
  /** What the list holds, for the group's name: "sessions". */
  noun: string;
}) {
  return (
    <div
      role="group"
      aria-label={`Filter ${noun} by date`}
      className="flex flex-wrap items-center gap-2 text-sm text-fg-muted"
    >
      <CalendarRange size={16} strokeWidth={1.8} aria-hidden className="text-fg-subtle" />
      <label className="inline-flex items-center gap-2">
        <span>From</span>
        <input
          type="date"
          className={FIELD}
          value={range.fromDay ?? ""}
          max={range.throughDay ?? undefined}
          onChange={(event) => onChange(withDay(range, "fromDay", event.target.value || null))}
        />
      </label>
      <label className="inline-flex items-center gap-2">
        <span>Through</span>
        <input
          type="date"
          className={FIELD}
          value={range.throughDay ?? ""}
          min={range.fromDay ?? undefined}
          onChange={(event) => onChange(withDay(range, "throughDay", event.target.value || null))}
        />
      </label>
      {isDayRangeSet(range) && (
        <button
          type="button"
          onClick={() => onChange(NO_DAY_RANGE)}
          className="inline-flex min-h-10 items-center gap-1 rounded-full px-2 text-sm text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
        >
          <X size={14} aria-hidden />
          Clear dates
        </button>
      )}
    </div>
  );
}
