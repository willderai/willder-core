// Claim overlap: two live claims that edit the same file are told of each other.
//
// A claim names a task, and two agents claiming the same task are told of each other
// (services/memory/working-notes.ts). Two agents on different tasks that edit one file were
// never told. So a claim can carry `touches`, the files its agent edits, as node ids
// `file:<repo>/<path>`. The Claude Code hook records them from the agent's Edit and Write
// calls (cli/hooks/willder-touches.mjs): the agent declares nothing, and no file's contents
// are ever sent, only its path.
//
// When a post adds files to a claim, the post asks once for other agents' live claims that
// already touch one of the added files (`touches && added`, served by a GIN index). The
// poster's reply names each of them, and one change event per pair tells the other claimant
// on its next tool call. A shared file is reported once per pair of claims, by the post that
// made it shared.
//
// The one rule: an overlap is detected and notified, never resolved. Both claims stand, and
// nothing here orders, blocks or merges anyone's work.
//
// Who learns of an overlap: the poster is told only of claims in scopes it may read, as for
// a task collision. Every other claimant is told through a change event filed under the two
// claims' lowest common scope, so the feed shows it only to readers whose scope covers both.
//
// Off unless the org's settings hold `claimOverlap: true`. With it off, touches are neither
// stored nor compared, and a post does what it did before touches existed; overlap events
// recorded while it was on keep showing in notices until the claim that made them ends.
import { db } from "@/lib/db";
import { holdsSecretOrAddress } from "@/services/connectors/secret-scan";
import { isValidLtreePath } from "@/services/access";

/** The org setting that turns claim overlap on (`orgs.settings`). */
export const CLAIM_OVERLAP_SETTING = "claimOverlap";

/** The change feed's `recordType` for an overlap; its `recordId` is the claim whose post made it. */
export const CLAIM_OVERLAP_RECORD_TYPE = "claim_overlap";

/** Most files one claim carries; the hook sends the ones edited most recently. */
export const MAX_TOUCHES = 64;

/** Longest node id, in characters. */
const MAX_TOUCH_CHARS = 512;

/** Most shared files one reply line or change event names; the count is always given. */
const MAX_SHARED_SHOWN = 3;

/** Characters no segment of a file node may hold: a backslash, control characters and line separators. */
const NOT_IN_SEGMENT = /[\\\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Whether `id` is a file node: `file:`, then at least two slash-separated segments (the
 * repository, then the path from its root), none empty, `.` or `..`. The hook writes the
 * repository as `<owner>/<name>` from the git remote.
 */
function isFileNode(id: string): boolean {
  if (!id.startsWith("file:")) return false;
  const segments = id.slice("file:".length).split("/");
  return segments.length >= 2 && segments.every((s) => s !== "" && s !== "." && s !== ".." && !NOT_IN_SEGMENT.test(s));
}

/** Whether an org's settings turn claim overlap on. Only `true` does; anything else leaves it off. */
export function claimOverlapFromSettings(settings: unknown): boolean {
  return (
    settings !== null &&
    typeof settings === "object" &&
    (settings as Record<string, unknown>)[CLAIM_OVERLAP_SETTING] === true
  );
}

/** Whether `orgId` has claim overlap on. An org that does not exist has it off. */
export async function loadClaimOverlap(orgId: string): Promise<boolean> {
  const org = await db.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  return claimOverlapFromSettings(org?.settings);
}

/** A claim's touches as stored: the ids kept, and how many were left out and why. */
export interface CheckedTouches {
  touches: string[];
  /** Ids that may hold a secret or an email address in any encoding: never stored, never echoed. */
  withheld: number;
  /** Ids that are not file nodes: left out, so one bad path never costs the claim the rest. */
  refused: number;
}

/**
 * `touches` as a claim stores them: in Unicode NFC (macOS writes a name decomposed, Linux
 * composed, and one file must be one node), deduplicated and sorted, or the reason the list is
 * refused. More than {@link MAX_TOUCHES} is refused. An id that is not a file node
 * (`file:<repo>/<path>` from the repository root, no "." or ".." segment, at most 512
 * characters) is left out and counted, as is one that may hold a secret or an address: a
 * scrubbed path no longer names the file, so it could only produce a false overlap.
 */
export function checkTouches(touches: readonly string[]): CheckedTouches | { problem: string } {
  const unique = [...new Set(touches.map((id) => (id.isWellFormed() ? id.normalize("NFC") : id)))];
  if (unique.length > MAX_TOUCHES) {
    return {
      problem: `touches names ${unique.length} files; a claim carries at most ${MAX_TOUCHES}. Send the ones you are editing now.`,
    };
  }
  const nodes = unique.filter((id) => id.length <= MAX_TOUCH_CHARS && id.isWellFormed() && isFileNode(id));
  const kept = nodes.filter((id) => !holdsSecretOrAddress(id)).sort();
  return { touches: kept, withheld: nodes.length - kept.length, refused: unique.length - nodes.length };
}

/** The ids in `next` that `previous` did not hold: the files a post adds to a claim. */
export function addedTouches(previous: readonly string[], next: readonly string[]): string[] {
  const before = new Set(previous);
  return next.filter((id) => !before.has(id));
}

/** The ids two touch-sets share, in `ours` order. */
export function sharedTouches(ours: readonly string[], theirs: readonly string[]): string[] {
  const other = new Set(theirs);
  return ours.filter((id) => other.has(id));
}

/**
 * The deepest scope containing both ltree paths, or null when they share no label (or either
 * is not a valid path). Containment is by whole label: `a.b` and `a.bc` meet at `a`.
 */
export function lowestCommonScope(a: string, b: string): string | null {
  if (!isValidLtreePath(a) || !isValidLtreePath(b)) return null;
  const left = a.split(".");
  const right = b.split(".");
  let depth = 0;
  while (depth < left.length && depth < right.length && left[depth] === right[depth]) depth++;
  return depth === 0 ? null : left.slice(0, depth).join(".");
}

/** `ids` for a reader: the first {@link MAX_SHARED_SHOWN}, then how many more. */
export function sharedList(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_SHARED_SHOWN).join(", ");
  return ids.length > MAX_SHARED_SHOWN ? `${shown} and ${ids.length - MAX_SHARED_SHOWN} more` : shown;
}

/** What the change event about one overlap says, to the other claimant and readers of both scopes. */
export interface OverlapEventInput {
  /** The task of the claim whose post made the overlap. */
  task: string;
  /** The claim it now shares files with. */
  other: { id: string; agentId: string; createdAt: Date };
  shared: readonly string[];
}

/**
 * The change event's title for an overlap. The notice line already names the posting claim
 * and its agent (`create claim_overlap <note> by <agent>`), and a summary is cut at 200
 * characters, so the title puts what the other claimant needs first: its own claim, then the
 * shared files, and the task last, where a long one is cut.
 */
export function overlapTitle({ task, other, shared }: OverlapEventInput): string {
  const files = `${shared.length} file${shared.length === 1 ? "" : "s"}`;
  return `overlap detected, not resolved: claim ${other.id} by ${other.agentId}, claimed ${other.createdAt.toISOString().slice(11, 16)}Z, shares ${files}: ${sharedList(shared)}; this claim is on "${task}"`;
}
