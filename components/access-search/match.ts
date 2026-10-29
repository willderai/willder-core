/**
 * Case-insensitive substring match of `query` against any of `fields`, the rule
 * every Access tab filters its loaded rows by. An empty query matches everything.
 */
export function matchesQuery(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return fields.some((field) => field != null && field.toLowerCase().includes(needle));
}
