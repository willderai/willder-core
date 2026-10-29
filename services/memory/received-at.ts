// When the server received a write, on the one clock every instance shares.
//
// Whether two writes of one fact conflict is decided by how far apart they arrived
// (services/memory/conflict.ts, CONTENTION_WINDOW_MS). A version's `createdAt` is its
// storing transaction's start, which comes after the embedding call; one write whose
// embedding took longer than the window was dated more than a window after a write sent
// at the same moment, and the race was recorded as an ordinary later update, with no
// supersede and no notice to the loser. So the write path takes
// this instant at its entry, before any of that, and the version stores it as `receivedAt`.
//
// The clock is the database's, never the instance's own. Serverless instances do not
// share a clock, and two writes are compared with each other and with `createdAt`, which
// the database's clock already writes; one source keeps every comparison on one timeline.
import { db } from "@/lib/db";

/**
 * The database's current instant as an ISO-8601 UTC string with microseconds; undefined
 * when the database could not be asked. A write is never refused for want of it: the
 * version is then dated by its `createdAt`, as every version was before `receivedAt` existed.
 *
 * `clock_timestamp()`, not `now()`: outside a transaction they agree, and inside one only
 * `clock_timestamp()` is the moment of the call.
 *
 * Microseconds, not milliseconds: the value reaches `memory_chunks.receivedAt`, a
 * timestamp(3), by a cast in SQL, which rounds it exactly as every other timestamp there
 * (a read's `readAt`, a row's `createdAt`) is rounded. Cut to milliseconds here, a read
 * made just before the write could round to a later millisecond than the write's receipt
 * and count as made after it. Keep it a string: a JavaScript Date holds milliseconds only.
 */
export async function receivedNow(): Promise<string | undefined> {
  try {
    const rows = await db.$queryRaw<{ at: string }[]>`
      SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "at"
    `;
    return rows[0]?.at;
  } catch {
    return undefined;
  }
}
