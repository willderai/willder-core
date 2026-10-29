// The six things NIST SP 800-53 AU-3 asks of every audit record, read off the audit
// timeline export (GET /api/audit/timeline): what happened, when, where, its source,
// its outcome, and who did it.
//
// How each event kind answers them:
//
//   kind       what                    when  where                source  outcome   identity
//   writes     `<recordType>.<op>`     at    scopePath            origin  "success" lane: actorType + actorId
//   sightings  action ("memory.read")  at    scopePath (the read) origin  "allow"   lane: actorType + actorId
//   denials    action                  at    scopePath            origin  "deny"    lane: actorType + actorId
//
// A write's outcome is "success" by construction, not by assumption: a change event is
// inserted in the same transaction as the change it describes
// (services/memory/change-events.ts), so one exists only for a change that committed.
// A system principal (a connector sync, a webhook) is identified as `extraction` with
// the id of the job that acted, never as an agent.
//
// The one rule this file enforces: every kind of event the timeline carries has a
// mapping here. TimelineEventKind is derived from the Timeline type itself, so a new
// event list added to the timeline does not compile until it is mapped.
//
// The functions read a loose shape rather than Timeline itself, because the attribution
// measure applies them to an export fetched from a deploy that may predate a field;
// au3Gaps() then reports that field as missing instead of the read failing.
import { isAuditOrigin } from "@/services/access/origin";
import type { Timeline } from "./timeline";

/** AU-3's six content fields, in the control's own order. */
export const AU3_FIELDS = ["what", "when", "where", "source", "outcome", "identity"] as const;
export type Au3Field = (typeof AU3_FIELDS)[number];

/** How an event ended: a committed change, an allowed request, or a refused one. */
export type Au3Outcome = "success" | "allow" | "deny";
const OUTCOMES: ReadonlySet<string> = new Set<Au3Outcome>(["success", "allow", "deny"]);

/** The principal types an audit record can name: a person, an agent, or the system. */
const PRINCIPAL_TYPES = new Set(["human", "agent", "extraction"]);

/** One event's AU-3 content, as the export carried it. A field it lacks is null. */
export interface Au3Record {
  what: string | null;
  when: string | null;
  where: string | null;
  source: string | null;
  outcome: string | null;
  identity: { type: string; id: string } | null;
}

/** The Timeline keys that are not lists of events. */
type TimelineNonEventKey = "lanes" | "latency" | "unseenWriteIds";

/** Every list of events the timeline export carries. */
export type TimelineEventKind = Exclude<keyof Timeline, TimelineNonEventKey>;

/** Each event kind's fields as an export may carry them; Timeline's own events fit. */
interface Au3EventShapes {
  writes: {
    id: string;
    at: string;
    laneKey: string;
    scopePath: string;
    op: string;
    recordType: string;
    origin?: string | null;
    outcome?: string | null;
  };
  sightings: {
    readId: string;
    at: string;
    laneKey: string;
    action?: string | null;
    scopePath?: string | null;
    origin?: string | null;
    outcome?: string | null;
  };
  denials: {
    id: string;
    at: string;
    laneKey: string;
    action: string;
    scopePath: string | null;
    origin?: string | null;
    outcome?: string | null;
  };
}

/** Never for a kind with no shape above, which makes AU3_OF below fail to compile. */
type EventOf<K extends TimelineEventKind> = K extends keyof Au3EventShapes ? Au3EventShapes[K] : never;

/** A timeline export as the functions below read it. */
export type Au3TimelineInput = {
  lanes: readonly { key: string; actorType: string; actorId: string }[];
} & { [K in TimelineEventKind]: readonly EventOf<K>[] };

type Lanes = ReadonlyMap<string, Au3TimelineInput["lanes"][number]>;

function identityOf(lanes: Lanes, laneKey: string): Au3Record["identity"] {
  const lane = lanes.get(laneKey);
  return lane ? { type: lane.actorType, id: lane.actorId } : null;
}

/** Exhaustive over TimelineEventKind: each kind's answer to AU-3. */
const AU3_OF: { [K in TimelineEventKind]: (event: EventOf<K>, lanes: Lanes) => Au3Record } = {
  writes: (w, lanes) => ({
    what: w.recordType && w.op ? `${w.recordType}.${w.op}` : null,
    when: w.at,
    where: w.scopePath,
    source: w.origin ?? null,
    outcome: w.outcome ?? null,
    identity: identityOf(lanes, w.laneKey),
  }),
  sightings: (s, lanes) => ({
    what: s.action ?? null,
    when: s.at,
    where: s.scopePath ?? null,
    source: s.origin ?? null,
    outcome: s.outcome ?? null,
    identity: identityOf(lanes, s.laneKey),
  }),
  denials: (d, lanes) => ({
    what: d.action,
    when: d.at,
    where: d.scopePath,
    source: d.origin ?? null,
    outcome: d.outcome ?? null,
    identity: identityOf(lanes, d.laneKey),
  }),
};

/** The timeline's event kinds, in a fixed order. */
export const TIMELINE_EVENT_KINDS = Object.keys(AU3_OF) as TimelineEventKind[];

/** Every event in the timeline with its AU-3 content, kind by kind. */
export function au3Records(timeline: Au3TimelineInput): { kind: TimelineEventKind; id: string; record: Au3Record }[] {
  const lanes: Lanes = new Map(timeline.lanes.map((lane) => [lane.key, lane]));
  const records: { kind: TimelineEventKind; id: string; record: Au3Record }[] = [];
  for (const kind of TIMELINE_EVENT_KINDS) {
    const toRecord = AU3_OF[kind] as (event: unknown, lanes: Lanes) => Au3Record;
    for (const event of timeline[kind] as readonly ({ id: string } | { readId: string })[]) {
      records.push({ kind, id: "id" in event ? event.id : event.readId, record: toRecord(event, lanes) });
    }
  }
  return records;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * The AU-3 fields `record` is missing or carries in the wrong shape, in AU-3's order.
 * Checked at runtime, because a measure reads this off an export from a deploy that may
 * predate a field.
 */
export function au3Gaps(record: Au3Record): Au3Field[] {
  const ok: Record<Au3Field, boolean> = {
    what: nonEmpty(record.what),
    when:
      nonEmpty(record.when) &&
      !Number.isNaN(Date.parse(record.when)) &&
      new Date(record.when).toISOString() === record.when,
    where: nonEmpty(record.where),
    source: isAuditOrigin(record.source),
    outcome: record.outcome !== null && OUTCOMES.has(record.outcome),
    identity: record.identity !== null && PRINCIPAL_TYPES.has(record.identity.type) && nonEmpty(record.identity.id),
  };
  return AU3_FIELDS.filter((field) => !ok[field]);
}
