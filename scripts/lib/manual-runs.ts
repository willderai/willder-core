// The second claim: a person opened this client and the settings screen accepted
// the config.
//
// No script can establish that. A graphical client's connection lives in its own
// window, so the only honest evidence is a person who ran it and said so, by
// name, on a named build. `docs/connect/manual-runs.json` is where those runs are
// recorded, and this module is the one reader of it.
//
// Three rules keep a recorded run from drifting into a claim it cannot support:
// an entry missing any required field is not a run at all, `when` has to be a
// real ISO 8601 instant rather than anything a date parser happens to accept,
// and a run recorded against a different deployed commit does not carry forward
// to this one.
import { readFileSync } from "node:fs";

/** One person's recorded run of one client. Every field is required. */
export interface ManualRun {
  /** The client id, which is also its page name under `docs/connect/`. */
  client: string;
  /** Who ran it. A person or a named agent, never a tool. */
  who: string;
  /** When, as an ISO 8601 instant: `2026-10-05T18:00:00Z` or `…+02:00`. */
  when: string;
  /** The deployed commit they ran against, as an unabbreviated-enough git SHA. */
  deployedCommit: string;
  /** The client's own version, as its about screen reports it. */
  clientVersion: string;
  /** What they saw: the tool count and the answer the query gave back. */
  saw: string;
}

export interface ManualRunLedger {
  runs: ManualRun[];
  /** Entries that were present but unusable, with the reason, so they are not silently dropped. */
  rejected: Array<{ entry: unknown; reason: string }>;
}

const REQUIRED_FIELDS: Array<keyof ManualRun> = ["client", "who", "when", "deployedCommit", "clientVersion", "saw"];

/**
 * A full ISO 8601 instant: a calendar date, a `T`, a time, and a zone. `Date.parse`
 * is not this check. It accepts `"1"`, `"October 5"` and a bare `"2026"`, each of
 * which would record a run at a moment nobody wrote down.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The shortest commit id a run may be recorded against, and the longest.
 *
 * The ledger is matched against the deployed commit by prefix, because a page
 * records what a person had in front of them and that is sometimes the short
 * form. A prefix is only evidence while it is long enough to mean one commit:
 * `"2"` is a prefix of a sixteenth of the repository. Eight hex characters is
 * git's own abbreviation floor plus one, and the rule is enforced on both the
 * ledger entry and the commit under test, so neither side can shorten it.
 */
const COMMIT_ID = /^[0-9a-f]{8,40}$/;

/** Whether this string is specific enough to identify one commit. */
export function isCommitId(value: string): boolean {
  return COMMIT_ID.test(value);
}

/** Read a ledger from JSON text, keeping every rejection and its reason. */
export function parseManualRuns(json: string): ManualRunLedger {
  const parsed = JSON.parse(json) as { runs?: unknown };
  const entries = Array.isArray(parsed.runs) ? parsed.runs : [];
  const runs: ManualRun[] = [];
  const rejected: ManualRunLedger["rejected"] = [];
  for (const entry of entries) {
    const record = entry as Partial<Record<keyof ManualRun, unknown>>;
    const missing = REQUIRED_FIELDS.filter(
      (field) => typeof record[field] !== "string" || (record[field] as string).trim() === "",
    );
    if (missing.length > 0) {
      rejected.push({ entry, reason: `missing ${missing.join(", ")}` });
      continue;
    }
    if (!ISO_INSTANT.test(record.when as string)) {
      rejected.push({ entry, reason: `"when" is not an ISO 8601 instant: ${String(record.when)}` });
      continue;
    }
    if (!isCommitId(record.deployedCommit as string)) {
      rejected.push({
        entry,
        reason: `"deployedCommit" is not 8 to 40 hex characters, so it does not name one commit: ${String(record.deployedCommit)}`,
      });
      continue;
    }
    runs.push(record as unknown as ManualRun);
  }
  return { runs, rejected };
}

export function readManualRuns(path: string): ManualRunLedger {
  return parseManualRuns(readFileSync(path, "utf8"));
}

/**
 * The run that supports this client on this deployed commit, if there is one.
 * A run on another commit is deliberately not returned: the client matrix
 * requires a dated check on the commit that is live.
 *
 * An identifier too short to name one commit matches nothing, rather than
 * matching everything it is a prefix of.
 */
export function runFor(ledger: ManualRunLedger, client: string, deployedCommit: string): ManualRun | undefined {
  if (!isCommitId(deployedCommit)) return undefined;
  const forClient = ledger.runs.filter((run) => run.client === client);
  const onThisCommit = forClient.filter(
    (run) => deployedCommit.startsWith(run.deployedCommit) || run.deployedCommit.startsWith(deployedCommit),
  );
  return onThisCommit.sort((left, right) => Date.parse(right.when) - Date.parse(left.when))[0];
}
