// For transaction doubles: the change events a `$queryRaw` call writes.
//
// services/memory/change-events.ts writes every change event with a raw INSERT whose `seq`
// is taken inside the statement (public.change_event_next_seq), so a fake transaction no
// longer sees a `changeEvent.create` call. This reads the INSERT back into the fields a
// `changeEvent.create({ data })` call would have carried, so a double can record and assert
// on them as before. It reads only what change-events.ts sends; any other statement is null.
import { Prisma } from "@/lib/generated/prisma/client";

/** One change event as the INSERT wrote it, in `changeEvent.create`'s field names. */
export interface WrittenChangeEvent {
  id: string;
  orgId: string;
  scopePath: string;
  recordType: string;
  recordId: string;
  op: string;
  actorId: string;
  actorType: string | null;
  origin: string | null;
  summary: string;
  authorizedById: string | null;
  task: string | null;
  sessionKey: string | null;
}

/** Bound values per event row, in change-events.ts's column order: id, orgId, the seq's value, then the rest. */
const ROW_VALUES = 14;

/** A `$queryRaw` call's arguments as one statement: a tagged template's parts, or a Prisma.Sql passed whole. */
export function statementOf(
  query: Prisma.Sql | TemplateStringsArray | readonly string[],
  values: readonly unknown[] = [],
): Prisma.Sql {
  return Array.isArray(query) ? Prisma.sql(query as readonly string[], ...values) : (query as Prisma.Sql);
}

/**
 * The events a `$queryRaw` call inserts into change_events, in order, or null when the call is
 * any other statement.
 */
export function insertedChangeEvents(
  query: Prisma.Sql | TemplateStringsArray | readonly string[],
  values: readonly unknown[] = [],
): WrittenChangeEvent[] | null {
  const statement = statementOf(query, values);
  if (!/INSERT INTO "change_events"/.test(statement.sql)) return null;
  // The batched form binds the org once for its first seq, before the rows.
  const bound = /AS first\b/.test(statement.sql) ? statement.values.slice(1) : statement.values;
  if (bound.length === 0 || bound.length % ROW_VALUES !== 0)
    throw new Error(`unexpected change_events insert: ${bound.length} bound values`);
  const rows: WrittenChangeEvent[] = [];
  for (let i = 0; i < bound.length; i += ROW_VALUES) {
    const [
      id,
      orgId,
      ,
      scopePath,
      recordType,
      recordId,
      op,
      actorId,
      actorType,
      origin,
      summary,
      authorizedById,
      task,
      sessionKey,
    ] = bound.slice(i, i + ROW_VALUES) as (string | null)[];
    rows.push({
      id: id!,
      orgId: orgId!,
      scopePath: scopePath!,
      recordType: recordType!,
      recordId: recordId!,
      op: op!,
      actorId: actorId!,
      actorType: actorType ?? null,
      origin: origin ?? null,
      summary: summary!,
      authorizedById: authorizedById ?? null,
      task: task ?? null,
      sessionKey: sessionKey ?? null,
    });
  }
  return rows;
}
