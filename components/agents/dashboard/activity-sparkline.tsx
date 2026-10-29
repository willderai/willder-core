// Seven days of one agent's activity as a row of small bars: the bar is that day's
// runs (or token calls), its red base the failed runs (or denied calls). The total
// and the failures are also said in text, so the chart never carries them alone.
import { countOf } from "@/components/access-search/count-copy";

export type DayActivity = { total: number; failed: number };

const BAR_WIDTH = 6;
const GAP = 2;
const HEIGHT = 24;

/** The text a sparkline stands for: "12 runs, 2 failed, last 7 days". */
export function sparklineSummary(
  series: DayActivity[],
  noun: { one: string; many: string },
  failedWord: string,
): string {
  const total = series.reduce((sum, day) => sum + day.total, 0);
  const failed = series.reduce((sum, day) => sum + day.failed, 0);
  return `${countOf(total, noun.one, noun.many)}, ${failed.toLocaleString()} ${failedWord}, last ${series.length} days`;
}

export function ActivitySparkline({
  series,
  noun,
  failedWord,
}: {
  series: DayActivity[];
  noun: { one: string; many: string };
  failedWord: string;
}) {
  const peak = Math.max(1, ...series.map((day) => day.total));
  const width = series.length * (BAR_WIDTH + GAP) - GAP;
  const summary = sparklineSummary(series, noun, failedWord);
  return (
    <svg
      role="img"
      aria-label={summary}
      width={width}
      height={HEIGHT}
      viewBox={`0 0 ${width} ${HEIGHT}`}
      className="shrink-0 overflow-visible"
    >
      <title>{summary}</title>
      {series.map((day, i) => {
        const x = i * (BAR_WIDTH + GAP);
        const height = day.total === 0 ? 1 : Math.max(3, Math.round((day.total / peak) * HEIGHT));
        const failedHeight = day.failed === 0 ? 0 : Math.max(2, Math.round((day.failed / peak) * HEIGHT));
        const daysAgo = series.length - 1 - i;
        return (
          <g key={i}>
            <title>{`${daysAgo === 0 ? "Last 24 hours" : `${daysAgo} ${daysAgo === 1 ? "day" : "days"} before`}: ${countOf(day.total, noun.one, noun.many)}, ${day.failed.toLocaleString()} ${failedWord}`}</title>
            <rect
              x={x}
              y={HEIGHT - height}
              width={BAR_WIDTH}
              height={height}
              rx={1.5}
              className={day.total === 0 ? "fill-fg/15" : "fill-accent/70"}
            />
            {failedHeight > 0 && (
              <rect
                x={x}
                y={HEIGHT - failedHeight}
                width={BAR_WIDTH}
                height={failedHeight}
                rx={1.5}
                className="fill-danger"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
