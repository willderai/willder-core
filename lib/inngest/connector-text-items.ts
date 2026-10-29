// Syncing one text item -- a Slack message, a Figma comment, a PostHog insight
// snapshot, a GitHub issue -- into memory, and retiring one that is gone.
//
// Text items need no file extraction: they ingest straight through the memory
// store, unlike the Drive files in connector-drive-files.ts. What they share
// with Drive is the order: retire the stale episode first, then ingest the new
// content, then record what was written.
//
// The one rule it enforces: a `SourceFile` row's checksum is advanced only
// after both halves have landed, so a sync that fails between them is retried
// as a unit rather than leaving the retire and the ingest out of step.
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { memory } from "@/services/memory";
import { checkEpisodeCap, recordEpisode } from "@/services/guardrails";
import type { IngestInput, IngestResult } from "@/types/memory";
import type { SlackMessage, SlackSyncCursor } from "@/services/connectors/slack";
import type { FigmaComment } from "@/services/connectors/figma";
import type { GitHubSyncCursor } from "@/services/connectors/github";
import { recordSourceItemChange } from "@/services/memory/content-change-event";
import { recordReplacements } from "@/services/memory/edges";
import { loadErasedPersonMatcher } from "@/services/memory/erasure-suppression";
import type { ConnectorSyncOutcome } from "./source-state";
import {
  connectorActorId,
  retireRecordedEpisode,
  type ConnectorSyncFile,
  type RetirableEpisode,
} from "./connector-records";

/** Common shape both `listChannelMessages` and `listFileComments` satisfy —
 *  used to give the `list-items` step a single concrete return type instead
 *  of a `SlackMessage[] | FigmaComment[]` union, which TypeScript can't
 *  distribute through `planConnectorSync`'s generic parameter. */
export interface ConnectorSyncItem {
  id: string;
  text: string;
  checksum: string;
  user?: string;
  ts?: string;
  author?: string;
  createdAt?: string;
  /** What names the item, stored verbatim by the memory service; set by the GitHub listing. */
  heading?: string;
}

/** ISO-8601 conversion for Slack's `ts` field (`<seconds>.<fraction>` since the
 *  Unix epoch). Duplicated from services/connectors/slack.ts (not imported)
 *  deliberately: every other connector dependency in this file is a lazy
 *  `await import(...)` inside the step loop, so the real-API fetch code isn't
 *  pulled into this module's (much wider) static import graph — this is a
 *  pure, dependency-free one-liner, cheap to keep local instead. */
