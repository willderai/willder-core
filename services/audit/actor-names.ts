// Display names for the actors an audit surface shows: users by id, agents by
// key, with one shared fallback for an agent key that has no row.
//
// The rule this module enforces: a label that reads as one of the product's own
// writers (a built-in agent, the system, a connector sync, a workflow step) is
// produced only from that writer's exact actor id (isProductActorId). A free-text
// agent id is shown quoted, as an agent token, and an Agent row whose name claims a
// product writer carries its own key, so no caller-chosen id or name can make a
// write read as the product's. "Claims a product writer" is judged on the name's
// confusable skeleton, as written and lowercased: a name that is a product writer's
// name, begins with one, or whose label begins with as much of a product writer's
// label as the narrowest surface shows before cutting it off. Any name with a bidi
// control claims one, since the screen reorders it whatever its skeleton says.
//
// Which rows are visible is not decided here: that rule lives in
// services/audit/visibility.ts.
import { db } from "@/lib/db";
import { SourceType } from "@/lib/generated/prisma/enums";
import { AGENT_TOKEN_MARKER, WRITER_SLOT_CHARS, agentKeyMarker, prettifyAgentKey } from "@/components/audit/format";
import {
  BUILT_IN_AGENT_NAMES,
  EXACT_PRODUCT_ACTOR_IDS,
  isProductActorId,
  workflowActorId,
} from "@/services/access/system-actors";
import { containsBidiControl } from "@/lib/unicode/bidi";
import { confusableSkeleton } from "@/lib/unicode/skeleton";
import type { ActorType } from "@/types/memory";

/** Display name per user id: name, else email, else the id itself. */
export async function resolveUserNames(userIds: string[]): Promise<Record<string, string>> {
  if (userIds.length === 0) return {};
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, email: true },
  });
  const names: Record<string, string> = {};
  for (const u of users) names[u.id] = u.name ?? u.email ?? u.id;
  return names;
}

/** The words of a name as a reader compares them by eye, on one skeleton: lookalike
 *  characters folded to the letters they imitate (confusableSkeleton), then case and
 *  separators ignored. */
function skeletonWords(skeleton: string): string[] {
  return skeleton.toLowerCase().split(/[^a-z0-9]+/);
}

/**
 * The two skeletons a name is compared on. UTS #39 keeps case, and some lookalikes exist
 * in one case only: a capital Greek Η imitates H, its lowercase η does not imitate h. Other
 * letters map only in one case the other way: "m" folds to "rn" and "M" does not, so the
 * case-kept skeleton of "SYSTEM" never meets that of "system". A name is therefore taken
 * both as written and lowercased first, and claims a product writer if either matches.
 */
function nameSkeletons(name: string): [caseKept: string, caseFolded: string] {
  return [confusableSkeleton(name), confusableSkeleton(name.toLowerCase())];
}

/** A skeleton's words joined, with the word "agent" dropped: "QA agent" and "qa-agent"
 *  share the core "qa". */
function nameCore(skeleton: string): string {
  return skeletonWords(skeleton)
    .filter((word) => !AGENT_WORDS.has(word))
    .join("");
}

/** A skeleton's words with the empty ones a leading or trailing separator leaves dropped. */
function nonEmptyWords(skeleton: string): string[] {
  return skeletonWords(skeleton).filter((word) => word !== "");
}

/** A skeleton as a reader scans it left to right: lowercase, every run of separators one
 *  space. */
