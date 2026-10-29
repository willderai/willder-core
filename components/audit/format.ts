// Shared formatting helpers for rendering audit_log entries. Used by the
// Audit page (`app/(app)/audit/page.tsx`) and the per-run observability panel
// on the Agents page (`app/(app)/agents/page.tsx`) so both surfaces parse
// `target` the same way instead of drifting.

import { auditActionLabel } from "@/services/audit/audit-actions";
import { GROUP_ID_TARGET_PREFIX } from "@/services/audit/audit-target";
import { escapeBidiControls } from "@/lib/unicode/bidi";

export function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A latency or span in the largest unit that keeps it readable: 840 ms, 6.5 s,
 * 4.2 min, 1.3 h. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** An agent key as words: `qa-agent` -> "Qa Agent". Only the product's own ids are shown
 * this way (services/audit/actor-names.ts); prettifying a free-text id would erase the
 * case and separators that tell it apart from one of them. */
export function prettifyAgentKey(key: string): string {
  return key.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The suffix that marks an agent label as NOT one of the product's own writers, whose
 * name it would otherwise read as: ` (agent key "custom-1")`. */
export function agentKeyMarker(agentKey: string): string {
  return ` (agent key ${JSON.stringify(agentKey)})`;
}

/**
 * How many characters of a writer label each width-capped surface shows, the ellipsis
 * included. The Timeline draws lanes with {@link truncateWriterLabel} at these counts;
 * the Access audit column and the actors picker set their CSS width in `ch` from them
 * (the Access column is monospace, so its count is exact). The narrowest of them decides
 * how much of a product writer's label a custom agent's name may share before it is
 * marked (services/audit/actor-names.ts).
 */
export const WRITER_SLOT_CHARS = {
  timelineLane: 22,
  timelineLaneCompact: 40,
  accessAuditColumn: 16,
  actorPicker: 22,
} as const;

/** The suffix on a label for an agent id with no Agent row that is not a product id. */
export const AGENT_TOKEN_MARKER = " (agent token)";

const WRITER_MARKER = / \((?:agent key "(?:[^"\\]|\\.)*"|agent token)\)$/;

/** A writer label split into the name a reader compares and the marker, if any, that
 * tells it apart from a product writer of the same name. */
export function splitWriterLabel(label: string): { name: string; marker: string } {
  const match = WRITER_MARKER.exec(label);
  return match ? { name: label.slice(0, match.index), marker: match[0] } : { name: label, marker: "" };
}

/**
 * A writer label as an audit surface draws it: any bidi control in it shown escaped
 * (`[U+202E]`), so the screen keeps the stored order. "\u202EmetsyS\u202C Agent" would
 * otherwise be drawn as "System Agent". Every surface that draws a writer's name goes
 * through this, or through {@link truncateWriterLabel}, which calls it.
 */
export function displayWriterLabel(label: string): string {
  return escapeBidiControls(label);
}

const ESCAPED_CONTROL = /\[U\+[0-9A-F]{4,6}\]/g;

/** The longest prefix of `name` no longer than `length` that does not end inside an
 * escaped control (half of `[U+202E]` reads as ordinary text and hides the control) or
 * between the two halves of a surrogate pair. */
function prefixOutsideEscapes(name: string, length: number): string {
  for (const match of name.matchAll(ESCAPED_CONTROL)) {
    if (match.index >= length) break;
    if (match.index + match[0].length > length) return name.slice(0, match.index);
  }
  const prefix = name.slice(0, length);
  return /[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix;
}

/**
 * A writer label cut to about `max` characters for a narrow surface, shortening only the
 * name and never the marker. Cutting the end off `Architecture agent Agent (agent key
 * "custom-1")` would leave exactly the text of the real Architecture agent's label, so a
 * marked label keeps its whole marker even when that alone is longer than `max`. The cut
 * never falls inside an escaped bidi control; it moves back to before the control.
 */
export function truncateWriterLabel(rawLabel: string, max: number): string {
  const label = displayWriterLabel(rawLabel);
  if (label.length <= max) return label;
  const { name, marker } = splitWriterLabel(label);
  const room = Math.max(max - marker.length, 2);
  return name.length <= room ? label : `${prefixOutsideEscapes(name, room - 1)}…${marker}`;
}

// Re-exported under this file's existing name so the two audit pages keep
// importing every formatting helper from one place. The labels themselves
// come from AUDIT_ACTIONS (services/audit/visibility.ts), which TypeScript
// keeps exhaustive over AccessAction, so the `default: return action`
// fallback this used to have for every unlisted action is now reachable
// only for genuinely unknown data -- not for an action someone added and
// forgot to label here.
export const parseAction = auditActionLabel;

/** Human label for the untagged partition, and for its descendants. It has to
 * differ from "Org root": `<orgId>` and `org_<orgId>` are two different places,
 * and telling a write in one from a write in the other is the whole point of
 * the effect rows that name them. */
const UNTAGGED_LABEL = "Untagged";

function humanizeSegment(segment: string): string {
  return segment.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Label for the partition half of a target. The first dot-segment is the org
 * id in both namespaces, so it is dropped either way and only what follows is
 * shown. An empty `partition` is an older row that carried no partition at
 * all, which has always read as the org root. */
function partitionLabel(partition: string, untagged: boolean): string {
  const body = untagged ? partition.slice(GROUP_ID_TARGET_PREFIX.length) : partition;
  const descendants = body.split(".").slice(1).map(humanizeSegment).join(" › ");
  if (!untagged) return descendants || "Org root";
  return descendants ? `${UNTAGGED_LABEL} › ${descendants}` : UNTAGGED_LABEL;
}

/** Label for a bare scope path, e.g. `org_x.crew_1c5b79` -> "Crew_1c5b79". */
export function scopeLabel(scopePath: string): string {
  return partitionLabel(scopePath, false);
}

export function parseTarget(target: string): { scope: string; what: string; recordId?: string } {
  // Three shapes reach this, all of them `<partition>/<tag>` except the last:
  //   "org_xxx.sales/query:..."   a registered scope path, from check()
  //   "group:xxx.sales/fact:..."  the untagged partition a write actually
  //                               executed against, marked so it cannot be
  //                               confused with the scope path above
  //                               (services/audit/audit-target.ts)
  //   "graph", "query:..."        older rows with no partition half at all
  const slashIdx = target.indexOf("/");
  const untagged = target.startsWith(GROUP_ID_TARGET_PREFIX);
  // Authorization rows may target the scope itself, with no record suffix.
  // Keep a department-level read from being mislabeled as an org-root read.
  if (slashIdx === -1 && (untagged || target.startsWith("org_"))) {
    return { scope: partitionLabel(target, untagged), what: "Scope", recordId: undefined };
  }
  const hasPartition = slashIdx !== -1 && (untagged || target.startsWith("org_"));

  const partition = hasPartition ? target.slice(0, slashIdx) : "";
  const whatPart = hasPartition ? target.slice(slashIdx + 1) : target;
  const scope = partitionLabel(partition, untagged && hasPartition);

  // What label — for entity/fact targets, keep the record id visible (not just
  // the human label) so a reviewer can cross-reference the exact memory record.
  //
  // The `entity:`/`fact:` tag names the record's TYPE, not the row's verb: the
  // same `entity:<id>` tag is written for a `memory.delete` authorization row
  // and its `memory.delete.effect` counterpart (services/memory/guarded-
  // store.ts's removeEntity()), and `fact:<id>` covers a `memory.delete` as
  // well as a `memory.write` provenance link. So the What column shows the
  // type and nothing else: the verb is already in the Action column beside it
  // on both audit surfaces, and the ids are opaque graph uuids, so the type is
  // the only place an entity delete and a fact delete can be told apart.
  let what: string;
  let recordId: string | undefined;
  if (whatPart.startsWith("query:")) {
    what = `"${whatPart.slice(6)}"`;
  } else if (whatPart === "graph") {
    what = "Explored graph";
  } else if (whatPart.startsWith("entity:")) {
    what = "Entity";
    recordId = whatPart.slice("entity:".length);
  } else if (whatPart.startsWith("fact:")) {
    what = "Fact";
    recordId = whatPart.slice("fact:".length);
  } else if (whatPart.startsWith("grants:create:")) {
    // The marker's suffix is the granted scope, which `scope` above already
    // shows, so there is no id to cross-reference.
    what = "New grant";
  } else if (whatPart.startsWith("grants:revoke:")) {
    what = "Revoked grant";
    recordId = whatPart.slice("grants:revoke:".length);
  } else if (whatPart.startsWith("capabilities:leak-revoke:")) {
    what = "Leaked token revoked";
    recordId = whatPart.slice("capabilities:leak-revoke:".length);
  } else if (whatPart.startsWith("audit:export:")) {
    // Written by GET /api/audit/export; the suffix is the exported range.
    what = `Exported audit log ${whatPart.slice("audit:export:".length)}`;
  } else if (whatPart.startsWith("change:")) {
    // Written by the audit Timeline's detail panel when an admin opens a
    // change's text (app/api/audit/timeline/[changeId]/route.ts).
    what = "Opened change";
    recordId = whatPart.slice("change:".length);
  } else if (whatPart.startsWith("fact_dispute:")) {
    what = "Resolved dispute";
    recordId = whatPart.slice("fact_dispute:".length);
  } else {
    what = whatPart;
  }

  return { scope, what, recordId };
}

/** A capability token's short id, shown on the Tokens tab and on every audit
 * row that names the token, so an admin can match the two by eye. The last
 * eight characters, not the first: a cuid starts with its creation timestamp,
 * so tokens minted minutes apart share their leading characters, while its
 * tail is random. */
export function tokenShortId(capabilityId: string): string {
  return capabilityId.slice(-8);
}

/** The address of one change's detail on the audit page: a link that can be handed to
 * someone else, who opens the same change in the same scope. */
export function changeHref(changeId: string, scope: string | null): string {
  const params = new URLSearchParams({ view: "timeline" });
  if (scope) params.set("scope", scope);
  params.set("change", changeId);
  return `/audit?${params}`;
}
