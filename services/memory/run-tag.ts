// What makes a stored fact one of a measure run's own: the run's tag on the fact.
//
// A measure run writes every fact with its run's tag twice, as the entity name (the
// tag itself, or `<tag>-…`) and in the text. The rule this file defines is that a fact is
// the run's only when both hold. Cleanup by tag (run-tag-cleanup.ts, in SQL) and the
// measure harness's own end-of-run removal (its seed ledger) both apply
// it, so neither can remove a fact the other would not.
//
// No imports: the measure harness runs against a deployed target and loads this file
// without the database client.

/**
 * A run tag: a lowercase prefix naming the measure, a hyphen, and the run's start as
 * twelve or fourteen digits (`ltload-20261005213000`, `ltconflict-202610052130`). The
 * timestamp is required so one tag can never name every run of a measure at once.
 */
export const RUN_TAG_PATTERN = /^[a-z][a-z0-9]*-\d{12}(?:\d{2})?$/;

/** True when a fact named `entityName` with text `content` carries `tag` both ways. */
export function carriesRunTag(tag: string, entityName: string | null | undefined, content: string): boolean {
  if (!entityName) return false;
  return (entityName === tag || entityName.startsWith(`${tag}-`)) && content.includes(tag);
}