function readingForm(skeleton: string): string {
  return skeleton.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

/** How an Agent row's name is labelled before any marker. */
function agentLabel(name: string): string {
  return `${name} Agent`;
}

const AGENT_WORDS = new Set(["", "agent", "agents"]);
const PRODUCT_NAMES = [...EXACT_PRODUCT_ACTOR_IDS, ...BUILT_IN_AGENT_NAMES];
const PRODUCT_NAME_CORES = new Set(PRODUCT_NAMES.flatMap(nameSkeletons).map(nameCore));
const PRODUCT_NAME_WORDS = PRODUCT_NAMES.flatMap(nameSkeletons).map(nonEmptyWords);
const WORKFLOW_CORES = nameSkeletons(workflowActorId("")).map(nameCore);

/** The labels the product's own agents are drawn with: a built-in agent's seeded row, and
 *  the fallback for each product id that has no row. */
const PRODUCT_AGENT_LABELS = [
  ...BUILT_IN_AGENT_NAMES.map(agentLabel),
  ...EXACT_PRODUCT_ACTOR_IDS.map((id) => fallbackAgentName(id)),
];

/**
 * The fewest characters of a label any width-capped surface shows before its ellipsis. A slot
 * of N characters shows N - 2 of them: browsers lay out `16ch` a fraction of a pixel short of
 * fifteen characters plus the ellipsis (Chromium: 115.1875px in Geist Mono 12px), so the
 * narrowest slot shows fourteen.
 */
const FEWEST_VISIBLE_CHARS = Math.min(...Object.values(WRITER_SLOT_CHARS)) - 2;

/**
 * What a reader sees of each product agent label that some surface cuts short: its first
 * {@link FEWEST_VISIBLE_CHARS} characters, in reading form. A label that begins the same
 * way is drawn as that cut-short product label on the narrowest surface, and on any wider
 * one where it agrees with it further; a label that fits every surface is never cut.
 */
const CUT_PRODUCT_LABEL_PREFIXES = PRODUCT_AGENT_LABELS.filter((label) => label.length > FEWEST_VISIBLE_CHARS + 1)
  .flatMap((label) => nameSkeletons(label.slice(0, FEWEST_VISIBLE_CHARS)))
  .map(readingForm);

/** True when a skeleton's words begin with every word of a product writer's name, in
 *  order: "Architecture agent Agency" begins with "Architecture agent". */
function beginsWithProductName(skeleton: string): boolean {
  const words = nonEmptyWords(skeleton);
  return PRODUCT_NAME_WORDS.some((product) => product.length > 0 && product.every((word, i) => words[i] === word));
}

/** True when one skeleton of a name reads as a product writer's label: a built-in agent,
 *  the system, secret scanning, a workflow step, or a connector's "<source> sync", or
 *  begins with one of their names. */
function skeletonClaimsProductName(skeleton: string): boolean {
  const core = nameCore(skeleton);
  return (
    PRODUCT_NAME_CORES.has(core) ||
    beginsWithProductName(skeleton) ||
    WORKFLOW_CORES.some((workflow) => core.startsWith(workflow)) ||
    skeletonWords(skeleton).includes("sync")
  );
}

/** True when an Agent row's label, cut short on a narrow surface, can read as a product
 *  agent's label cut short there: "Github Secret Scanninx Agent" and the fallback
 *  "Github Secret Scanning Agent" both show "Github Secret S…" in a 16-character slot. */
function labelSharesCutProductLabel(label: string): boolean {
  return nameSkeletons(label)
    .map(readingForm)
    .some((form) => CUT_PRODUCT_LABEL_PREFIXES.some((prefix) => form.startsWith(prefix)));
}

/** True when an Agent row's name could be read as a product writer's label. A name with
 *  a bidi control always could: the skeleton drops the control, but the screen still
 *  obeys it, so "\u202EmetsyS\u202C" is displayed as "System" whatever its skeleton. */
function claimsProductName(name: string): boolean {
  return (
    containsBidiControl(name) ||
    nameSkeletons(name).some(skeletonClaimsProductName) ||
    labelSharesCutProductLabel(agentLabel(name))
  );
}

/**
 * Display name per agent key within one org, as "<name> Agent".
 *
 * An Agent row's name is chosen by whoever created it, so a row that is not the
 * product's own and whose name claims a product writer is labelled with its key as
 * well: `QA agent Agent (agent key "custom-1")`, never the seeded QA agent's label.
 */
export async function resolveAgentNames(orgId: string, agentKeys: string[]): Promise<Record<string, string>> {
  if (agentKeys.length === 0) return {};
  const agents = await db.agent.findMany({
    where: { orgId, agentKey: { in: agentKeys } },
    select: { agentKey: true, name: true },
  });
  const names: Record<string, string> = {};
  for (const a of agents) {
    const label = agentLabel(a.name);
    const borrowed = !isProductActorId(a.agentKey) && claimsProductName(a.name);
    names[a.agentKey] = borrowed ? `${label}${agentKeyMarker(a.agentKey)}` : label;
  }
  return names;
}

/**
 * Label for an actor id with no matching Agent row (a deleted agent, or a key that
 * never had one).
 *
 * The product's own ids keep their prettified form, `Qa Agent Agent` for `qa-agent`.
 * Any other id is free text a token was minted under, so it is shown exactly as
 * written, quoted and marked as a token: `"qa_agent" (agent token)`. Prettifying it
 * would erase the very case and separators that tell it apart from `qa-agent`.
 */
export function fallbackAgentName(agentKey: string): string {
  if (isProductActorId(agentKey)) return `${prettifyAgentKey(agentKey)} Agent`;
  return `${JSON.stringify(agentKey)}${AGENT_TOKEN_MARKER}`;
}

/**
 * Display name per actor id for the non-human actors an audit surface shows: an
 * agent by its `Agent` row, a connector sync by the source it syncs, and
 * {@link fallbackAgentName} for anything else.
 *
 * One resolver for every audit surface (the audit list, the actors picker, the
 * Timeline's lanes and its detail panel), because a write must carry the same name
 * on each of those surfaces; two resolvers would let them disagree about
 * who wrote something. A connector sync's actor id is `<type>-sync:<sourceId>`
 * (`lib/inngest/connector-records.ts`), which has no `Agent` row, so the fallback
 * alone renders it as the prettified id -- "Github Sync:Cmuhwy0or000b04jkiqq0uoum
 * Agent", an id where a reader needs a name.
 */
export async function resolveActorNames(orgId: string, actorIds: string[]): Promise<Record<string, string>> {
  if (actorIds.length === 0) return {};
  const [agents, syncs] = await Promise.all([
    resolveAgentNames(orgId, actorIds),
    resolveSyncSourceNames(orgId, actorIds),
  ]);
  const names: Record<string, string> = {};
  for (const id of actorIds) names[id] = agents[id] ?? syncs[id] ?? fallbackAgentName(id);
  return names;
}

/** "<source name> sync" per `<type>-sync:<sourceId>` actor id that names a source in
 * this org. A disconnected source still resolves: its name is how the audit log
 * recorded the write, and a disconnect does not rename history. */
async function resolveSyncSourceNames(orgId: string, actorIds: readonly string[]): Promise<Record<string, string>> {
  const bySourceId = new Map<string, string[]>();
  for (const id of actorIds) {
    const match = SYNC_ACTOR.exec(id);
    if (!match || !Object.values(SourceType).some((t) => t === match[1])) continue;
    const sourceId = match[2]!;
    bySourceId.set(sourceId, [...(bySourceId.get(sourceId) ?? []), id]);
  }
  if (bySourceId.size === 0) return {};
  const sources = await db.source.findMany({
    where: { orgId, id: { in: [...bySourceId.keys()] } },
    select: { id: true, name: true },
  });
  const names: Record<string, string> = {};
  for (const source of sources) {
    for (const actorId of bySourceId.get(source.id) ?? []) {
      names[actorId] = `${source.name.replace(/\s+/g, " ").trim()} sync`;
    }
  }
  return names;
}

/** A connected source as a fact's citation names it. */
export interface ConnectorSource {
  name: string;
  type: SourceType;
}

const SYNC_ACTOR = /^([a-z]+)-sync:(.+)$/;

/**
 * True when `actorId` is a connector sync's actor (`<type>-sync:<sourceId>`,
 * lib/inngest/connector-records.ts) for a source type this product has.
 *
 * Shape only: it says nothing about whether that source still exists or belongs to any
 * particular org, which is deliberate -- callers that need the source look it up. It
 * exists so code that has to tell a sync write apart from a person's or an agent's write
 * reads the one definition of that shape rather than matching `"-sync:"` by hand.
 */
export function isConnectorSyncActor(actorId: string): boolean {
  const match = SYNC_ACTOR.exec(actorId);
  return match !== null && Object.values(SourceType).some((t) => t === match[1]);
}

/** The source id in a connector sync's actor id (`<type>-sync:<sourceId>`); null for any other actor. */
export function connectorSourceId(actorId: string): string | null {
  return isConnectorSyncActor(actorId) ? SYNC_ACTOR.exec(actorId)![2] : null;
}

const ACTOR_TYPES: readonly ActorType[] = ["human", "agent", "extraction"];

/**
 * The principal type of a change's writer: the type its change event recorded, or, for an
 * event written before that was recorded, the one its actor id implies. A connector sync's
 * id names the sync, a person is one `userNames` resolved, and every other writer of that
 * era was an agent. The Timeline lanes writers by this and the PROV export states it, so
 * the two never disagree about who wrote a change.
 */
export function changeWriterType(
  change: { actorType: string | null; actorId: string },
  userNames: Readonly<Record<string, string>>,
): ActorType {
  const recorded = ACTOR_TYPES.find((type) => type === change.actorType);
  if (recorded) return recorded;
  if (isConnectorSyncActor(change.actorId)) return "extraction";
  return change.actorId in userNames ? "human" : "agent";
}

/**
 * What the audit row that authorized a change is, relative to the change's writer.
 *
 * - `direct`: the `memory.write`/`memory.delete` allow row `check()` wrote for this very
 *   write, and its actor is the writer.
 * - `connect`: a connector sync's write, authorized by the `sources:connect` row that put
 *   the source in this scope. A sync runs no `check()` of its own; the row's actor is the
 *   person who connected the source.
 * - `accepted`: a person's `memory.write` allow row for content a different writer
 *   produced: an agent's brief the person persisted, research findings the person
 *   confirmed, a summary the system composed from the person's own edit. The person
 *   decided the write; the writer produced the text. Both are named, neither stands in
 *   for the other.
 *
 * Read from the two stored records, never from the caller: the kind is `accepted` only
 * when the row's actor is a person and is not the writer. An agent's row naming another
 * writer stays `direct`.
 *
 * Null when the change records no authorization.
 */
export type AuthorizationKind = "direct" | "connect" | "accepted";

export function authorizationKindOf(
  change: { authorizedById: string | null; actorId: string },
  writerType: ActorType,
  authorizingRow: { actorType: string; actorId: string } | null,
): AuthorizationKind | null {
  if (change.authorizedById === null) return null;
  if (isConnectorSyncActor(change.actorId)) return "connect";
  const writerIsRowActor = writerType === "human" && authorizingRow?.actorId === change.actorId;
  return authorizingRow?.actorType === "human" && !writerIsRowActor ? "accepted" : "direct";
}

/**
 * The connected source behind a connector sync's actor id (`<type>-sync:<sourceId>`,
 * lib/inngest/connector-records.ts), when that source belongs to `orgId`. Null for any
 * other writer and for a source since disconnected, the same terms memory_query names
 * a source on (mcp/fact-citation.ts), so the two never cite different sources.
 */
export async function resolveConnectorSource(orgId: string, actorId: string): Promise<ConnectorSource | null> {
  const match = SYNC_ACTOR.exec(actorId);
  const type = Object.values(SourceType).find((t) => t === match?.[1]);
  if (!match || !type) return null;
  const source = await db.source.findFirst({
    where: { orgId, id: match[2], type },
    select: { name: true, type: true },
  });
  return source ? { name: source.name.replace(/\s+/g, " ").trim(), type: source.type } : null;
}
