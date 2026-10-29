// The `source-sync` Inngest job: one durable run that brings a connected
// source's content in memory up to date with the source itself.
//
// It loads the source scoped to its org, lists what is upstream now, diffs
// that against what was synced before (`planConnectorSync`), and runs one
// Inngest step per item through the per-item logic in
// connector-text-items.ts or connector-drive-files.ts. This file is the
// orchestration and the terminal status write; the per-item work is not here.
//
// The one rule it enforces: a source disconnected, or moved to another scope,
// while the run is in flight never has its status written back by this run, and
// whatever the run wrote is retired afterwards. See `markWhileCurrent`,
// `retireAfterDisconnect` and `retireAfterMove`. A source its credential can no
// longer read keeps everything it stored and is marked as having lost access
// (services/connectors/source-access.ts).
import { db } from "@/lib/db";
import { unsealSecret } from "@/lib/crypto";
import type { Prisma } from "@/lib/generated/prisma/client";
import { graphitiStore } from "@/services/memory";
import {
  retireSourceContent,
  retireSourceContentAtScope,
  type RetirableSource,
} from "@/services/memory/source-retirement";
import { SourceAccessError } from "@/services/connectors/source-access";
import { reapplyDue } from "@/services/memory/erasure-suppression";
import { inngest } from "./client";
import { syncFailureMessage } from "./sync-failure-message";
import { runWhileSourceCurrent, stopReason, syncRequestIdOf, type ConnectorSyncOutcome } from "./source-state";
import { loadExistingFiles } from "./connector-existing-files";
import { blobListingStash, dropRunListings, listingPathname } from "@/lib/source-listing-blobs";
import { listInPages } from "./connector-listing-pages";
import { planConnectorSync, type ConnectorSyncFile } from "./connector-records";
import {
  listGitHubItems,
  listPostHogItems,
  listSlackItems,
  retireVanishedTextItem,
  syncOneTextItem,
  type ConnectorListing,
  type StoredSyncCursor,
} from "./connector-text-items";
import { processDriveFile, retireVanishedDriveFile, type DriveSyncFile } from "./connector-drive-files";

export const SOURCE_SYNC_EVENT = "source/sync.requested";

/**
 * What a `source-sync` event carries. Never a credential in clear: Inngest
 * stores every event outside the database and shows it in its dashboard, so a
 * token placed here would sit there, readable, for as long as the event is kept.
 */
export interface SourceSyncInput {
  sourceId: string;
  orgId: string;
  /** A credential the client supplied for this one sync, sealed with
   *  `sealSecret({ token })`: a gdrive OAuth token, which is short-lived and
   *  never stored, or a fresh Slack/Figma token sent with a re-sync. Absent
   *  otherwise; the job then reads the source's own sealed credential. */
  sealedToken?: string;
  /** The sync request a connect stamped on `Source.meta.syncRequestId` and fired
   *  this event for. A run whose request a newer connect has replaced stands down
   *  (`sourceWriteState` in ./source-state.ts). Absent on a re-sync the schedule or
   *  a person asked for; that run serves whatever request the row names when it starts. */
  syncRequestId?: string;
}

/** The token a sync's event sealed, opened inside the job. */
function unsealedEventToken(sealed: string): string {
  const { token } = unsealSecret(sealed) as { token?: unknown };
  if (typeof token !== "string" || token === "") throw new Error("sync event's sealed token is empty");
  return token;
}

/**
 * The token a Slack or Figma sync lists with: the one its event sealed, else
 * the source's own sealed credential, read here inside the job. A source with
 * no stored credential is a fixture-backed connect, whose connector takes "".
 */
export async function slackOrFigmaToken(
  source: { id: string; orgId: string },
  input: SourceSyncInput,
): Promise<string> {
  if (input.sealedToken) return unsealedEventToken(input.sealedToken);
  const { encryptedTokens } = await loadScopedSourceCredential(source.id, source.orgId);
  if (!encryptedTokens) return "";
  const { token } = unsealSecret(encryptedTokens) as { token?: unknown };
  if (typeof token !== "string") throw new Error(`source ${source.id}'s stored credential is missing a token`);
  return token;
}

