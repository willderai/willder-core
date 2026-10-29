// Field drift between a connector parser and its fixtures.
//
// A fixture that never carries a field the parser reads leaves that branch of
// the parser untested, and a provider change to that field ships unnoticed.
// This module wraps a provider payload so every field the parser reads is
// recorded, together with whether the payload actually carried a value there.
//
// The one rule: a field path the parser reads must hold a non-null value in at
// least one fixture. `uncoveredReads` lists every path that breaks it.

/** Every field path read during a run, mapped to whether any read found a value. */
export type ReadLog = Map<string, boolean>;

export function newReadLog(): ReadLog {
  return new Map();
}

const ARRAY_INDEX = /^\d+$/;

function record(log: ReadLog, path: string, carried: boolean): void {
  log.set(path, (log.get(path) ?? false) || carried);
}

/**
 * Wrap `value` so each own-field read below `root` is recorded in `log`.
 * Array elements share one path (`root[]`), so a read is covered when any
 * element carries it. Reads of inherited members (`map`, `length`, iterators)
 * are not fields and are not recorded.
 */
export function trackReads<T>(value: T, root: string, log: ReadLog): T {
  if (value === null || typeof value !== "object") return value;
  return new Proxy(value as object, {
    get(target, key, receiver) {
      const field = Reflect.get(target, key, receiver);
      if (typeof key !== "string") return field;
      const isOwn = Object.prototype.hasOwnProperty.call(target, key);
      if (!isOwn && key in target) return field; // inherited member, not a payload field
      if (!isOwn && key === "then") return field; // an await probing for a promise, not a payload field
      if (Array.isArray(target) && ARRAY_INDEX.test(key)) return trackReads(field, `${root}[]`, log);
      const path = `${root}.${key}`;
      record(log, path, field !== null && field !== undefined);
      return trackReads(field, path, log);
    },
  }) as T;
}

/** Field paths the parser read that no fixture ever carried a value for, sorted. */
export function uncoveredReads(log: ReadLog): string[] {
  return [...log]
    .filter(([, carried]) => !carried)
    .map(([path]) => path)
    .sort();
}
