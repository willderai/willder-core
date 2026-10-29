/**
 * The count lines the Access tabs show while a search is on, worded so a
 * count of one reads "1 match" and "1 of 1 token matches", never "1 matches".
 */

/** "0 matches", "1 match", "2 matches": the count followed by the noun it agrees with. */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * "3 of 12 grants match", "1 of 12 grants matches": how many loaded rows of a
 * tab the query kept. The noun agrees with the total; the verb agrees with the
 * subject, the count shown.
 */
export function tabMatchCount(shown: number, total: number, singular: string, query: string): string {
  const verb = shown === 1 ? "matches" : "match";
  return `${shown.toLocaleString()} of ${countOf(total, singular)} ${verb} “${query.trim()}”`;
}

/**
 * The Audit tab's line for one page of the log: which rows are on screen, how many
 * match in all, and the allowed and denied counts across every page. `total` and the
 * counts are the server's, never the page length, so a "0 denied" always stands for
 * the whole log as filtered.
 */
export function auditPageSummary(page: {
  first: number;
  shown: number;
  total: number;
  allowed: number;
  denied: number;
  searching: boolean;
}): string {
  const range =
    page.shown > 0 ? `${page.first.toLocaleString()}–${(page.first + page.shown - 1).toLocaleString()} of ` : "";
  const total = page.searching ? countOf(page.total, "match", "matches") : countOf(page.total, "row");
  return `${range}${total} · ${page.allowed.toLocaleString()} allowed · ${page.denied.toLocaleString()} denied`;
}