/** Slack messages and Figma comments are already text — they ingest straight
 *  through `ingestMemory` (no file extraction), unlike Drive files. posthog
 *  joins them for the same reason: its one summarized insight is already
 *  text, no extraction step. */
const TEXT_SOURCE_TYPES = new Set(["slack", "figma", "posthog", "github"]);

/**
 * Load a source scoped to its owning org — the real tenant boundary for
 * connector sync. Pulled out of the `load-source` step so this DB-level guard
 * is directly testable: a caller-supplied orgId dropping out of this query's
 * `where` clause is a cross-tenant leak (a `sourceId` that exists under
 * another org becomes reachable), and the pure `buildConnectorIngestInput`
 * tests cannot see it.
 */
export async function loadScopedSource(sourceId: string, orgId: string) {
  return db.source.findFirstOrThrow({ where: { id: sourceId, orgId }, omit: { encryptedTokens: true } });
}

/**
 * Load a source's sealed credential, scoped to its owning org like
 * `loadScopedSource`. Kept apart from that loader because Inngest persists every
 * step's return value: the `load-source` row is stored outside the database and
 * replayed on retries, so it carries no credential. Only the step that unseals
 * this one reads it, and that step returns the listing, not the row.
 */
export async function loadScopedSourceCredential(sourceId: string, orgId: string) {
  return db.source.findFirstOrThrow({
    where: { id: sourceId, orgId },
    select: {
      id: true,
      externalId: true,
      meta: true,
      encryptedTokens: true,
      connectAuthorizationId: true,
      scopePath: true,
    },
  });
}

/** Aggregate a connector sync's per-item step outcomes into the same
 *  {synced, failed} shape `sourceSync` persists to `Source.meta`. A
 *  `"retired"`, `"skipped"` or `"superseded"` outcome isn't counted toward
 *  `synced`: a successful retirement or an idempotency skip never increments
 *  `synced`/`failed`. Pulled out so the aggregation itself is directly
 *  testable without simulating Inngest step replay. */
export function summarizeSyncOutcomes(outcomes: ConnectorSyncOutcome[]): { synced: number; failed: number } {
  let synced = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    if (outcome === "synced") synced++;
    else if (outcome === "failed") failed++;
  }
  return { synced, failed };
}

/** The object half of a source's existing `meta`, or `{}` if it isn't one —
 *  a merge base for `sourceSync`'s terminal steps, so writing sync status
 *  doesn't erase a connector's own fields already stored there (e.g.
 *  posthog's `projectId`/`host`). */
function sourceMeta(meta: unknown): Record<string, unknown> {
  return meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {};
}

/** `Source.meta` without the error, or the lost access, an earlier sync left. A
 *  sync that reaches its terminal write replaces that error with its own
 *  outcome; keeping it made a healthy source report a failure it no longer has.
 *  Without `syncRunId` too: a run that wrote its terminal status names no run that
 *  still reads a listing (`dropIdleListings`, lib/source-listing-blobs.ts). */
function withoutSyncError(meta: unknown): Record<string, unknown> {
  const { error: _previousError, accessLost: _previousAccessLost, syncRunId: _syncRunId, ...rest } = sourceMeta(meta);
  return rest;
}

/** `Source.meta` without anything an earlier run said about the source's
 *  content: its error, lost access, counts and unreadable parts. A run that
 *  stops early writes only what it found itself; the earlier values would read
 *  as its result ("0 synced", "Not synced: issues") beside the fix it stores. */
function withoutRunOutcome(meta: unknown): Record<string, unknown> {
  const {
    synced: _synced,
    skipped: _skipped,
    failed: _failed,
    unreadable: _unreadable,
    ...rest
  } = withoutSyncError(meta);
  return rest;
}

/** A listing step's answer when the credential cannot read the source at all. */
function accessLostListing(e: unknown): { accessLost: string } {
  if (e instanceof SourceAccessError) return { accessLost: e.message };
  throw e;
}

