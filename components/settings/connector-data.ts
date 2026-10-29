// What each kind of knowledge source keeps in Willder, and what disconnecting it
// removes and leaves behind, in the words the settings screens show.
//
// The rule this file enforces: every sentence here is what the code does today,
// not what it should do. Each one names the code it was checked against, so a
// change there has one place to update. The sources are:
// - what a sync reads: services/connectors/{gdrive,github,slack,figma,posthog}.ts;
// - raw files: lib/blob-storage.ts deletes each one once extraction ends;
// - tokens: POST /api/sources seals a pasted token on the source row, and Drive
//   never stores one (the browser sends a short-lived token with each sync);
// - disconnect: DELETE /api/sources/:id clears the token and retires the source's
//   facts, passages, change-feed text and the briefs drawn from them
//   (services/memory/source-retirement.ts). It calls no provider, so nothing is
//   revoked upstream, and it keeps entity nodes, which other sources may share.

import type { SourceType } from "@/lib/source-lists";

/** One line per source kind: what a sync reads and what Willder keeps of it. */
export const WHAT_WE_STORE: Record<SourceType, string> = {
  gdrive:
    "Reads PDF, Word, Docs, Slides, Sheets and image files directly in the folder, not subfolders. Keeps the extracted text as passages and facts; the original file is deleted once it is read.",
  github:
    "Reads the README, the docs (with decision records in docs, adr and decisions folders), the file tree (paths only), issues and their comments, pull requests with their approvals, change requests and deciding comments, and commit messages. Each item names a GitHub login as its author (the repository owner's for the README, docs and tree), or a commit's git name. Never stores source files, diffs or inline review comments. Before the text is stored, email addresses and recognisable secrets are removed, except in a doc's file path and link: keys and tokens in a known format, a value of 8 or more characters after password=, api_key: or a similar name, long bearer tokens, and passwords inside links. Anything else is kept as written, such as a short or spaced value, or a password in a plain sentence like \"the password is …\".",
  slack:
    "Reads the channel's top-level messages, with the author as a Slack user ID. Not thread replies, and not bot or system messages.",
  figma: "Reads the file's top-level comments and their authors' handles. Not replies or the design itself.",
  posthog: "Reads one insight's name, description and current result. Never raw events.",
  website: "Nothing is synced from a website yet; this keeps the source's name and scope only.",
};

/** Where the access a connect gave stays after Willder forgets its own copy. */
const PROVIDER_ACCESS: Record<SourceType, string | null> = {
  gdrive:
    "Google still lists Willder as allowed to open this folder. Remove Willder under Third-party apps and services in your Google Account to end that.",
  github: "The token still works at GitHub. Delete it under Settings, Developer settings, Personal access tokens.",
  slack: "The token still works at Slack. Revoke it in your Slack app's settings.",
  figma: "The token still works at Figma. Revoke it in your Figma account settings.",
  posthog: "The key still works at PostHog. Delete it under Settings, Personal API keys.",
  website: null,
};

/** What one disconnect does, as the confirmation states it before the person agrees. */
export interface DisconnectEffects {
  removed: string[];
  kept: string[];
}

/** What disconnecting a source of this kind removes from Willder, and what it leaves. */
export function disconnectEffects(kind: SourceType): DisconnectEffects {
  const removed =
    kind === "website"
      ? ["The source stops being listed as connected."]
      : [
          "Every fact and passage this source added, in every scope it wrote to.",
          "The item text in the change feed's entries for it.",
          "Briefs that drew on its content.",
          kind === "gdrive"
            ? "Willder holds no Google token for this folder, so there is none to delete."
            : `The ${kind === "posthog" ? "API key" : "token"} Willder stored for it.`,
        ];
  const providerAccess = PROVIDER_ACCESS[kind];
  const kept = [
    "The source in this list, marked Disconnected, and the change feed's record that it synced.",
    ...(kind === "website"
      ? []
      : ["Names of people, companies and projects its facts mentioned, since other sources may share them."]),
    ...(providerAccess ? [providerAccess] : []),
  ];
  return { removed, kept };
}

/** What a disconnect reported removing: DELETE /api/sources/:id's counts. */
export function removedSummary(counts: { retiredFacts?: unknown; retiredChunks?: unknown }): string {
  const facts = typeof counts.retiredFacts === "number" ? counts.retiredFacts : null;
  const chunks = typeof counts.retiredChunks === "number" ? counts.retiredChunks : null;
  if (facts === null || chunks === null) return "Its content was removed from memory.";
  return `Removed ${plural(facts, "fact")} and ${plural(chunks, "passage")} from memory.`;
}

/**
 * A scope's row from GET /api/sources/:id/records, as the client reads it. The
 * server type is `SourceRecordCounts` in services/memory/source-records.ts.
 */
export interface ScopeRecordCounts {
  scopePath: string;
  chunks: number;
  syncRecords: number;
  feedSummaries: number;
  episodes: number;
  facts: number;
  verbatimNodes: number;
  danglingFacts: number;
}

/**
 * What is left of a source across every scope, in the units a person reads, and
 * whether disconnecting again would remove any of it. Unlinked entities
 * (`orphans`) are left out, as `holdsRetirableRecords` leaves them out: they carry
 * no source mark, so no disconnect can attribute them to the source.
 */
export function remainingRecords(scopes: ScopeRecordCounts[]): { text: string; retirable: boolean } {
  const sum = (field: keyof Omit<ScopeRecordCounts, "scopePath">) =>
    scopes.reduce((total, row) => total + (Number.isFinite(row[field]) ? row[field] : 0), 0);
  const facts = sum("facts") + sum("danglingFacts");
  const passages = sum("chunks");
  const other = sum("episodes") + sum("verbatimNodes") + sum("feedSummaries") + sum("syncRecords");
  if (facts + passages + other === 0)
    return { text: "Nothing this source synced is left in memory.", retirable: false };
  const parts = [
    facts > 0 ? plural(facts, "fact") : null,
    passages > 0 ? plural(passages, "passage") : null,
    other > 0 ? plural(other, "other record") : null,
  ].filter(Boolean);
  return { text: `Still in memory: ${parts.join(", ")}.`, retirable: true };
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}
