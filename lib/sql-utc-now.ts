// The current instant for raw SQL, in the form Willder's timestamp columns hold.
//
// Prisma stores every DateTime in a `timestamp(3) without time zone` column as UTC
// wall-clock time, and reads it back as UTC. Postgres `now()` and CURRENT_TIMESTAMP
// are `timestamptz`; assigning one to such a column, or comparing one against it,
// converts through the session's TimeZone setting. On a server whose TimeZone is not
// UTC, a self-hosted Postgres set to America/Los_Angeles for example, that stores
// local time and compares the column as local time: hours away from what Prisma
// wrote, so an expired grant still reads as live and a fresh row reads as old.
//
// The rule this file enforces: raw SQL never writes or compares a Prisma DateTime
// column against bare now() or CURRENT_TIMESTAMP. It uses `sqlUtcNow`, which is the
// same instant as UTC wall-clock time whatever the session TimeZone is.
// eslint.sql-utc-now.mjs fails lint on a bare one in application code, and
// lib/sql-utc-now.realdb.test.ts proves the difference on Postgres sessions both
// west and east of UTC.
import { Prisma } from "@/lib/generated/prisma/client";

/** `now()` as UTC wall-clock time, for `timestamp without time zone` columns. */
export const sqlUtcNow = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

/** A JavaScript instant as UTC wall-clock time, to compare against a `timestamp without time zone` column. */
export function sqlUtcAt(at: Date): Prisma.Sql {
  return Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}
