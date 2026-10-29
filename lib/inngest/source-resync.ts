// The scheduled re-sync: every half hour, queue a `source-sync` run for each
// connected GitHub source.
//
// Without it a source only re-syncs when someone asks (POST
// /api/sources/:id/sync) or reconnects, so a change at the source never
// arrives and an item deleted there keeps answering indefinitely. Each run reads
// what changed since the last one and asks GitHub about a slice of the stored
// items (services/connectors/github.ts), so a deletion is found by the run
// whose check reaches that item.
//
// The one rule it enforces: a scheduled run never carries a credential. Only
// GitHub sources are queued: their sync job reads its own credential off the
// row, so their events carry none, the same as the manual route sends for
// them. gdrive's token is client-held, so it re-syncs only when asked; slack
// and figma read theirs off the row too but are not on the schedule. PostHog also
// reads its own credential, but its one item is an insight summary whose text
// changes on every refresh, so each scheduled run would pay for a fresh
// extraction; it stays manual until that cost is decided. The queued run is
// the ordinary `source-sync` job: it loads the source by id and org, so the
// scheduled path adds no new way to reach a source.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { inngest } from "./client";
import { SOURCE_SYNC_EVENT, type SourceSyncInput } from "./connector-sync";

/** Source types the schedule re-syncs. */
export const SCHEDULED_RESYNC_TYPES = ["github"] as const;

/** How often the schedule fires, and the slot that makes a run's events idempotent. */
export const RESYNC_INTERVAL_MS = 30 * 60 * 1000;

/**
 * How long a source may sit in `syncing` before the schedule queues it anyway.
 * A run still in progress is left alone so a slow source does not pile up
 * queued runs behind its per-source concurrency key; a source left `syncing`
 * by a run that died is picked up again after this.
 */
export const STALE_SYNCING_MS = 2 * 60 * 60 * 1000;

export interface ScheduledResyncSource {
  id: string;
  orgId: string;
}

/**
 * The sources the schedule re-syncs at `now`: a scheduled type, a stored
 * credential, not disconnected, not in the middle of a recent sync, and not
 * one whose credential lost access to it (`meta.accessLost`, set by
 * connector-sync.ts) unless a run asked for since then died in `syncing`. That one waits for a person to grant access and sync or
 * reconnect, rather than asking GitHub the same question every half hour.
 */
export async function selectScheduledResyncSources(now: Date): Promise<ScheduledResyncSource[]> {
  const staleBefore = new Date(now.getTime() - STALE_SYNCING_MS);
  return db.source.findMany({
    where: {
      type: { in: [...SCHEDULED_RESYNC_TYPES] },
      encryptedTokens: { not: null },
      OR: [
        {
          status: { in: ["active", "error"] },
          // A row whose meta has no `accessLost` must stay in: `NOT (path = true)`
          // alone is NULL for it in SQL, which drops every healthy source.
          OR: [
            { meta: { path: ["accessLost"], equals: Prisma.AnyNull } },
            { NOT: { meta: { path: ["accessLost"], equals: true } } },
          ],
        },
        // A run that died is picked up again whatever the source's last result was.
        { status: "syncing", updatedAt: { lt: staleBefore } },
      ],
    },
    select: { id: true, orgId: true },
    orderBy: { id: "asc" },
  });
}

/**
 * One `source-sync` event per source, each with an id fixed by the source and
 * the half-hour slot `now` falls in. Inngest drops an event whose id it has
 * already accepted, so a retried or doubled schedule run queues each source
 * once per slot.
 */
export function scheduledResyncEvents(sources: ScheduledResyncSource[], now: Date) {
  const slot = Math.floor(now.getTime() / RESYNC_INTERVAL_MS);
  return sources.map((source) => ({
    id: `scheduled-resync:${source.id}:${slot}`,
    name: SOURCE_SYNC_EVENT,
    data: { sourceId: source.id, orgId: source.orgId } satisfies SourceSyncInput,
  }));
}

export const sourceScheduledResync = inngest.createFunction(
  {
    id: "source-scheduled-resync",
    name: "Source: scheduled re-sync",
    triggers: [{ cron: "*/30 * * * *" }],
  },
  async ({ step }) => {
    // The time is taken inside the step so a retry replays the same slot. One
    // step, not two: Inngest bills every step, and this one fires 48 times a day.
    const { nowIso, sources } = await step.run("select-sources", async () => {
      const now = new Date();
      return { nowIso: now.toISOString(), sources: await selectScheduledResyncSources(now) };
    });
    if (sources.length === 0) return { queued: 0 };
    await step.sendEvent("queue-syncs", scheduledResyncEvents(sources, new Date(nowIso)));
    return { queued: sources.length };
  },
);
