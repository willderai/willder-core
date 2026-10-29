// The audit Timeline's derivation: turns a window of change events (writes) and
// audit rows (reads) into lanes, first-sight edges and latency figures.
//
// Pure and synchronous, so every rule below is tested without a database. The
// route (app/api/audit/timeline/route.ts) loads the rows; the view
// (components/audit/timeline.tsx) only draws what this returns.
//
// The one rule this file enforces: an edge is drawn only where a reader really
// could have been served the write. The reader is a different agent, its read
// was allowed, it happened at or after the write, and the scope it read covers
// the scope the write landed in. Nothing is inferred beyond that, so a write no
// one has read yet is reported as unseen rather than given a guessed latency.
import { pathCovers } from "@/services/access";
import type { AuditOrigin } from "@/services/access/origin";

/** One change-feed event, as the timeline needs it. Carries no fact text: that
 * is read one event at a time, through an audited read (the detail route). */
export interface TimelineWriteInput {
  id: string;
  at: Date;
  /** The writer's principal type: "human", "agent", or "extraction" for the system. */
  actorType: string;
  actorId: string;
  /** Where the change entered the system; null on an event written before origins
   * were recorded, which the export reports as such rather than guessing. */
  origin: AuditOrigin | null;
  scopePath: string;
  op: string;
  recordType: string;
  recordId: string;
}

/** One audit_log row of a read attempt (`memory.read` or `memory.entity`). */
export interface TimelineReadInput {
  id: string;
  at: Date;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  decision: "allow" | "deny";
  /** Where the request entered the system, from the row's `metadata.origin`; null on a
   * row written before origins were recorded. */
  origin: AuditOrigin | null;
}

interface TimelineLane {
  /** `${actorType}:${actorId}`: an actor id alone is not unique across the
   * human and agent namespaces (see GET /api/audit's actor filter). */
  key: string;
  actorType: string;
  actorId: string;
  name: string;
  /** The scope this lane touched most in the window, for its colour band. */
  scopePath: string | null;
}

export interface TimelineWrite {
  id: string;
  at: string;
  laneKey: string;
  scopePath: string;
  op: string;
  recordType: string;
  recordId: string;
  origin: AuditOrigin | null;
  /** Always "success": a change event is written in the same transaction as the
   * change, so the export only ever holds changes that committed. */
  outcome: "success";
}

/** A reader's first sight of a write: the edge from writer lane to reader lane. */
interface TimelineSighting {
  writeId: string;
  laneKey: string;
  readId: string;
  at: string;
  latencyMs: number;
  /** The audited action of the read: only allowed `memory.read` rows become sightings. */
  action: typeof SIGHTING_ACTION;
  /** The scope the read itself named, which covers the write's scope. */
  scopePath: string;
  origin: AuditOrigin | null;
  outcome: "allow";
}

interface TimelineDenial {
  id: string;
  at: string;
  laneKey: string;
  action: string;
  scopePath: string | null;
  origin: AuditOrigin | null;
  outcome: "deny";
}

export interface LatencySummary {
  count: number;
  medianMs: number;
  p95Ms: number;
}

export interface Timeline {
  lanes: TimelineLane[];
  writes: TimelineWrite[];
  sightings: TimelineSighting[];
  denials: TimelineDenial[];
  /** Null when there is no sighting to measure, never a zero standing in for one. */
  latency: LatencySummary | null;
  /** Writes no other agent has read yet within the window. */
  unseenWriteIds: string[];
}

export interface BuildTimelineInput {
  writes: TimelineWriteInput[];
  reads: TimelineReadInput[];
  /** Display name per lane key. A lane with none falls back to its actor id. */
  names: ReadonlyMap<string, string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Widest window a timeline request may ask for. */
const MAX_WINDOW_DAYS = 31;

/** The read action whose allowed rows mark a change-feed delivery. Every agent
 * tool call reads the feed through check({action: "memory.read"}) on its scope
 * (mcp/change-notices.ts), and so does memory_changes itself. */
const SIGHTING_ACTION = "memory.read" as const;

/** The lane a row belongs to: `${actorType}:${actorId}`. */
export function laneKey(actorType: string, actorId: string): string {
  return `${actorType}:${actorId}`;
}

/**
 * The scope an audit row's target names, or null when it names none that a
 * change event could fall under.
 *
 * check() writes `<scope>` or `<scope>/<detail>`. Targets in the untagged
 * `group:` namespace, and older rows with no partition at all, are not scope
 * paths, so they cover no change event.
 */
export function scopeOfTarget(target: string | null): string | null {
  if (target === null || !target.startsWith("org_")) return null;
  const slash = target.indexOf("/");
  return slash === -1 ? target : target.slice(0, slash);
}

/** Nearest-rank percentile over an ascending list, the same definition the
 * delivery-latency measure uses, so the two report the same figure. */
export function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) throw new RangeError("percentile of an empty list");
  const rank = Math.ceil((p / 100) * sortedAscending.length) - 1;
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank))]!;
}

