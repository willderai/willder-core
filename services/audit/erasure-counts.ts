/**
 * The per-store counts a `person.erased` audit row carries, as the audit API
 * returns them.
 *
 * The rule this file enforces: only numbers leave. The row is written with
 * counts alone (services/memory/person-erasure.ts), and this reader keeps that
 * true at the boundary too: a store is an object of non-negative integer counts,
 * and anything else in the metadata, a string above all, is dropped rather than
 * passed through.
 */

/** Counts by store, then by kind of record: `{ vector: { chunks: 3 } }`. */
export type ErasureCounts = Record<string, Record<string, number>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The `stores` counts of a `person.erased` row's metadata, keeping only
 * non-negative integers. Undefined when the metadata holds no counts at all.
 */
export function erasureCountsOf(metadata: unknown): ErasureCounts | undefined {
  if (!isObject(metadata) || !isObject(metadata.stores)) return undefined;
  const counts: ErasureCounts = {};
  for (const [store, kinds] of Object.entries(metadata.stores)) {
    if (!isObject(kinds)) continue;
    const numbers = Object.entries(kinds).filter(
      (entry): entry is [string, number] => Number.isInteger(entry[1]) && (entry[1] as number) >= 0,
    );
    if (numbers.length > 0) counts[store] = Object.fromEntries(numbers);
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}