/** The terminal `Source.status` a sync run resolves to. One formula shared by
 *  the `complete` step and the fatal-error path (see `sourceSync`'s
 *  try/catch): a source that hit an uncaught error before any item finished
 *  processing always resolves to "error", the same as a normal run where
 *  nothing synced and something failed. */
export function sourceSyncStatus(counts: { synced: number; failed: number }, fatal = false): "active" | "error" {
  if (fatal) return "error";
  return counts.failed > 0 && counts.synced === 0 ? "error" : "active";
}

/**
 * Write a sync's terminal status and meta, only while the source is still
 * connected at the scope this run captured.
 *
 * `DELETE /api/sources/:id` keeps the row, so an unconditional write here would
 * flip a disconnected source back to "active" or "error" and it would read as
 * connected again. A reconnect that moved the scope already set the row's status
 * itself and fired its own sync, so this run's counts describe a scope the source
 * no longer uses. In both cases the write not landing is also how the run learns
 * it has content to retire: its last item can finish after every per-item check.
 *
 * @returns whether the row was written; false for a source that is disconnected, gone or moved,
 *   or whose sync request a newer connect replaced (`syncRequestId`).
 */
async function markWhileCurrent(
  source: RetirableSource & { syncRequestId?: string | null },
  data: Prisma.SourceUpdateManyMutationInput,
): Promise<boolean> {
  const { count } = await db.source.updateMany({
    where: {
      id: source.id,
      orgId: source.orgId,
      scopePath: source.scopePath,
      status: { not: "disconnected" },
      // A newer connect's sync owns the row's terminal status; this run's counts describe a pass it abandoned.
      ...(source.syncRequestId ? { meta: { path: ["syncRequestId"], equals: source.syncRequestId } } : {}),
    },
    data,
  });
  return count > 0;
}

/**
 * Retire what a sync run wrote for a source that was disconnected while it ran,
 * and drop the sync records it left behind.
 *
 * The route's own retirement ran before the run finished, so it missed any write
 * that was in flight at the time. This purge runs after the run's last write, so
 * it cannot. The `SourceFile` rows go too: the route already dropped the ones it
 * saw, and a row the run recorded afterwards would make a later reconnect skip
 * that item as unchanged, leaving the reconnected source without its content.
 *
 * Only while the source is still disconnected. The `concurrency` key serializes
 * steps, not runs, and a step that failed is retried later, so this step can run
 * after a reconnect at the same scope (the row is reused) and after that connect's
 * own sync: what the source holds then is the new connect's, and retiring it wipes
 * a connected source and leaves its sync reporting files it no longer has. The
 * reconnect retired what this run had left (`POST /api/sources`) before and after
 * it marked the source connected. The check and the purge share this one step,
 * which no step of the new connect's sync runs beside. A step of this run that
 * starts after the reconnect reads the request replaced and stops, since the
 * reconnect stamped a new `syncRequestId`; only a run that serves no request (one
 * replayed from before that field) still reads the source as current there and
 * writes from its old listing (`runWhileSourceCurrent`).
 */
async function retireAfterDisconnect(source: RetirableSource): Promise<void> {
  const current = await db.source.findFirst({
    where: { id: source.id, orgId: source.orgId },
    select: { status: true },
  });
  if (current && current.status !== "disconnected") return;
  await retireSourceContent(source, null);
  await db.sourceFile.deleteMany({ where: { sourceId: source.id } });
}

/**
 * Retire what a sync run wrote at the scope it captured, for a source a
 * reconnect moved to another scope while it ran, and drop the sync records that
 * pin items to that scope.
 *
 * `POST /api/sources` purges the old scope before it moves the pointer, so a
 * write already in flight then lands at the old scope after the purge: its facts
 * stay readable there, its change event carries the item text there, and its
 * `SourceFile` row would make the replacement sync skip that item as unchanged.
 * This runs after the run's last write, so it catches that write.
 *
 * Only the captured scope is touched. The `concurrency` key on `sourceSync`
 * limits steps, not runs, so the replacement sync the move fired can already
 * have written at the new scope; that content is the source's live content.
 * A pointer that moved away and came back is current again, and the
 * replacement sync is writing at this same scope, so nothing is retired: what
 * this run wrote there is the source's content at its current scope.
 */