/** Count, median and p95 of sighting latencies; null when there is none to measure. */
export function summarizeLatency(latenciesMs: readonly number[]): LatencySummary | null {
  if (latenciesMs.length === 0) return null;
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
}

/** Build the timeline for one window. Inputs may arrive in any order. */
export function buildTimeline(input: BuildTimelineInput): Timeline {
  const writes = [...input.writes].sort((a, b) => a.at.getTime() - b.at.getTime());
  const reads = [...input.reads].sort((a, b) => a.at.getTime() - b.at.getTime());

  const lanes = new Map<string, TimelineLane>();
  const scopeCounts = new Map<string, Map<string, number>>();
  const touch = (actorType: string, actorId: string, scopePath: string | null): string => {
    const key = laneKey(actorType, actorId);
    if (!lanes.has(key)) {
      lanes.set(key, { key, actorType, actorId, name: input.names.get(key) ?? actorId, scopePath: null });
      scopeCounts.set(key, new Map());
    }
    if (scopePath !== null) {
      const counts = scopeCounts.get(key)!;
      counts.set(scopePath, (counts.get(scopePath) ?? 0) + 1);
    }
    return key;
  };

  const timelineWrites: TimelineWrite[] = writes.map((w) => ({
    id: w.id,
    at: w.at.toISOString(),
    laneKey: touch(w.actorType, w.actorId, w.scopePath),
    scopePath: w.scopePath,
    op: w.op,
    recordType: w.recordType,
    recordId: w.recordId,
    origin: w.origin,
    outcome: "success",
  }));

  // Only agents are served the change feed, so only agent reads can be sightings.
  // A person's read still gets a lane when it was denied: that is who tried.
  const readsByLane = new Map<string, { read: TimelineReadInput; scope: string }[]>();
  const denials: TimelineDenial[] = [];
  for (const read of reads) {
    const scope = scopeOfTarget(read.target);
    if (read.decision === "deny") {
      denials.push({
        id: read.id,
        at: read.at.toISOString(),
        laneKey: touch(read.actorType, read.actorId, scope),
        action: read.action,
        scopePath: scope,
        origin: read.origin,
        outcome: "deny",
      });
      continue;
    }
    if (read.actorType !== "agent" || read.action !== SIGHTING_ACTION || scope === null) continue;
    const key = touch(read.actorType, read.actorId, scope);
    const list = readsByLane.get(key) ?? [];
    list.push({ read, scope });
    readsByLane.set(key, list);
  }

  const sightings: TimelineSighting[] = [];
  const unseenWriteIds: string[] = [];
  for (let i = 0; i < writes.length; i++) {
    const write = writes[i]!;
    const writerKey = timelineWrites[i]!.laneKey;
    let seen = false;
    for (const [readerKey, laneReads] of readsByLane) {
      if (readerKey === writerKey) continue;
      const first = laneReads.find(
        ({ read, scope }) => read.at.getTime() >= write.at.getTime() && pathCovers(scope, write.scopePath),
      );
      if (first === undefined) continue;
      seen = true;
      sightings.push({
        writeId: write.id,
        laneKey: readerKey,
        readId: first.read.id,
        at: first.read.at.toISOString(),
        latencyMs: first.read.at.getTime() - write.at.getTime(),
        action: SIGHTING_ACTION,
        scopePath: first.scope,
        origin: first.read.origin,
        outcome: "allow",
      });
    }
    if (!seen) unseenWriteIds.push(write.id);
  }

  for (const [key, lane] of lanes) lane.scopePath = mostFrequent(scopeCounts.get(key)!);

  return {
    lanes: [...lanes.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key)),
    writes: timelineWrites,
    sightings,
    denials,
    latency: summarizeLatency(sightings.map((s) => s.latencyMs)),
    unseenWriteIds,
  };
}

function mostFrequent(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Parse the window, defaulting to the 24 hours before `now`. */
export function parseWindow(
  fromParam: string | null,
  toParam: string | null,
  now: Date,
): { from: Date; to: Date } | { error: string } {
  const to = toParam ? new Date(toParam) : now;
  const from = fromParam ? new Date(fromParam) : new Date(to.getTime() - DAY_MS);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) {
    return { error: "from and to must be ISO timestamps, e.g. 2026-09-25T12:00:00Z" };
  }
  if (from >= to) return { error: "from must be earlier than to" };
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return { error: `the window can be at most ${MAX_WINDOW_DAYS} days; narrow from or to` };
  }
  return { from, to };
}