function slackTsToIsoLocal(ts: string): string | undefined {
  const seconds = Number(ts.split(".")[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

/**
 * Build the `IngestInput` for one synced Slack message / Figma comment. Pulled
 * out of the step loop so the tenant-scoping (groupId = bare org id, scopePath
 * = this source's own scope, never the caller's) is directly unit-testable
 * without driving the whole Inngest step function.
 *
 * The per-message author and timestamp the connector computes
 * (`SlackMessage.user`/`.ts`, `FigmaComment.author`) reach the episode as its
 * grounding, so an answer can cite who said something and when, not only the
 * connector's generic name and the ingest-time clock. `item`'s extra fields
 * are optional so a bare `{ text }` caller still gets a valid input with the
 * fallback grounding; only real Slack/Figma items carry them.
 */
export function buildConnectorIngestInput(
  source: { id: string; orgId: string; type: string; name: string; scopePath: string },
  item: { text: string; heading?: string } & Partial<Pick<SlackMessage, "user" | "ts">> &
    Partial<Pick<FigmaComment, "author" | "createdAt">>,
): IngestInput {
  const isSlack = source.type === "slack";
  const author = isSlack ? item.user : item.author;
  const referenceTime = isSlack ? (item.ts ? slackTsToIsoLocal(item.ts) : undefined) : item.createdAt;

  return {
    groupId: source.orgId,
    content: item.text,
    actorType: "extraction",
    origin: "connector-sync",
    actorId: connectorActorId(source),
    // Keep the connector source's own name (previous behavior, still useful
    // context — "which channel/file") AND the real per-item author when the
    // connector supplied one, so neither replaces the other.
    actorName: author ? `${source.name} — ${author}` : source.name,
    referenceTime,
    scopePath: source.scopePath,
    resolve: false, // already-structured extraction content, like Drive sync.
    // Lets a later DELETE /api/sources/:id purge exactly this source's own
    // content even when it shares scopePath with another producer.
    sourceId: source.id,
    // Extraction paraphrases and drops numeric qualifiers ("up to 55
    // updates/min" came back as "uses WebSocket for live price ticks"); the
    // memory service keeps such passages in their own words.
    recordType: "document",
    // Only a connector whose items open with what they are names them (github.ts itemHeading).
    heading: item.heading,
  };
}

/**
 * List the (at most one) current PostHog insight item for a source, pulled
 * out of the `list-items` step closure for the same directly-testable reason
 * `syncOneTextItem`/`loadScopedSource` are: no client token flows through
 * `SourceSyncInput` for posthog at all (gdrive's, and a fresh Slack/Figma one, travel sealed) — the
 * customer's key was sealed onto `Source.encryptedTokens` at connect time
 * (app/api/sources/route.ts) and is decrypted here, immediately before the
 * one read-only call that needs it, never logged or passed further.
 */
/**
 * `Source.externalId` for a posthog source is `${projectId}:${insightId}`: a
 * bare insight id is only unique within its own PostHog project, not across an org's
 * projects, so it can't stand alone as this row's identity. The actual
 * PostHog API call needs just the insight id half.
 */
function postHogInsightId(externalId: string): string {
  const colon = externalId.indexOf(":");
  return colon === -1 ? externalId : externalId.slice(colon + 1);
}

/**
 * A text source's listing. `unreadable` names parts the credential may not
 * read; only a connector that can tell (github) sets it.
 *
 * An incremental listing (github) returns only what changed since `cursor` was
 * stored, so it also names the stored items it found `gone` upstream, the only
 * ones the sync retires. `cursor` is stored on the source once the sync
 * completes with nothing failed, and handed back to the next listing; a sync
 * where an item failed stores `heldCursor` instead.
 */
export interface ConnectorListing {
  items: ConnectorSyncItem[];
  /**
   * Set, with no items, when the credential can no longer read the source at
   * all: the message for the person who connected it. The sync then changes
   * nothing it stored, because a source it cannot read says nothing about what
   * is still there.
   */
  accessLost?: string;
  unreadable?: string[];
  gone?: string[];
  cursor?: StoredSyncCursor;
  /** Stored by a sync where an item failed; absent, the cursor already stored stays. */
  heldCursor?: StoredSyncCursor;
}

/**
 * A listing cursor as `Source.meta.syncCursor` holds it, tied to the connect it
 * was read under. A reconnect is a fresh authorization and may follow a purge of
 * everything the source held, so its first sync reads the whole history again
 * rather than continue a cursor that assumes the old content is still stored.
 *
 * The connect is named by a digest: `GET /api/sources` returns `meta` to the
 * client, and the authorization's audit row id is not the client's to read.
 */
export type StoredSyncCursor = {
  connection: string;
  value: GitHubSyncCursor | SlackSyncCursor;
};

type ConnectedSource = { connectAuthorizationId: string | null; scopePath: string };

function connectionOf(source: ConnectedSource): string {
  return createHash("sha256")
    .update(`${source.connectAuthorizationId ?? ""}\0${source.scopePath}`)
    .digest("hex");
}

/** `value` as the cursor of the source's current connect. */
function storedCursor(source: ConnectedSource, value: StoredSyncCursor["value"]): StoredSyncCursor {
  return { connection: connectionOf(source), value };
}

/** The cursor stored for this connect of the source, or null to read from the start. */
export function cursorForConnect(meta: unknown, source: ConnectedSource): unknown {
  const stored = meta && typeof meta === "object" ? (meta as { syncCursor?: unknown }).syncCursor : undefined;
  if (!stored || typeof stored !== "object") return null;
  const { connection, value } = stored as Partial<StoredSyncCursor>;
  return connection === connectionOf(source) ? (value ?? null) : null;
}

/**
 * List one Slack channel's messages since the stored cursor, with the token the
 * sync was handed. `stored` is every message id the source has recorded, for
 * the listing to say which of them are gone.
 */
export async function listSlackItems(
  source: { externalId: string; meta: unknown; connectAuthorizationId: string | null; scopePath: string },
  token: string,
  stored: readonly string[],
): Promise<ConnectorListing> {
  const { listChannelMessages, parseSlackCursor } = await import("@/services/connectors/slack");
  const cursor = parseSlackCursor(cursorForConnect(source.meta, source));
  const listing = await listChannelMessages(source.externalId, token, { cursor, stored });
  return {
    ...listing,
    cursor: storedCursor(source, listing.cursor),
  };
}

/**
 * List one GitHub repository's items changed since the stored cursor; token
 * sealed at connect time, like posthog. `stored` is every item id the source has
 * recorded, for the listing to say which of them are gone.
 */
export async function listGitHubItems(
  source: {
    id: string;
    externalId: string;
    encryptedTokens: string | null;
    meta: unknown;
    connectAuthorizationId: string | null;
    scopePath: string;
  },
  stored: readonly string[],
): Promise<ConnectorListing> {
  const { listRepositoryItems, parseCursor } = await import("@/services/connectors/github");
  const { unsealSecret } = await import("@/lib/crypto");
  if (!source.encryptedTokens) throw new Error(`GitHub source ${source.id} is missing its stored credential`);
  const { token } = unsealSecret(source.encryptedTokens) as { token?: string };
  if (!token) throw new Error(`GitHub source ${source.id}'s stored credential is missing a token`);
  const cursor = parseCursor(cursorForConnect(source.meta, source));
  const listing = await listRepositoryItems(source.externalId, token, { cursor, stored });
  return {
    ...listing,
    cursor: storedCursor(source, listing.cursor),
    heldCursor: storedCursor(source, listing.heldCursor),
  };
}

export async function listPostHogItems(source: {
  id: string;
  externalId: string;
  meta: unknown;
  encryptedTokens: string | null;
}): Promise<ConnectorSyncItem[]> {
  const { fetchInsightSnapshot, POSTHOG_DEFAULT_HOST } = await import("@/services/connectors/posthog");
  const { unsealSecret } = await import("@/lib/crypto");
  const meta = (source.meta && typeof source.meta === "object" ? source.meta : {}) as {
    projectId?: string;
    host?: string;
  };
  if (!meta.projectId) throw new Error(`PostHog source ${source.id} is missing its project id`);
  if (!source.encryptedTokens) throw new Error(`PostHog source ${source.id} is missing its stored credential`);
  const { apiKey } = unsealSecret(source.encryptedTokens) as { apiKey?: string };
  if (!apiKey) throw new Error(`PostHog source ${source.id}'s stored credential is missing an api key`);
  return fetchInsightSnapshot(
    meta.projectId,
    postHogInsightId(source.externalId),
    apiKey,
    meta.host ?? POSTHOG_DEFAULT_HOST,
  );
}

/**
 * Like `ingestMemory`, but calls the store directly and returns the real
 * result (including the episode id) instead of firing an event and returning
 * void. Only used by sourceSync's connector-sync branch, which needs a real
 * episode id to retire on a later edit/delete — and is
 * only safe to call this way from inside another Inngest step function that
 * already has its own durable execution: `ingestMemory`'s event-hop/`after()`
 * dance exists specifically for an HTTP route whose response returns before a
 * background write finishes, which doesn't apply to a step already running in
 * the background. Equivalent to the full `memoryIngest` job specifically for
 * extraction-provenance content (the only kind sourceSync ever sends here):
 * `shouldDistillContent`/`shouldResolve` both gate on `actorType !==
 * "extraction"`, so `memoryIngest`'s body reduces to exactly this same call.
 */
async function ingestMemorySync(data: IngestInput): Promise<IngestResult> {
  await checkEpisodeCap(data.groupId);
  const result = await memory.ingest(data);
  await recordEpisode(data.groupId);
  return result;
}

/** `retireRecordedEpisode` for a connector text item, whose row holds one episode. */
function retireTextItemEpisode(
  source: { id: string; scopePath: string },
  externalFileId: string,
  episode: RetirableEpisode,
): Promise<string> {
  const where = { sourceId: source.id, externalFileId, episodeId: episode.episodeId };
  return retireRecordedEpisode(where, episode, source.scopePath);
}

/**
 * The source a sync is running for, as the per-item work needs it.
 *
 * `connectAuthorizationId` rides along with the scope and the name because a sync write's
 * change event records it as the authorization the write happened under: the sync itself
 * runs no `check()`, so the connect is the only authorization there is. The sync job
 * re-reads it before each item (`runWhileSourceCurrent`), so an item written after a
 * reconnect at the same scope records that reconnect, not the one the run started under.
 */
export interface SyncingSource {
  id: string;
  orgId: string;
  type: string;
  name: string;
  scopePath: string;
  connectAuthorizationId: string | null;
}

/**
 * Process one new/edited connector item: retire its stale episode first (if
 * this is an edit), ingest the fresh content, then record the new
 * checksum/episode. Pulled out of the `step.run` closure so it's directly
 * unit-testable and so counting its result doesn't depend on a mutated outer
 * variable (see `ConnectorSyncOutcome`'s doc comment).
 *
 * A genuine retirement failure propagates out of this function before the
 * ingest ever runs. `removeEpisode` already treats the already-gone (404) case
 * as a safe no-op; swallowing every other retirement failure too would let the
 * ingest run and report `synced` while the stale episode stays live in the
 * graph, and revoked/deleted content must stop being retrievable. So the item
 * is reported `failed`, not `synced`, and — because SourceFile's checksum is
 * only updated on the `synced` path below — the NEXT sync still sees this item
 * as changed and retries the same retire-then-ingest pair as a unit, instead
 * of the two ever landing out of step with each other.
 *
 * Each `SourceFile` write shares a transaction with the change event for the
 * episode it records: the pointer drop with the old episode's `supersede`, the
 * upsert with the new episode's `create`. They are two transactions, not one,
 * because the retire and the ingest between them are two store writes: if the
 * ingest fails, the old episode is already gone, and a reader must still hear so.
 * The new episode's transaction also records that it replaced the old one
 * (`recordReplacements`), so "what replaced it" and "what it replaced" name each
 * other. Only that transaction knows both ids; an edit whose ingest never lands
 * names no replacement, and nor does one written to another scope than the old
 * episode was removed from.
 */
export async function syncOneTextItem(
  source: SyncingSource,
  item: ConnectorSyncItem,
  previousEpisode: RetirableEpisode | null,
): Promise<ConnectorSyncOutcome> {
  const actorId = connectorActorId(source);
  try {
    let retired: { episodeId: string; scopePath: string } | null = null;
    if (previousEpisode) {
      const retiredFrom = await retireTextItemEpisode(source, item.id, previousEpisode);
      retired = { episodeId: previousEpisode.episodeId, scopePath: retiredFrom };
      // Drop the pointer to the episode just deleted, before the ingest that
      // replaces it. If the record below is never rewritten — a crashed step, a
      // failed ingest — the next sync sees an item with nothing to retire and
      // re-ingests it, instead of re-addressing an episode that is already gone
      // and reporting `failed` on it forever.
      await db.$transaction(async (tx) => {
        await tx.sourceFile.update({
          where: { sourceId_externalFileId: { sourceId: source.id, externalFileId: item.id } },
          data: { episodeId: null, episodeScopePath: null, episodeRetireStartedAt: null },
        });
        await recordSourceItemChange(tx, {
          orgId: source.orgId,
          scopePath: retiredFrom,
          episodeId: previousEpisode.episodeId,
          op: "supersede",
          actorId,
          authorizedById: source.connectAuthorizationId,
        });
      });
    }
    const input = buildConnectorIngestInput(source, item);
    const namesErasedPerson = await loadErasedPersonMatcher(source.orgId);
    if (namesErasedPerson(input.content) || namesErasedPerson(input.actorName ?? "")) {
      // Recorded as seen, with nothing written: the same version is skipped by
      // its checksum next time, and an edit is checked again.
      await db.sourceFile.upsert({
        where: { sourceId_externalFileId: { sourceId: source.id, externalFileId: item.id } },
        create: { sourceId: source.id, externalFileId: item.id, checksum: item.checksum },
        update: { checksum: item.checksum, episodeId: null, episodeScopePath: null, syncedAt: new Date() },
      });
      return "skipped";
    }
    const { episodeId } = await ingestMemorySync(input);
    await db.$transaction(async (tx) => {
      await tx.sourceFile.upsert({
        where: { sourceId_externalFileId: { sourceId: source.id, externalFileId: item.id } },
        create: {
          sourceId: source.id,
          externalFileId: item.id,
          checksum: item.checksum,
          episodeId,
          episodeScopePath: source.scopePath,
        },
        update: {
          checksum: item.checksum,
          episodeId,
          episodeScopePath: source.scopePath,
          syncedAt: new Date(),
        },
      });
      await recordSourceItemChange(tx, {
        orgId: source.orgId,
        scopePath: source.scopePath,
        episodeId,
        op: "create",
        actorId,
        title: item.text,
        authorizedById: source.connectAuthorizationId,
      });
      if (retired) {
        await recordReplacements(tx, [
          {
            orgId: source.orgId,
            replacementId: episodeId,
            replacementScopePath: source.scopePath,
            replacedId: retired.episodeId,
            replacedScopePath: retired.scopePath,
            actor: { type: "extraction", id: actorId },
          },
        ]);
      }
    });
    return "synced";
  } catch (e) {
    console.error(`[sourceSync] item ${item.id} failed for source ${source.id}:`, e);
    return "failed";
  }
}

/**
 * Retire one previously-synced item that no longer appears upstream (deleted,
 * or the channel/file is no longer reachable). Pulled out alongside
 * `syncOneTextItem` for the same durable-outcome reason. A genuine retirement
 * failure here leaves the `SourceFile` row in place (not deleted) so the next
 * sync's plan still lists it as vanished-but-not-yet-retired and retries it,
 * rather than silently giving up after one swallowed error.
 *
 * The retirement is announced as a `delete` in the same transaction as the
 * pointer drop that records it, so a retry of this step, which finds nothing
 * left to retire, cannot announce it a second time.
 */
export async function retireVanishedTextItem(
  source: Omit<SyncingSource, "name">,
  stale: ConnectorSyncFile,
): Promise<ConnectorSyncOutcome> {
  const sourceId = source.id;
  try {
    if (stale.episodeId) {
      const episodeId = stale.episodeId;
      const retiredFrom = await retireTextItemEpisode(source, stale.externalFileId, {
        episodeId,
        scopePath: stale.episodeScopePath,
      });
      // Record the retirement before dropping the row. If this step dies between
      // the two writes, the next sync sees a row with nothing left to retire and
      // deletes it — instead of retrying a delete that now correctly reports the
      // episode already gone, and so failing forever.
      await db.$transaction(async (tx) => {
        await tx.sourceFile.update({
          where: { sourceId_externalFileId: { sourceId, externalFileId: stale.externalFileId } },
          data: { episodeId: null, episodeScopePath: null, episodeRetireStartedAt: null },
        });
        await recordSourceItemChange(tx, {
          orgId: source.orgId,
          scopePath: retiredFrom,
          episodeId,
          op: "delete",
          actorId: connectorActorId(source),
          authorizedById: source.connectAuthorizationId,
        });
      });
    }
    await db.sourceFile.delete({
      where: { sourceId_externalFileId: { sourceId, externalFileId: stale.externalFileId } },
    });
    return "retired";
  } catch (e) {
    console.error(`[sourceSync] retiring vanished item ${stale.externalFileId} failed for source ${sourceId}:`, e);
    return "failed";
  }
}
