// Revision tokens: one format for "has this caller already been given exactly this".
//
// A record revision key names one record at one version:
//
//     <recordType>:<recordId>@<revision>
//
// where `revision` is whatever that record type already uses to mark a version: an
// integer column where the table has one (contacts), the id of a change event, or
// "1" for a record that is never edited (a convention is superseded, never changed).
// A revision token covers a set of such keys: the first 16 hex characters of the
// SHA-256 of the keys, sorted and joined with newlines.
//
// The one rule this file enforces: a token supports equality and nothing else.
// Sorting makes it independent of the order the keys were gathered in, and hashing
// makes it opaque, so a token can be stored and compared ("was this session already
// served this?") without saying how many records it covers or ordering against any
// other token. That is the property the change feed's cursor keeps too
// (services/memory/change-feed.ts), for the same reason.
import { createHash } from "node:crypto";

/** The key for one record at one version, in the format above. */
export function recordRevisionKey(recordType: string, recordId: string, revision: string | number): string {
  return `${recordType}:${recordId}@${revision}`;
}

/** The revision token for a set of record revision keys. The empty set has a token
 * too, so "served nothing" is a revision a caller can be recorded as holding. */
export function revisionToken(keys: readonly string[]): string {
  const canonical = [...keys].sort().join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