async function retireAfterMove(source: RetirableSource): Promise<void> {
  const current = await db.source.findFirst({
    where: { id: source.id, orgId: source.orgId },
    select: { scopePath: true },
  });
  if (current?.scopePath === source.scopePath) return;
  await retireSourceContentAtScope(source, source.scopePath, current?.scopePath ?? null);
  await db.sourceFile.deleteMany({ where: { sourceId: source.id, episodeScopePath: source.scopePath } });
}

/** What a source whose sync run died says. The run's own error stays in Inngest's history. */
export const SYNC_DIED_MESSAGE = "The last sync stopped before it finished. Sync again to retry.";

/**
 * End the "syncing" a failed run left, once Inngest reports the run failed.
 *
 * The run's own try/catch writes its terminal status for an error its steps
 * report. A run can also fail without that catch running: the platform killed a
 * step until its retries ran out (a function timeout, a deploy that dropped the
 * request), or the catch's own status write failed. Inngest then calls only
 * `onFailure`, and without this write nothing else ever moves the source out of
 * "syncing": it reads as syncing forever and its `lastSyncAt` never moves.
 *
 * Written only while the failed run still owns the row's "syncing": the row is
 * "syncing" and names this run (`meta.syncRunId`, stamped by `load-source`). A
 * later run that took the source since (a newer connect's, the schedule's, a
 * person's re-sync) stamped its own id, so its sync is left to finish; a
 * disconnected source, or one whose run already wrote a terminal status, is not
 * "syncing". One conditional write, so a run taking the source at the same moment wins.
 *
 * @returns whether the row was written.
 */
export async function endSyncThatDied(input: SourceSyncInput, runId: string): Promise<boolean> {
  const owned = {
    id: input.sourceId,
    orgId: input.orgId,
    status: "syncing" as const,
    meta: { path: ["syncRunId"], equals: runId },
  };
  const row = await db.source.findFirst({ where: owned, select: { meta: true, updatedAt: true } });
  if (!row) return false;
  const { accessLost: _accessLost, syncRunId: _syncRunId, ...rest } = sourceMeta(row.meta);
  // `updatedAt` as read: every other writer of the row bumps it, so the merged meta never drops what one wrote.
  const { count } = await db.source.updateMany({
    where: { ...owned, updatedAt: row.updatedAt },
    data: { status: "error", meta: { ...rest, lastSyncAt: new Date().toISOString(), error: SYNC_DIED_MESSAGE } },
  });
  return count > 0;
}

