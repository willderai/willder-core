// Whether a connector write may still happen for the source it names, and
// what to do when it may not. The one rule: a write is allowed only while the
// source is still connected at the scope the write goes to — a reconnect that
// moved the scope, a disconnect, or a source that never had a connect row
// stops it instead.
import { db } from "@/lib/db";

/**
 * Outcome of processing one connector-sync item (a fresh ingest, or a
 * retirement of a vanished item). Returned by the corresponding `step.run`
 * call so Inngest persists it as that step's own durable output.
 *
 * Never count outcomes in a `let` mutated INSIDE a `step.run` closure. Inngest
 * only re-invokes a step's closure on the attempt that actually executes it; a
 * replay that serves an already-completed step from its memoized cache never
 * re-runs the closure, so a run that replays after a crash would report
 * `failed: 0` for items that genuinely failed on a prior attempt. Inngest
 * replays the SAME cached return value either way, so aggregating from the
 * returned array (see `summarizeSyncOutcomes`) is correct regardless of which
 * attempt executed which item. This holds for the DRIVE branch as well as the
 * TEXT branch: `"skipped"` (drive-only — an unchanged checksum short-circuits
 * before any sync attempt) makes that branch's idempotency skip a durable
 * per-step return value too.
 */
export type ConnectorSyncOutcome = "synced" | "failed" | "retired" | "skipped" | "superseded" | "disconnected";

/**
 * Whether a sync run may still write for the source it captured, and if not, why.
 *
 * - `"current"`: the source is connected and still points at the captured scope.
 * - `"moved"`: a reconnect moved `Source.scopePath`. `POST /api/sources` retires
 *   the old scope's content and fires its own sync against the new one, so a
 *   write from this run would re-strand content under the scope it just left.
 * - `"disconnected"`: `DELETE /api/sources/:id` ran. The route keeps the row and
 *   sets `status: "disconnected"`, so the pointer alone never shows it: a first
 *   sync still in flight would keep ingesting after the route had retired the
 *   source's content, and everything it wrote would stay retrievable. A missing
 *   row is treated the same way — there is no source left to write for.
 *
 * `sourceSync` reads the `Source` row once, in its `load-source` step, and
 * carries it for the whole job; this re-read moves the check to write time. The
 * org is part of the lookup for the same reason `loadScopedSource` carries it —
 * a source id alone is not a tenant.
 */
export type SourceWriteState = "current" | "moved" | "disconnected" | "replaced";

/**
 * The source as a sync run captured it. `syncRequestId` is the sync request the run
 * serves (`Source.meta.syncRequestId`, stamped by `POST /api/sources`); a run that
 * names one may write only while the row still names the same one. A newer connect
 * of the same source stamps a new id and fires its own sync, so the older run reads
 * `"replaced"` and stands down instead of running a second full sync beside it: the
 * `concurrency` key on `sourceSync` serializes steps, not runs, so the two would
 * alternate steps to the end and ingest every item twice. A write that names no
 * request (an ingest's own check, a run replayed from before this field) skips it.
 */
export type CapturedSource = { id: string; orgId: string; scopePath: string; syncRequestId?: string | null };

export async function sourceWriteState(source: CapturedSource): Promise<SourceWriteState> {
  return (await readWriteState(source)).state;
}

/** The sync request a `Source.meta` names, or null. */
export function syncRequestIdOf(meta: unknown): string | null {
  const id = meta && typeof meta === "object" ? (meta as Record<string, unknown>).syncRequestId : undefined;
  return typeof id === "string" ? id : null;
}

/** {@link sourceWriteState}, with the connect the stored row now names. */
async function readWriteState(
  source: CapturedSource,
): Promise<{ state: SourceWriteState; connectAuthorizationId: string | null }> {
  const current = await db.source.findFirst({
    where: { id: source.id, orgId: source.orgId },
    select: { scopePath: true, status: true, connectAuthorizationId: true, meta: true },
  });
  if (!current || current.status === "disconnected") return { state: "disconnected", connectAuthorizationId: null };
  if (current.scopePath !== source.scopePath)
    return { state: "moved", connectAuthorizationId: current.connectAuthorizationId };
  if (source.syncRequestId && syncRequestIdOf(current.meta) !== source.syncRequestId) {
    return { state: "replaced", connectAuthorizationId: current.connectAuthorizationId };
  }
  return { state: "current", connectAuthorizationId: current.connectAuthorizationId };
}

/** Whether the source is still connected at the scope this run captured. */
export async function sourceScopeIsCurrent(source: CapturedSource): Promise<boolean> {
  return (await sourceWriteState(source)) === "current";
}

/**
 * Run one sync write only while the source is still connected at the scope this
 * run captured. Otherwise report why instead of writing: `"superseded"` when the
 * scope moved, `"disconnected"` when the source was disconnected. The write is handed
 * the source as captured, with the `connectAuthorizationId` the row holds now.
 *
 * Callers stop the run on either rather than continuing to the next item. The
 * route has already retired the source's content: a move purged the old scope
 * and fired a resync at the new one; a disconnect retired everything.
 * `sourceSync` retires again once it stops (`retireAfterMove`,
 * `retireAfterDisconnect`), which is what catches a write that was already in
 * flight when the route ran.
 *
 * This narrows the window to a single write rather than removing it — the row
 * can still change between this read and the write it guards. The retirement
 * after the run stops is the other half. For a move it reaches the old scope
 * only: the `concurrency` key on `sourceSync` limits steps, not runs, so the
 * superseding run can already be writing at the new scope.
 */
export async function runWhileSourceCurrent<S extends CapturedSource & { connectAuthorizationId: string | null }>(
  source: S,
  write: (current: S) => Promise<ConnectorSyncOutcome>,
): Promise<ConnectorSyncOutcome> {
  const { state, connectAuthorizationId } = await readWriteState(source);
  // A newer sync request for the same scope is a supersession that keeps the scope:
  // the run stops, and `retireAfterMove` finds the scope unchanged and retires nothing.
  if (state === "moved" || state === "replaced") return "superseded";
  if (state === "disconnected") return "disconnected";
  // A reconnect at the same scope leaves the run writing but replaces the connect it
  // writes under, so the write names the connect in force now, not the run's snapshot.
  return write({ ...source, connectAuthorizationId });
}

/**
 * Why a sync must stop writing for this source now, or null while it is still
 * connected at the scope the run captured. A writer that makes more than one
 * write per item asks again before each one, since the row can change between
 * them.
 */
export async function stopReason(source: CapturedSource): Promise<"superseded" | "disconnected" | null> {
  const state = await sourceWriteState(source);
  if (state === "moved" || state === "replaced") return "superseded";
  if (state === "disconnected") return "disconnected";
  return null;
}

/**
 * Whether an ingest may write for the source it names (`IngestInput.sourceId`,
 * `FileIngestInput.sourceId`). An ingest naming no source is not a connector
 * write and always may. One naming a source may only while that source has a
 * connect row in the ingest's own org (`groupId`) that is not disconnected and
 * points at the scope the ingest writes into; one naming a source but no scope
 * is refused, since an absent scope must never widen to the org root.
 */
export async function ingestSourceIsConnected(input: {
  groupId: string;
  scopePath?: string;
  sourceId?: string;
}): Promise<boolean> {
  if (!input.sourceId) return true;
  if (!input.scopePath) return false;
  return sourceScopeIsCurrent({ id: input.sourceId, orgId: input.groupId, scopePath: input.scopePath });
}
