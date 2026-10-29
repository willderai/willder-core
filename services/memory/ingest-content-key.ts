// The identity of one ingest's content within its scope, for replay protection.
//
// A caller that retries `memory_ingest` (a dropped connection, an agent loop that
// re-asserts a fact it already stored) sends the same org, scope, name and content
// again. The write-through path in lib/inngest.ts stores each ingest as a pgvector
// row before queueing graph extraction, so without an identity for the content a
// retry stores a second row and announces the fact a second time. The rule this
// file defines: two ingests with the same key are the same fact, and the store
// keeps one row for them.
//
// The key is content-derived, not a caller-supplied token, so a retry needs no
// cooperation from the caller: the same request yields the same key.
import { createHash } from "node:crypto";
import { orgRootPath } from "@/services/access";
import type { IngestInput } from "@/types/memory";

/** The ingest fields that make two ingests the same fact. */
export type IngestIdentity = Pick<IngestInput, "groupId" | "scopePath" | "name" | "content" | "baseVersion">;

/**
 * The content key for one ingest: a SHA-256 hex digest of the org, the scope, the
 * name and the normalized content.
 *
 * An omitted scope is the org root, the same default the store writes and the
 * change feed use, so an ingest that names the root scope and one that omits it
 * share a key. The content is compared with its whitespace collapsed and its
 * Unicode composition normalized, so a retry that differs only by a trailing
 * newline or a line-ending convention is still the same fact; case and
 * punctuation are kept, since they can change meaning.
 *
 * A write based on a version (`baseVersion`) also keys on that version, so putting back
 * the text of an older, replaced version is a new update rather than a replay of the
 * old row, while an identical retry of the same based write still replays. A write
 * without a base keys exactly as before.
 */
export function ingestContentKey(input: IngestIdentity): string {
  const scopePath = input.scopePath ?? orgRootPath(input.groupId);
  const parts = [input.groupId, scopePath, input.name ?? "", normalizeContent(input.content)];
  if (input.baseVersion !== undefined) parts.push(`base:${input.baseVersion}`);
  const hash = createHash("sha256");
  for (const part of parts) {
    // Each part is length-prefixed so a boundary cannot move between parts:
    // ("ab", "c") and ("a", "bc") hash differently.
    hash.update(`${part.length}:`);
    hash.update(part);
  }
  return hash.digest("hex");
}

/** Content as it is compared: NFC-composed, trimmed, every whitespace run one space. */
function normalizeContent(content: string): string {
  return content.normalize("NFC").trim().replace(/\s+/g, " ");
}
