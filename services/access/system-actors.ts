// The actor ids the product writes under for its own writers.
//
// `change_events.actorId` and the audit log name who made each change, and the
// answer to "who wrote this" is read straight from them. A capability token's
// `agentId` becomes the actor id of every write made with it, so a token minted
// under one of these ids would file a caller's writes under a connector sync, a
// workflow step or the system itself.
//
// The rule this module enforces: every id the product writes as itself comes from
// a function or constant here, and reservedActorKind() recognises exactly those
// shapes, so an agent id a caller chooses can never take one of them. The same
// shapes, spelled exactly, are the only ids isProductActorId() lets the interface
// show under a product label.

import { SourceType } from "@/lib/generated/prisma/enums";

/** Writes the product makes on its own behalf, with no person or agent behind them. */
export const SYSTEM_ACTOR_ID = "system";

/** Stands in for a writer whose id was never recorded. */
export const UNKNOWN_ACTOR_ID = "unknown";

/** GitHub secret scanning, revoking a capability token it found leaked. */
export const SECRET_SCANNING_ACTOR_ID = "github-secret-scanning";

/** The product's built-in agents. Each writes under its own id; an org may also hold
 *  an Agent row with that key, which is how a token is issued to the real agent. */
export const QA_AGENT_ID = "qa-agent";
export const COPY_AGENT_ID = "copy-agent";
export const HANDOFF_AGENT_ID = "handoff-agent";
export const ARCHITECTURE_AGENT_ID = "architecture-agent";
export const RESEARCH_AGENT_ID = "research-agent";

/** The names the built-in agents sign their own memory writes with: a fact's citation. */
export const QA_AGENT_NAME = "QA agent";
export const COPY_AGENT_NAME = "Outreach agent";
export const HANDOFF_AGENT_NAME = "Handoff agent";
export const ARCHITECTURE_AGENT_NAME = "Architecture agent";
export const RESEARCH_AGENT_NAME = "Research agent";

/** Every built-in agent id, in no particular order. */
export const BUILT_IN_AGENT_IDS: readonly string[] = [
  QA_AGENT_ID,
  COPY_AGENT_ID,
  HANDOFF_AGENT_ID,
  ARCHITECTURE_AGENT_ID,
  RESEARCH_AGENT_ID,
];

/** Every built-in agent's signing name, in no particular order. */
export const BUILT_IN_AGENT_NAMES: readonly string[] = [
  QA_AGENT_NAME,
  COPY_AGENT_NAME,
  HANDOFF_AGENT_NAME,
  ARCHITECTURE_AGENT_NAME,
  RESEARCH_AGENT_NAME,
];

const WORKFLOW_ACTOR_PREFIX = "workflow:";

/** The actor a connector's sync writes and announces its items as: `<type>-sync:<sourceId>`. */
export function connectorActorId(source: { id: string; type: string }): string {
  return `${source.type}-sync:${source.id}`;
}

/** The actor a workflow step is audited as: `workflow:<role>`. */
export function workflowActorId(role: string): string {
  return `${WORKFLOW_ACTOR_PREFIX}${role}`;
}

/** The agent id of the capability a workflow role runs under: `workflow:<workflowKey>:<role>`. */
export function workflowCapabilityAgentId(workflowKey: string, role: string): string {
  return `${WORKFLOW_ACTOR_PREFIX}${workflowKey}:${role}`;
}

const EXACT_IDS: ReadonlyArray<readonly [string, string]> = [
  [SYSTEM_ACTOR_ID, "the system's own writes"],
  [UNKNOWN_ACTOR_ID, "writes with no recorded author"],
  [SECRET_SCANNING_ACTOR_ID, "GitHub secret scanning"],
  ...BUILT_IN_AGENT_IDS.map((id): readonly [string, string] => [id, `the built-in ${id}`]),
];

/**
 * What a reserved actor id belongs to, or null when `actorId` is free for an agent.
 *
 * Matching ignores case, so a lookalike such as `GitHub-Sync:<id>` is refused with
 * the real one. A built-in agent id is reserved only as free text: when the org has
 * an Agent row with that key, canonicalAgentId() resolves to the row first. The prefixes are taken from the producing functions above rather
 * than spelled out again, so a change to one of them changes what is reserved.
 */
export function reservedActorKind(actorId: string): string | null {
  const id = actorId.toLowerCase();
  for (const type of Object.values(SourceType)) {
    if (id.startsWith(connectorActorId({ type, id: "" }))) return `the ${type} connector's sync`;
  }
  if (id.startsWith(workflowActorId(""))) return "a workflow step";
  for (const [reserved, kind] of EXACT_IDS) {
    if (id === reserved) return kind;
  }
  return null;
}

/** Every id reservedActorKind() matches exactly (the system, unknown, secret scanning and
 *  the built-in agents), as written. */
export const EXACT_PRODUCT_ACTOR_IDS: readonly string[] = EXACT_IDS.map(([id]) => id);

/**
 * True when `actorId` is, character for character, an id the product writes as itself.
 *
 * Unlike reservedActorKind(), which refuses lookalikes in any case, this matches the
 * product's own spelling only: it decides whether the interface may show a product
 * label, so `QA-Agent` or a row written before reservation existed must not pass.
 */
export function isProductActorId(actorId: string): boolean {
  if (EXACT_PRODUCT_ACTOR_IDS.includes(actorId)) return true;
  if (actorId.startsWith(workflowActorId(""))) return true;
  return Object.values(SourceType).some((type) => actorId.startsWith(connectorActorId({ type, id: "" })));
}
