// The two background jobs of an org deletion (services/memory/org-deletion): the final export,
// made right after the request, and the sweep that clears the stores once 7 days are up.
// The sweep also makes any export the first job did not, so a lost or failed event
// costs at most one sweep interval. Both import their service lazily, as the other jobs
// do, to stay out of the runner/tools/lib-inngest module-load cycle.
import { inngest } from "./client";

/** Sent once per deletion when it starts; carries only its id. */
const ORG_DELETION_STARTED_EVENT = "org/deletion.started";

/** Queue the final export of a deletion that just started. The event id makes a resend a no-op. */
export async function queueFinalExport(deletionId: string): Promise<void> {
  await inngest.send({
    id: `org-deletion-export-${deletionId}`,
    name: ORG_DELETION_STARTED_EVENT,
    data: { deletionId },
  });
}

export const orgDeletionFinalExport = inngest.createFunction(
  {
    id: "org-deletion-final-export",
    name: "Org deletion: make the final export",
    triggers: [{ event: ORG_DELETION_STARTED_EVENT }],
  },
  async ({ event, step }) => {
    const deletionId = String(event.data.deletionId);
    await step.run("export", async () => {
      const { produceFinalExport } = await import("@/services/memory/org-deletion/final-export");
      await produceFinalExport(deletionId);
    });
    return { deletionId };
  },
);

// Every 15 minutes: an org is deleted within 15 minutes of its 7 days being up. One run
// at a time, though each step is safe to repeat if two ever overlap.
export const orgDeletionSweep = inngest.createFunction(
  {
    id: "org-deletion-sweep",
    name: "Org deletion: clear the stores of due deletions",
    concurrency: { limit: 1 },
    triggers: [{ cron: "*/15 * * * *" }],
  },
  async ({ step }) =>
    step.run("sweep", async () => {
      const { sweepOrgDeletions } = await import("@/services/memory/org-deletion/run");
      return sweepOrgDeletions();
    }),
);
