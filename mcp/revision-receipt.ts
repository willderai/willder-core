// Revision receipts for memory reads: a caller that already holds an answer does not
// pay for it again.
//
// memory_query and memory_entity end every answer with a `revision:` line and set
// `_meta["willder/revision"]` on the result. A caller that sends that value back as
// `ifRevision` on the same call gets a short "unchanged" receipt instead of the
// answer, as long as the answer it would have received is byte-for-byte the same.
// Anything that changes the answer (a new, edited or removed fact, a renamed source,
// a scope the caller can no longer read) changes the revision, so the caller gets
// the full answer again.
//
// The one rule this file enforces: a revision is only computed from, and only
// compared against, an answer the caller was just allowed to read. The tool runs its
// normal check()-gated, audited read first; an error or denial passes through
// untouched and never carries a revision, so a revision can say nothing about data
// the caller cannot see.
//
// The token format is the shared one in services/memory/revision.ts, so the same
// value means the same thing here as in the task-start block's delivered_to claim.
import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { recordRevisionKey, revisionToken } from "@/services/memory/revision";

/** Result `_meta` key carrying the answer's revision. */
export const REVISION_META_KEY = "willder/revision";
/** Result `_meta` key set to true when the answer was replaced by a receipt. */
export const UNCHANGED_META_KEY = "willder/unchanged";

/** Upper bound on an `ifRevision` argument; a revision token is 16 hex characters. */
export const IF_REVISION_MAX_LENGTH = 64;

/** The `ifRevision` input description shared by every tool that returns a revision. */
export const IF_REVISION_DESCRIPTION =
  "The revision from your last identical call. If the answer has not changed you get a short 'unchanged' receipt instead of the answer again.";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The revision of one answer: the tool, the exact view it was asked for (the
 * resolved arguments, including the scope actually searched) and the answer text.
 */
function answerRevision(tool: string, view: unknown, answer: string): string {
  return revisionToken([recordRevisionKey(`${tool}-answer`, sha256(JSON.stringify(view)), sha256(answer))]);
}

/** The receipt text that replaces an unchanged answer. */
function unchangedReceiptText(revision: string): string {
  return `Unchanged since revision ${revision}. Reuse the answer you already hold; if it is no longer in your context, call again without ifRevision.`;
}

/**
 * Attach a revision to a successful read result, or replace the result with an
 * "unchanged" receipt when `ifRevision` matches it. Error results are returned as
 * they are, with no revision.
 */
export function withRevisionReceipt(
  tool: string,
  view: unknown,
  ifRevision: string | undefined,
  result: CallToolResult,
): CallToolResult {
  if (result.isError) return result;
  // A result's own `_meta` is part of the answer: a receipt must not stand in for one
  // whose metadata changed. A result without one keeps the revision it always had.
  const text = result.content.map((block) => (block.type === "text" ? block.text : JSON.stringify(block))).join("\n");
  const answer = result._meta ? `${text}\n${JSON.stringify(result._meta)}` : text;
  const revision = answerRevision(tool, view, answer);
  if (ifRevision === revision) {
    return {
      content: [{ type: "text", text: unchangedReceiptText(revision) }],
      _meta: { ...result._meta, [REVISION_META_KEY]: revision, [UNCHANGED_META_KEY]: true },
    };
  }
  return {
    ...result,
    content: [...result.content, { type: "text", text: `revision: ${revision}` }],
    _meta: { ...result._meta, [REVISION_META_KEY]: revision, [UNCHANGED_META_KEY]: false },
  };
}