export const sourceSync = inngest.createFunction(
  {
    id: "source-sync",
    name: "Source: sync folder into memory",
    retries: 2,
    // A run that failed without reaching its own terminal write; see `endSyncThatDied`.
    // Then any listing it stored and did not delete (lib/source-listing-blobs.ts).
    onFailure: async ({ event }) => {
      const input = event.data.event.data as SourceSyncInput;
      // The listing goes whether or not the status write throws. When both throw, the
      // status write's error is the one reported and the cleanup's is logged.
      let statusError: { error: unknown } | null = null;
      try {
        await endSyncThatDied(input, event.data.run_id);
      } catch (error) {
        statusError = { error };
      }
      try {
        await dropRunListings(input, event.data.run_id);
      } catch (cleanupError) {
        if (!statusError) throw cleanupError;
        console.error(`[sourceSync] run ${event.data.run_id}: its stored listing is still to be deleted`, cleanupError);
      }
      if (statusError) throw statusError.error;
    },
    // One sync at a time per source. A reconnect that moves `Source.scopePath`
    // purges the old scope and fires a fresh sync against the new one; without
    // this key that new run interleaves with the one already in flight, so the
    // purge can land in the middle of a write the older run already started and the
    // per-item `runWhileSourceCurrent` check cannot see it in time. Serializing
    // them means the older run reaches its next item, observes the moved
    // pointer, and stops before the replacement does anything.
    concurrency: [{ key: "event.data.sourceId", limit: 1 }],
    triggers: [{ event: SOURCE_SYNC_EVENT }],
  },
  async ({ event, step, runId }) => {
    const input = event.data as SourceSyncInput;

    // Load source (tenant-scoped — see loadScopedSource) and mark syncing. A
    // job queued before a disconnect can start after it; marking that source
    // "syncing" would read as connected again, so it is left as it is and the
    // run ends before its first write.
    // A restored database whose erasures are not yet re-applied (services/memory/erasure-reapply.ts,
    // completeRestore) syncs nothing: the source is left as it is, and the scheduled re-sync
    // (source-resync.ts) runs it again once the restore-completion job has finished.
    if (await step.run("check-restore-complete", () => reapplyDue(input.orgId))) {
      return {
        files: 0,
        synced: 0,
        skipped: 0,
        failed: 0,
        superseded: false,
        disconnected: false,
        restoreIncomplete: true,
      };
    }
    // A run fired by a connect serves that connect's sync request. One whose request a
    // newer connect already replaced while it was queued starts nothing: the newer
    // connect fired its own sync, and two full syncs of one source alternate steps to
    // the end and ingest every item twice. A run with no request of its own (the
    // schedule, a person's re-sync) serves the one the row names now.
    //
    // The run that marks the source "syncing" also stamps its own Inngest run id on
    // `Source.meta.syncRunId`: the row then names the one run that owns its "syncing",
    // which is how `onFailure` knows a failed run's "syncing" is its own to end
    // (`endSyncThatDied`). The stamp is conditional on the row as read, so a connect
    // landing in between is never overwritten; the run reads the row again instead.
    const source = await step.run("load-source", async () => {
      for (let attempt = 0; ; attempt++) {
        const s = await loadScopedSource(input.sourceId, input.orgId);
        const stored = syncRequestIdOf(s.meta);
        // A row that kept changing under the stamp has a newer writer; that one owns it.
        const replaced = (Boolean(input.syncRequestId) && stored !== input.syncRequestId) || attempt === 3;
        const syncRequestId = input.syncRequestId ?? stored;
        // Only set fields are added, so a source no connect stamped is captured as before.
        const captured: typeof s & { syncRequestId?: string; replaced?: true } = {
          ...s,
          ...(syncRequestId ? { syncRequestId } : {}),
          ...(replaced ? { replaced: true as const } : {}),
        };
        if (s.status === "disconnected" || replaced) return captured;
        const { count } = await db.source.updateMany({
          where: { id: input.sourceId, orgId: input.orgId, updatedAt: s.updatedAt },
          data: { status: "syncing", ...(runId ? { meta: { ...sourceMeta(s.meta), syncRunId: runId } } : {}) },
        });
        if (count > 0) return captured;
      }
    });
    if (source.status === "disconnected") {
      return { files: 0, synced: 0, skipped: 0, failed: 0, superseded: false, disconnected: true };
    }
    if (source.replaced) {
      return { files: 0, synced: 0, skipped: 0, failed: 0, superseded: true, disconnected: false };
    }

    /** Retire what this run left behind once the source moved or was disconnected under it. */
    const retireAfter = (reason: "superseded" | "disconnected") =>
      reason === "superseded"
        ? step.run("retire-after-move", () => retireAfterMove(source))
        : step.run("retire-after-disconnect", () => retireAfterDisconnect(source));

    /** Why a conditional status write did not land. A pointer that moved away and
     *  back reads as current again; it still left this run's scope, so it is a move. */
    const whyNotCurrent = (name: string) =>
      step.run(name, async () => (await stopReason(source)) ?? ("superseded" as const));

    /**
     * End a run whose credential cannot read the source at all. Nothing stored is
     * retired or rewritten: the source keeps its content, cursor and records, is
     * marked `error` with `meta.accessLost` and the fix in `meta.error` (and no
     * counts or unreadable parts, which only a run that read the source has), and the
     * schedule stops re-syncing it (source-resync.ts) until a sync or reconnect
     * reads it again. No retry: the next attempt would get the same answer.
     */
    const endAccessLost = async (message: string) => {
      const marked = await step.run("mark-access-lost", async () =>
        markWhileCurrent(source, {
          status: "error",
          meta: {
            ...withoutRunOutcome(source.meta),
            lastSyncAt: new Date().toISOString(),
            fileCount: await db.sourceFile.count({ where: { sourceId: source.id } }),
            error: message,
            accessLost: true,
          },
        }),
      );
      const reason = marked ? null : await whyNotCurrent("why-not-marked-access-lost");
      if (reason) await retireAfter(reason);
      return {
        files: 0,
        synced: 0,
        skipped: 0,
        failed: 0,
        accessLost: true,
        superseded: reason === "superseded",
        disconnected: reason === "disconnected",
      };
    };

    let synced = 0;
    let skipped = 0;
    let failed = 0;
    // Every per-item step's outcome so far. A run that stops part way still
    // reports what it did (`tally`), never zeros it did not measure.
    const outcomes: ConnectorSyncOutcome[] = [];
    const tally = () => {
      ({ synced, failed } = summarizeSyncOutcomes(outcomes));
      // A text listing counts what it skipped before the steps; a Drive file reports its own skip.
      if (!TEXT_SOURCE_TYPES.has(source.type)) skipped = outcomes.filter((outcome) => outcome === "skipped").length;
    };
    let itemCount = 0;
    // Set once a per-item guard reports the source moved or was disconnected
    // under this run. See `runWhileSourceCurrent` and the early returns below.
    let stoppedBy: "superseded" | "disconnected" | null = null;
    // Parts of the source the stored credential may not read, from the listing.
    let unreadable: string[] | undefined;
    // Where an incremental listing continues next sync, and what a sync where an
    // item failed stores instead.
    let syncCursor: StoredSyncCursor | undefined;
    let heldCursor: StoredSyncCursor | undefined;

    // Everything below runs inside one try so that ANY failure path (e.g. the
    // listing call itself throwing) still reaches a terminal status before the
    // error is rethrown. An uncaught failure would skip the `complete` step
    // entirely; only a run that fails without reaching this catch is left to
    // `onFailure` (`endSyncThatDied`). Rethrowing preserves Inngest's own
    // retry/failure reporting for this attempt.
    try {
      if (TEXT_SOURCE_TYPES.has(source.type)) {
        const existingFiles = await loadExistingFiles(
          step.run.bind(step) as never,
          source.id,
          (f): ConnectorSyncFile => ({
            externalFileId: f.externalFileId,
            checksum: f.checksum,
            episodeId: f.episodeId,
            episodeScopePath: f.episodeScopePath,
          }),
        );

        // Slack / Figma: read-only listing, straight into memory as text episodes.
        const listing = await listInPages(
          step.run.bind(step) as never,
          "list-items",
          listingPathname(source.orgId, source.id, runId, "items"),
          async (): Promise<ConnectorListing> => {
            // The token is opened in this step and never returned from it, so it
            // stays out of the step output Inngest persists.
            if (source.type === "slack") {
              const token = await slackOrFigmaToken(source, input);
              return listSlackItems(
                source,
                token,
                existingFiles.map((f) => f.externalFileId),
              );
            }
            if (source.type === "figma") {
              const { listFileComments } = await import("@/services/connectors/figma");
              return { items: await listFileComments(source.externalId, await slackOrFigmaToken(source, input)) };
            }
            // github and posthog read their credential off the row, so they read
            // the row as it is now, not the `load-source` snapshot. Inngest
            // replays that snapshot on every retry of this step, and a reconnect
            // that replaces a rejected credential can land between two of those
            // retries.
            // Listing with the stored credential makes the next attempt the one
            // that recovers, instead of failing on the credential it already
            // knows is rejected and writing that failure back over the row the
            // reconnect just cleared.
            const stored = await loadScopedSourceCredential(source.id, source.orgId);
            try {
              if (source.type === "github")
                return await listGitHubItems(
                  stored,
                  existingFiles.map((f) => f.externalFileId),
                );
              return { items: await listPostHogItems(stored) };
            } catch (e) {
              return { items: [], ...accessLostListing(e) };
            }
          },
          async () => blobListingStash(source.orgId, source.id, runId),
        );
        if (listing.accessLost) return await endAccessLost(listing.accessLost);
        const { items } = listing;
        unreadable = listing.unreadable;
        syncCursor = listing.cursor;
        heldCursor = listing.heldCursor;
        itemCount = items.length;

        const plan = planConnectorSync(existingFiles, items, source.scopePath, listing.gone);
        skipped = plan.skippedCount;

        for (const { item, previousEpisode } of plan.toIngest) {
          const outcome = await step.run(`process-item-${item.id}`, () =>
            runWhileSourceCurrent(source, (current) => syncOneTextItem(current, item, previousEpisode)),
          );
          outcomes.push(outcome);
          if (outcome === "superseded" || outcome === "disconnected") {
            stoppedBy = outcome;
            break;
          }
        }
        if (!stoppedBy) {
          for (const stale of plan.toRetire) {
            const outcome = await step.run(`retire-vanished-${stale.externalFileId}`, () =>
              runWhileSourceCurrent(source, (current) => retireVanishedTextItem(current, stale)),
            );
            outcomes.push(outcome);
            if (outcome === "superseded" || outcome === "disconnected") {
              stoppedBy = outcome;
              break;
            }
          }
        }
        tally();
      } else {
        // Drive: ingest each new or edited file in its own step, then retire
        // the files that left the folder.
        const { putPrivateBlob, deletePrivateBlob } = await import("@/lib/blob-storage");
        const { listFolderFiles, downloadFile } = await import("@/services/connectors/gdrive");

        // gdrive has no stored credential: its event always seals the client's token.
        const sealedDriveToken = input.sealedToken;
        if (!sealedDriveToken) throw new Error(`gdrive source ${source.id}'s sync event carries no token`);
        const driveToken = () => unsealedEventToken(sealedDriveToken);
        // An array, as before access loss was reported, so a run replaying this
        // step's stored output from an older deploy still reads it.
        const listed = await listInPages(
          step.run.bind(step) as never,
          "list-files",
          listingPathname(source.orgId, source.id, runId, "files"),
          () => listFolderFiles(source.externalId, driveToken()).catch(accessLostListing),
          async () => blobListingStash(source.orgId, source.id, runId),
        );
        if (!Array.isArray(listed)) return await endAccessLost(listed.accessLost);
        const files = listed;
        itemCount = files.length;

        const existingFiles = await loadExistingFiles(
          step.run.bind(step) as never,
          source.id,
          (f): DriveSyncFile => ({
            externalFileId: f.externalFileId,
            checksum: f.checksum,
            episodeIds: f.episodeIds,
            chunkIds: f.chunkIds,
            episodeScopePath: f.episodeScopePath,
          }),
        );

        for (const file of files) {
          const outcome = await step.run(`process-file-${file.id}`, () =>
            runWhileSourceCurrent(source, (current) =>
              processDriveFile(current, file, driveToken(), {
                downloadFile,
                put: putPrivateBlob,
                del: deletePrivateBlob,
              }),
            ),
          );
          outcomes.push(outcome);
          if (outcome === "superseded" || outcome === "disconnected") {
            stoppedBy = outcome;
            break;
          }
        }
        if (!stoppedBy) {
          const listedIds = new Set(files.map((file) => file.id));
          for (const stale of existingFiles.filter((f) => !listedIds.has(f.externalFileId))) {
            const outcome = await step.run(`retire-vanished-${stale.externalFileId}`, () =>
              runWhileSourceCurrent(source, (current) => retireVanishedDriveFile(current, stale)),
            );
            outcomes.push(outcome);
            if (outcome === "superseded" || outcome === "disconnected") {
              stoppedBy = outcome;
              break;
            }
          }
        }
        // The same entity merge an uploaded file gets after its ingest. It
        // tidies the graph rather than changing what the sync recorded, so a
        // failure is logged instead of turning a completed sync into an error.
        // A stopped run skips it with the rest of its work.
        if (!stoppedBy && outcomes.includes("synced")) {
          await step.run("dedup-nodes", () =>
            graphitiStore.dedupeNodes(source.orgId).catch((e) => {
              console.warn(`[sourceSync] entity dedup failed for source ${source.id}:`, e);
              return 0;
            }),
          );
        }
        tally();
      }
    } catch (e) {
      tally();
      // The person reads a line naming the fix; the rethrow below keeps the provider's own answer.
      const message = syncFailureMessage(source.type, e);
      const marked = await step.run("mark-sync-error", () =>
        markWhileCurrent(source, {
          status: sourceSyncStatus({ synced, failed }, true),
          // A failure that is not GitHub saying "no access" says nothing about access either.
          meta: {
            ...withoutRunOutcome(source.meta),
            lastSyncAt: new Date().toISOString(),
            fileCount: itemCount,
            synced,
            skipped,
            failed,
            ...(unreadable ? { unreadable } : {}),
            error: message,
          },
        }),
      );
      // This run reads no listing after this point. Its stored one goes now, whether or
      // not the write above landed: one that did not (a reconnect replaced this run's
      // sync request) returns below without failing, so `onFailure` never runs, and
      // the row may still name this run (a reconnect keeps `meta.syncRunId`), so an
      // erasure would keep the listing too.
      await step.run("drop-run-listings", () => dropRunListings({ orgId: source.orgId, sourceId: source.id }, runId));
      // A disconnected or moved source has no sync of this run's left to retry.
      // What this run wrote before failing is retired instead, and the failure
      // ends here.
      if (!marked) {
        const reason = await whyNotCurrent("why-not-marked");
        await retireAfter(reason);
        return {
          files: itemCount,
          synced,
          skipped,
          failed,
          superseded: reason === "superseded",
          disconnected: reason === "disconnected",
        };
      }
      throw e;
    }

    // Update source status + last sync metadata, unless the source moved or was
    // disconnected under this run. Merge into the existing Source.meta rather
    // than replace it — a connector like posthog stores its own non-secret
    // upstream address there (projectId/host), written once at connect time, and
    // a wholesale replace here would drop it after the first sync.
    //
    // A run a per-item guard already stopped skips the write. A reconnect that
    // moved the pointer set `status: "active"` in its own upsert, and this run's
    // counts describe a partial pass over a scope the source no longer uses; a
    // disconnected row must not read as connected again. A move or disconnect that
    // lands after the last per-item check is caught by the write's own condition.
    //
    // Either way, the route retired the source's content before this run's last
    // write could finish, so whatever that write left is retired here.
    //
    // An incremental listing's cursor advances only when nothing failed: an item
    // that failed (the episode cap reached, the memory service down) is listed
    // again by the next sync only if the cursor stays behind it. A failed sync
    // stores the listing's held cursor, which keeps every pass behind but lets
    // the deletion probe move on. `fileCount` is then what the source holds,
    // since the listing names only what changed.
    if (stoppedBy === null) {
      const nextCursor = failed === 0 ? syncCursor : heldCursor;
      const completed = await step.run("complete", async () =>
        markWhileCurrent(source, {
          status: sourceSyncStatus({ synced, failed }),
          meta: {
            ...withoutSyncError(source.meta),
            lastSyncAt: new Date().toISOString(),
            fileCount: syncCursor ? await db.sourceFile.count({ where: { sourceId: source.id } }) : itemCount,
            synced,
            skipped,
            failed,
            ...(unreadable ? { unreadable } : {}),
            ...(nextCursor ? { syncCursor: nextCursor } : {}),
          },
        }),
      );
      if (!completed) stoppedBy = await whyNotCurrent("why-not-completed");
    }
    if (stoppedBy) await retireAfter(stoppedBy);

    // `skipped` is reported as-is on a stopped run: it counts items this run
    // never had to touch, which is still true of the ones it reached.
    return {
      files: itemCount,
      synced,
      skipped,
      failed,
      superseded: stoppedBy === "superseded",
      disconnected: stoppedBy === "disconnected",
    };
  },
);
