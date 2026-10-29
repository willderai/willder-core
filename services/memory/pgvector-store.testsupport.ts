// For suites that mock the pgvector store: `ingestOnce` as the real store answers a new
// row. It runs the caller's same-transaction work inside `db.$transaction`, as the real
// store does, so the announcement the write path hands
// it still runs, through whatever `@/lib/db` the suite mocked.
import type { IngestInput } from "@/types/memory";
import type { DecidedIngestOnceResult, VersionTransaction } from "./pgvector-store";

/** A mock `ingestOnce` that stores every content as a new row `episodeId`. */
export function storesNewRow(episodeId: string) {
  return async (
    _input: IngestInput,
    options?: { sameTransaction?: VersionTransaction<unknown> },
  ): Promise<DecidedIngestOnceResult<unknown>> => {
    const settle = options?.sameTransaction;
    if (!settle) return { episodeId, inserted: true, decided: undefined };
    const { db } = await import("@/lib/db");
    return db.$transaction(async (tx) => ({
      episodeId,
      inserted: true as const,
      decided: await settle(tx, episodeId),
    }));
  };
}
