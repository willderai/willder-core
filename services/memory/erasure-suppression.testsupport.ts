// Test fixtures that stand for entries the app itself listed: written in a transaction that
// marks the app's listing (services/memory/erasure-suppression.ts, listingInThisTransaction), so
// the list's insert trigger does not take them for a restore's copy-back and mark the org due.
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

/** Insert `data` into the suppression list as the app lists a person. */
export async function listAsTheApp(
  db: Pick<PrismaClient, "$transaction">,
  args: {
    data: Prisma.ErasureSuppressionCreateManyInput | Prisma.ErasureSuppressionCreateManyInput[];
    skipDuplicates?: boolean;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.erasure_listing', 'on', true) AS listing`;
    await tx.erasureSuppression.createMany(args);
  });
}
