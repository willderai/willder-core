// The background job of a person erasure asked for over HTTP
// (services/memory/person-erasure-requests.ts): POST /api/access/erasure records the request
// and queues this job, which runs the erasure. The event carries only the request id, so the
// person never reaches the queue. A failed run is retried: every step of an erasure is
// idempotent and its last one commits at most once. A scheduled sweep queues once more the job
// of a request that never finished, and fails the request if it still does not. It imports its
// service lazily, as the other jobs do, to stay out of the runner/tools/lib-inngest module-load cycle.
import { NonRetriableError } from "inngest";
import { MemoryServiceError } from "@/services/memory/graphiti-store";
import { inngest } from "./client";

/** Sent once per accepted erasure request; carries only its id. */
const PERSON_ERASURE_REQUESTED_EVENT = "person/erasure.requested";

/** Queue the job of a recorded request. The event id makes a resend a no-op. */
export async function queuePersonErasure(requestId: string): Promise<void> {
  await inngest.send({ id: `person-erasure-${requestId}`, name: PERSON_ERASURE_REQUESTED_EVENT, data: { requestId } });
}

/**
 * Queue the job of a request again, for the stuck-request sweep. Its own event id makes the
 * sweep's resend a no-op, and keeps it apart from the first event's.
 */
export async function requeuePersonErasure(requestId: string): Promise<void> {
  await inngest.send({
    id: `person-erasure-${requestId}-retry`,
    name: PERSON_ERASURE_REQUESTED_EVENT,
    data: { requestId },
  });
}

/** What a caller of a request is told when the graph holds a link out of the org: no retry can succeed. */
const NEEDS_OPERATOR =
  "Nothing more was erased: a graph node naming this person links outside this org and needs an operator.";

/**
 * What a caller is told when the retries ran out. The error itself is not kept: a store's
 * message can quote what it was removing.
 */
const RETRIES_RAN_OUT = "The erasure did not finish. Send the same request again to complete it.";

export const personErasure = inngest.createFunction(
  {
    id: "person-erasure",
    name: "Person erasure: erase the person a request names",
    triggers: [{ event: PERSON_ERASURE_REQUESTED_EVENT }],
    // One run per request at a time; each run's last step commits at most once anyway.
    concurrency: { key: "event.data.requestId", limit: 1 },
    retries: 4,
    onFailure: async ({ event, error }) => {
      const requestId = String(event.data.event.data.requestId);
      console.error(`[erasure] ${requestId}: failed after its retries`, { error });
      const { failPersonErasureRequest } = await import("@/services/memory/person-erasure-requests");
      await failPersonErasureRequest(requestId, RETRIES_RAN_OUT);
    },
  },
  async ({ event, step }) => {
    const requestId = String(event.data.requestId);
    return step.run("erase", async () => {
      const { failPersonErasureRequest, runPersonErasureRequest } = await import(
        "@/services/memory/person-erasure-requests"
      );
      try {
        const status = await runPersonErasureRequest(requestId);
        return { requestId, ran: status !== null };
      } catch (e) {
        // Inngest keeps a run's error in its history: a store's message can quote what it was
        // removing, so it is logged here and the run carries a fixed sentence.
        console.error(`[erasure] ${requestId}: attempt failed`, { error: e });
        if (!(e instanceof MemoryServiceError && e.status === 409))
          throw new Error(`person erasure ${requestId}: attempt failed`);
        await failPersonErasureRequest(requestId, NEEDS_OPERATOR);
        throw new NonRetriableError(`person erasure ${requestId}: needs an operator`);
      }
    });
  },
);

// Every 10 minutes: a request running past STUCK_AFTER_MS is queued once more, then failed
// (services/memory/person-erasure-requests.ts, sweepStuckPersonErasures). One pass at a time.
export const personErasureSweep = inngest.createFunction(
  {
    id: "person-erasure-sweep",
    name: "Person erasure: retry, then fail, requests whose job never finished",
    concurrency: { limit: 1 },
    triggers: [{ cron: "*/10 * * * *" }],
  },
  async ({ step }) =>
    step.run("sweep", async () => {
      const { sweepStuckPersonErasures } = await import("@/services/memory/person-erasure-requests");
      return sweepStuckPersonErasures(requeuePersonErasure);
    }),
);

/**
 * Completes a backup restore without an operator: every ten minutes, when a copy-back of the
 * suppression list has left an org due (migration 20261019100000_erasure_reapply_due), it
 * re-applies that org's erasures (services/memory/erasure-reapply.ts, completeRestore). Until it
 * has, check() refuses everything in the org but access.manage. With nothing due it makes one
 * read and returns. One run at a time; a run that stops part-way is completed by the next.
 */
export const restoreCompletion = inngest.createFunction(
  {
    id: "restore-completion",
    name: "Restore: re-apply erasures a copied-back suppression list names",
    concurrency: { limit: 1 },
    retries: 0,
    triggers: [{ cron: "*/10 * * * *" }],
  },
  async ({ step }) =>
    step.run("complete-restore", async () => {
      const { orgsWithReapplyDue } = await import("@/services/memory/erasure-suppression");
      if ((await orgsWithReapplyDue()).length === 0) return { orgs: 0, notApplied: [] };
      const { completeRestore } = await import("@/services/memory/erasure-reapply");
      const completions = await completeRestore({ only: "due" });
      const notApplied = completions.filter((c) => !c.applied).map((c) => c.orgId);
      // Counts and org ids only: an error's text can quote what a store was removing.
      if (notApplied.length > 0)
        console.error(`[restore] erasures not yet re-applied in ${notApplied.length} org(s)`, { notApplied });
      return { orgs: completions.length, notApplied };
    }),
);
