// The memory-ingest job and everything that prepares content for it: fact
// distillation, the read-now store write, and `ingestMemory`, the one call
// every writer uses instead of sending the event by hand. The rule this file
// keeps: a write is acknowledged only once it is readable or durably queued.
import { createLLMClient, LLM_MODEL_EXTRACT } from "@/lib/llm";
import { extractRequestExtras } from "@/lib/llm-extract-options";
import { db } from "@/lib/db";
import { memory, graphitiStore, pgvectorStore } from "@/services/memory";
import { VersionNotStoredError, type StoredDates } from "@/services/memory/pgvector-store";
import { checkEpisodeCap, recordEpisode } from "@/services/guardrails";
import type { IngestInput, IngestResult } from "@/types/memory";
import { resolveEntities } from "@/services/resolver";
import { announcedOnStore, recordIngestAppliedOnce, type IngestOutcome } from "@/services/memory/fact-change-event";
import {
  StaleBaseVersionError,
  assertBaseVersionCurrent,
  currentVersionReplacing,
  type BasedWriteTarget,
} from "@/services/memory/fact-update";
import { assertNoUnreadVersion, unreadVersionError, type FactWriter } from "@/services/memory/fact-reads";
import { orgRootPath, removingFromGraph } from "@/services/access";
import { correctsErasedVersion, withdrawCorrectionOfErased } from "@/services/memory/erasure-lineage";
import {
  ENTITY_SEED_TYPES,
  decisionToSentence,
  entitySeedToSentence,
  parseDecisions,
  parseEntitySeeds,
} from "@/services/memory/distilled-records";
import { inngest } from "./client";
import { dropRefusedSourceRow, retireLateSourceWrite } from "@/services/memory/source-retirement";
import { ingestSourceIsConnected } from "./source-state";
import { unstorableText } from "@/lib/unstorable-text";
import { GraphExtractionError, deferGraphExtraction } from "@/services/memory/graph-extraction-retry";
import { SESSION_STATE_NAME_OPENING } from "@/services/memory/session-state";
import { receivedNow } from "@/services/memory/received-at";

export const MEMORY_INGEST_EVENT = "memory/ingest.requested";

// ---------------------------------------------------------------------------
// Fact distillation — converts long/abstract content into concrete declarative
// sentences before Graphiti ingestion. Each fact is self-contained and in
// subject-verb-object form so Graphiti's entity extractor produces clean edges.
// Falls back to the original content if the LLM call fails.
// ---------------------------------------------------------------------------

const DISTILL_THRESHOLD = 300; // chars; short AGENT/doc content is already concrete

// Whether to run the reliable Node distiller (distillFacts) before Graphiti.
// HUMAN content, and anything an agent writes deliberately through the
// memory_ingest tool (source "mcp"), is distilled from 16 trimmed characters up
// rather than from DISTILL_THRESHOLD: short facts (a decision, a correction, a
// note) otherwise skip the distiller and rely on the memory-service's weak
// short-sentence extraction, which silently drops many of them — the fact is
// accepted but yields 0 graph nodes/edges — and never become a Decision record
// that keeps what was decided.
// Other agent output keeps the length gate; extraction content is already structured.
function shouldDistillContent(input: Pick<IngestInput, "actorType" | "source">, content: string): boolean {
  if (input.actorType === "extraction") return false;
  if (input.actorType === "human" || input.source === "mcp") return content.trim().length > 15;
  return content.length > DISTILL_THRESHOLD;
}

/**
 * A node attribute fact: a property OF a single entity (not a relationship BETWEEN
 * two). Goals, traits, preferences, status, and quantitative attributes are the
 * business-critical descriptors that drive outreach copy and briefing — "Acme is
 * risk-averse" matters more for a pitch than "Acme acquired Beta". We keep the
 * predicate normalized (a small closed vocabulary) so attributes stay queryable and
 * don't fragment ("risk-averse" vs "cautious"), and we render each to a clean
 * declarative sentence so it flows through the SAME Graphiti episode path as every
 * other fact — inheriting provenance ranking, temporal validity, and the dispute
 * workflow for free, instead of living as ungoverned node properties.
 */
export type AttributePredicate = "has_goal" | "has_trait" | "prefers" | "has_status" | "has_attribute";

export interface AttributeFact {
  subject: string;
  predicate: AttributePredicate;
  value: string;
}

/** Render a normalized attribute fact into a self-contained declarative sentence
 *  that Graphiti's edge extractor handles cleanly. */
export function attributeToSentence(a: AttributeFact): string {
  const subject = a.subject.trim();
  const value = a.value.trim().replace(/\.$/, "");
  switch (a.predicate) {
    case "has_goal":
      return `${subject}'s goal is to ${value}.`;
    case "has_trait":
      return `${subject} is ${value}.`;
    case "prefers":
      return `${subject} prefers ${value}.`;
    case "has_status":
      return `${subject} is currently ${value}.`;
    case "has_attribute":
      return `${subject} has the attribute: ${value}.`;
  }
}

const ATTRIBUTE_PREDICATES: readonly AttributePredicate[] = [
  "has_goal",
  "has_trait",
  "prefers",
  "has_status",
  "has_attribute",
];

/** Parse + validate the LLM's raw attribute objects into typed AttributeFacts. */
export function parseAttributes(raw: unknown): AttributeFact[] {
  if (!Array.isArray(raw)) return [];
  const out: AttributeFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { subject, predicate, value } = item as Record<string, unknown>;
    if (
      typeof subject === "string" &&
      subject.trim().length > 1 &&
      typeof value === "string" &&
      value.trim().length > 1 &&
      typeof predicate === "string" &&
      (ATTRIBUTE_PREDICATES as readonly string[]).includes(predicate)
    ) {
      out.push({
        subject: subject.trim(),
        predicate: predicate as AttributePredicate,
        value: value.trim(),
      });
    }
  }
  return out;
}

interface DistillResult {
  facts: string[];
  /** Entity definition sentences, seeded as graph nodes before the facts. */
  entitySeeds: string[];
  /** Node attribute facts (goals/traits/prefs/status). */
  attributes: AttributeFact[];
  /** Decisions the content states, rendered as `Decision by <actor> on <date>: ...`. */
  decisions: string[];
}

async function distillFacts(content: string): Promise<DistillResult> {
  const llm = createLLMClient();
  // Read before the try below: a malformed OPENAI_EXTRACT_EXTRA_BODY fails the extraction,
  // naming the variable, instead of reading as a reply with nothing in it.
  const extras = extractRequestExtras();
  try {
    const resp = await llm.chat.completions.create({
      model: LLM_MODEL_EXTRACT,
      messages: [
        {
          role: "system",
          content:
            "You are a business knowledge extractor. From the content, extract three things:\n\n" +
            "1. facts: 3-10 concrete declarative sentences describing RELATIONSHIPS or " +
            "EVENTS between entities (who did what to whom, what connects to what). Each " +
            "must be self-contained, subject-verb-object, no pronouns, specific not vague.\n\n" +
            "2. entities: named instances of these B2B types found in the content:\n" +
            Object.entries(ENTITY_SEED_TYPES)
              .map(([type, definition]) => `   - ${type}: ${definition}`)
              .join("\n") +
            "\n" +
            'Each is an object {"name","type","description"}: name exactly as written in the ' +
            "content, type EXACTLY one of the types above, description what it is in a brief " +
            "phrase. Omit anything none of these types describes, such as a person, an AI " +
            "agent, a team or a department.\n\n" +
            "3. attributes: PROPERTIES of a single named entity (not relationships between " +
            "two). These are the goals, characteristics, preferences, status, and " +
            "quantitative attributes that matter for business communication. Each is an " +
            'object {"subject","predicate","value"} where predicate is EXACTLY one of:\n' +
            "   - has_goal    (what the entity wants to achieve, e.g. 'cut vendor spend 20% this year')\n" +
            "   - has_trait   (a characteristic, e.g. 'risk-averse', 'highly technical')\n" +
            "   - prefers     (a preference, e.g. 'async communication over meetings')\n" +
            "   - has_status  (a current state, e.g. 'in active contract negotiation')\n" +
            "   - has_attribute (a quantitative/firmographic property, e.g. 'Series B', '~50 employees')\n" +
            "Reuse a canonical short phrase for value where possible (prefer 'risk-averse' " +
            "over 'cautious'/'conservative') so the same trait does not fragment. Only " +
            "include attributes actually stated or clearly implied; omit if none.\n\n" +
            "4. decisions: each decision the content states. Each is an object " +
            '{"decision","actor","date"}: decision is what was decided, copied word for word ' +
            "from the content; actor is who decided, as written; date is when, as YYYY-MM-DD. " +
            "Omit actor or date when the content does not state it.\n\n" +
            'Return JSON: {"facts": ["..."], "entities": [{"name":"...","type":"...","description":"..."}], ' +
            '"attributes": [{"subject":"...","predicate":"...","value":"..."}], ' +
            '"decisions": [{"decision":"...","actor":"...","date":"..."}]}',
        },
        { role: "user", content: content.slice(0, 6000) },
      ],
      response_format: { type: "json_object" },
      max_tokens: 1500,
      temperature: 0.1,
      ...extras,
    });
    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      facts?: unknown;
      entities?: unknown;
      attributes?: unknown;
      decisions?: unknown;
    };
    const facts = Array.isArray(parsed.facts)
      ? (parsed.facts as unknown[]).filter((f): f is string => typeof f === "string" && f.length > 15)
      : [];
    const decisions = parseDecisions(parsed.decisions, content);
    const entitySeeds = parseEntitySeeds(parsed.entities, content, decisions).map(entitySeedToSentence);
    const attributes = parseAttributes(parsed.attributes);
    return { facts, entitySeeds, attributes, decisions: decisions.map(decisionToSentence) };
  } catch {
    return { facts: [], entitySeeds: [], attributes: [], decisions: [] };
  }
}

// ── Dev-mode direct ingest bypass ─────────────────────────────────────────────
// Inngest SDK v4 step ops are incompatible with inngest-cli v1.x in local dev —
// steps silently never execute. `runMemoryIngest` runs the same pipeline inline
// (no step wrappers) so dev writes actually land in Neo4j + pgvector.
// `ingestMemory` is the drop-in replacement for every `inngest.send(MEMORY_INGEST_EVENT, ...)`
// call: it bypasses Inngest when INNGEST_BYPASS=1, routes through the queue otherwise.

/**
 * Marks an `IngestInput.confirmDelivery` target delivered. Called only once the
 * ingest work it names has really finished, never at enqueue/dispatch time (see
 * that field's doc comment in types/memory.ts). The contact ledger is the only
 * consumer today.
 *
 * A guarded `updateMany` (`ingestedAt: null` in the WHERE), not a plain
 * `update` on the unique key. The dispatch-side claim in
 * `services/contacts/agent-contacts.ts` (`claimDeliveryAttempt`) stops a second
 * delivery from being dispatched while the first is still in flight, but TWO
 * deliveries can still legitimately both be dispatched (the lease-expiry case
 * that claim intentionally allows, see its doc comment), and this write is
 * what races then. Guarding it means the first delivery to finish is the one
 * whose completion sticks; the second, once it also finishes, is a harmless
 * no-op instead of overwriting an already-correct `ingestedAt` with a later one.
 */
async function markContactIngestDelivered(confirm: NonNullable<IngestInput["confirmDelivery"]>): Promise<void> {
  await db.contactIdempotencyKey.updateMany({
    where: { orgId: confirm.orgId, key: confirm.key, ingestedAt: null },
    data: { ingestedAt: new Date() },
  });
}

/**
 * An ingest named a connector source that has no connection: no connect row in
 * this org, a disconnected one, or one at another scope. Nothing was written.
 */
export class SourceNotConnectedError extends Error {
  constructor(sourceId: string) {
    super(`Source ${sourceId} is not connected at the scope this ingest writes into; nothing was written.`);
    this.name = "SourceNotConnectedError";
  }
}

/** Drop the row the request path stored for an ingest the job then refused. */
async function dropReadableRow(input: IngestInput): Promise<void> {
  if (input.readableId === undefined || !input.sourceId) return;
  await dropRefusedSourceRow({ orgId: input.groupId, sourceId: input.sourceId, chunkId: input.readableId });
}

/**
 * Check the source again after the last write. A disconnect that committed between
 * the first check and a write is seen here, and what this ingest wrote is removed;
 * one that commits after this check retires the content itself. Returns whether the
 * write stands.
 */
async function sourceWriteStands(input: IngestInput): Promise<boolean> {
  if (await ingestSourceIsConnected(input)) return true;
  // The check before the first write passed, so it named a source and a scope.
  await retireLateSourceWrite({ orgId: input.groupId, sourceId: input.sourceId!, scopePath: input.scopePath! });
  return false;
}

/**
 * Whether the row the request path stored for this ingest (`readableId`) is still there,
 * in the org and scope it was stored in. Deleting the fact removes that row, and an ingest
 * whose row is gone must not write the fact into the graph.
 */
async function readableRowExists(input: IngestInput): Promise<boolean> {
  if (input.readableId === undefined) return true;
  return pgvectorStore.isStored({
    groupId: input.groupId,
    chunkId: input.readableId,
    scopePath: input.scopePath ?? null,
  });
}

/**
 * Check the stored row again after the last graph write. A delete that committed between
 * the first check and a write retired nothing, because the episodes were not there yet; it
 * is seen here, and what this ingest wrote to the graph is retired. One that commits after
 * this check finds the episodes and retires them itself (`HybridMemoryStore.removeFact`).
 * Returns whether the write stands.
 */
async function readableRowStands(input: IngestInput): Promise<boolean> {
  if (await readableRowExists(input)) return true;
  // Every graph write of this ingest carries the row's id as its chunk stamp, at the
  // scope the row was stored in (`GraphitiStore.ingest`).
  // Graph only: the removal epoch is moved around it (scopeCacheStamp()).
  await removingFromGraph(input.groupId, () =>
    graphitiStore.removeChunkFacts({ groupId: input.scopePath ?? input.groupId, chunkId: input.readableId! }),
  );
  return false;
}

/**
 * Check, after a correction's last write, that the version it corrects was not erased while the
 * job ran; if it was, remove what the job stored (`withdrawCorrectionOfErased`). Returns whether
 * the write stands. An erasure that commits after this check finds the correction itself: it was
 * stored, announced and linked to the version it corrects before the graph steps
 * (`storeBeforeGraph`), and its graph episodes carry its row's id.
 */
async function correctionStands(input: IngestInput, versionId: string): Promise<boolean> {
  if (!(await correctsErasedVersion(input))) return true;
  await withdrawCorrectionOfErased(input, versionId);
  return false;
}

/**
 * Runs one ingest job inline. Resolves true when its graph steps ran to the end, false when
 * it returned before them or stopped after them (the source is not connected, the version
 * was erased or deleted, the write skips graph extraction, or a check after the graph steps
 * withdrew it); the ack of an awaited request-path ingest says "completed" only for true.
 */
export async function runMemoryIngest(input: IngestInput): Promise<boolean> {
  // A connector write with no connection writes nothing (see ingestSourceIsConnected).
  if (!(await ingestSourceIsConnected(input))) {
    await dropReadableRow(input);
    return false;
  }
  // A correction of a version a person erasure removed is part of what was erased.
  if (await correctsErasedVersion(input)) return false;
  // A fact deleted before its job ran is not written into the graph.
  if (!(await readableRowExists(input))) return false;
  if (input.skipGraphExtraction) {
    await storeWithoutGraph(input);
    return false;
  }
  const shouldResolve = input.resolve !== false && input.actorType === "human";
  const content = shouldResolve
    ? await resolveEntities(input.groupId, input.actorId, input.content, {
        llm: true,
        actorName: input.actorName,
      }).then((r) => r.resolvedText)
    : input.content;
  const rowId = await storeBeforeGraph(input, content);
  const job = withReadableRow(input, rowId);
  try {
    return await extractIntoGraph(input, job, content, rowId);
  } catch (e) {
    // The content is stored and readable; only its graph extraction is owed. Name the
    // row, so the request path can keep it for another attempt (services/memory/graph-extraction-retry.ts).
    if (rowId === null) throw e;
    throw new GraphExtractionError({ ...job, readableId: rowId }, e);
  }
}

/** The graph steps of `runMemoryIngest`, for content already stored as `rowId` (or that gets no row). */
async function extractIntoGraph(
  input: IngestInput,
  job: IngestInput,
  content: string,
  rowId: string | null,
): Promise<boolean> {
  const shouldDistill = shouldDistillContent(job, content);

  if (shouldDistill) {
    const { facts, entitySeeds, attributes, decisions } = await distillFacts(content);
    if (facts.length > 0 || attributes.length > 0 || decisions.length > 0) {
      for (const seed of entitySeeds) {
        await memory.ingest({ ...withoutOccurredAt(job), content: seed, actorType: "extraction" });
      }
      for (const fact of facts) {
        await storeDerivedRecord({ ...job, content: fact });
      }
      for (const decision of decisions) {
        await storeDerivedRecord({ ...job, content: decision, recordType: "decision" });
      }
      // Node attribute facts (goals/traits/prefs/status), at the input's own provenance,
      // so they inherit ranking + disputes.
      for (const attr of attributes) {
        await storeDerivedRecord({ ...job, content: attributeToSentence(attr) });
      }
      const { episodeId } = await ingestRawContent(job, content);
      if (!(await sourceWriteStands(job))) return false;
      if (!(await readableRowStands(job))) return false;
      if (!(await correctionStands(job, rowId ?? episodeId))) return false;
      if (job.confirmDelivery) await markContactIngestDelivered(job.confirmDelivery);
      if (rowId === null) await recordIngestAppliedOnce(input, episodeId);
      return true;
    }
    console.warn(
      `[memory] distill extracted 0 facts for a ${job.actorType} episode (scope=${job.scopePath ?? "root"}); ingesting raw — Graphiti may not yield graph edges for it`,
    );
  }

  const { episodeId } = await ingestRawContent(job, content);
  if (!(await sourceWriteStands(job))) return false;
  if (!(await readableRowStands(job))) return false;
  if (!(await correctionStands(job, rowId ?? episodeId))) return false;
  if (job.confirmDelivery) await markContactIngestDelivered(job.confirmDelivery);
  if (rowId === null) await recordIngestAppliedOnce(input, episodeId);
  return true;
}

// ── Write-through visibility ─────────────────────────────────────────────────
// Announcing a fact as the queued job's last step made it wait behind every
// other writer's graph extraction, since the queue runs a bounded number of
// steps across the whole account: with six agents writing at once a fact took
// p50 23 s / p95 >60 s to show up in another agent's memory_changes or
// memory_query, against 6.5 s for one writer.
//
// So the request path stores the content in pgvector (the store memory_query's
// semantic leg reads) and announces it on the change feed BEFORE the job is
// queued. Visibility then costs one embedding call and two Postgres writes per
// ingest, whatever the queue is doing. The job does the graph work only.
//
// The request path's store write is keyed on the content (`ingestOnce`, with
// services/memory/ingest-content-key.ts): a retried identical ingest finds its
// row already there and writes nothing, so a retry cannot duplicate the fact,
// its feed event or its graph job.
//
// The feed's rule (services/memory/fact-change-event.ts) still holds: the event
// is written only after a store write that reads serve from has landed. Order
// is unchanged too: events take their `seq` in commit order under the per-org
// lock, so two writers in one scope announce in the order they committed.

/** Whether this content gets a pgvector row. Mirrors the hybrid store's rule
 * (`HybridMemoryStore.ingest`): extraction content and empty content never do. */
function getsVectorRow(input: Pick<IngestInput, "actorType" | "content">): boolean {
  return input.actorType !== "extraction" && input.content.trim().length > 0;
}

/** Whether the request path can store and announce this ingest's content as-is.
 * Human content that the resolver will rewrite is stored by the job after
 * resolution, as before. */
function canStoreForReading(input: IngestInput): boolean {
  if (input.readableId !== undefined) return false;
  if (!getsVectorRow(input)) return false;
  const resolvesFirst = input.resolve !== false && input.actorType === "human";
  return !resolvesFirst;
}

/**
 * How long the request path waits for the memory service to embed an ingest before it
 * leaves the write to the queued job. Well inside /api/mcp's 60 s maxDuration: on
 * 2026-10-14 the memory service accepted requests and answered none, and every
 * memory_ingest waited on it until the platform killed the function.
 */
export const WRITE_THROUGH_TIMEOUT_MS = 15_000;

/** What the request path did with an ingest's content before queueing the job. */
type WriteThrough =
  | { kind: "stored"; episodeId: string; outcome: IngestOutcome }
  | { kind: "replay"; episodeId: string; existingDates: StoredDates | null }
  | { kind: "queued" };

/**
 * Store the content where reads are served from and announce it.
 *
 * `stored`: the content is in pgvector under `episodeId` and on the change feed;
 * `outcome` says whether it is current, or which version is current instead and why
 * (services/memory/fact-change-event.ts). The row, its announcement and its outcome were
 * written in one transaction (`announcedOnStore`), so no reader saw the row before its
 * outcome.
 * `replay`: a row with the same content key (`ingestContentKey`: org, scope, name,
 * normalized content, base version) was already there as `episodeId`, so nothing was
 * written or announced.
 * `queued`: this ingest keeps the queued announcement, either because it never
 * qualifies (`canStoreForReading`) or because its embedding failed, in which case the job
 * embeds, stores and announces it (`storeBeforeGraph`). An embedding not back within
 * WRITE_THROUGH_TIMEOUT_MS is such a failure.
 *
 * A failed transaction is not queued: it rolled back, so nothing was stored, and the job
 * would wait on the same database. It throws `VersionNotStoredError`, which the caller
 * answers as a write that was not stored and can be sent again.
 */
async function storeForReading(input: IngestInput): Promise<WriteThrough> {
  if (!canStoreForReading(input)) return { kind: "queued" };
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error(`the memory service did not embed within ${WRITE_THROUGH_TIMEOUT_MS} ms`)),
    WRITE_THROUGH_TIMEOUT_MS,
  );
  try {
    const stored = await pgvectorStore.ingestOnce(input, {
      signal: deadline.signal,
      sameTransaction: announcedOnStore(input),
    });
    if (!stored.inserted)
      return { kind: "replay", episodeId: stored.episodeId, existingDates: stored.existingDates ?? null };
    return { kind: "stored", episodeId: stored.episodeId, outcome: stored.decided };
  } catch (e) {
    if (e instanceof VersionNotStoredError) throw e;
    console.warn(
      "[memory] write-through store failed; the queued ingest will announce this fact:",
      e instanceof Error ? e.message : e,
    );
    return { kind: "queued" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The ingest as the graph receives it: without the writer's `occurredAt`. That date
 * dates the stored chunk only (services/memory/pgvector-store.ts clamps it); the graph
 * keeps the server's clock as its reference time, so a stated date never decides which
 * of two contradicting edges the graph retires. Every graph write in this file goes
 * through here.
 */
function withoutOccurredAt(input: IngestInput): IngestInput {
  const { occurredAt: _statedDate, ...graphInput } = input;
  return graphInput;
}

/**
 * Store one record the distiller derived from an ingest's content (a fact, an attribute
 * or a decision) in the graph only.
 *
 * A derived record is a sentence about the version the ingest stored, not a version of
 * the fact the ingest names. The version's own pgvector row already holds the content
 * each record is derived from, so a second row would only duplicate it in semantic
 * search. Were one stored, the store would mark it as no version (`factVersion`,
 * services/memory/conflict.ts), so it could not contend with other writers' versions.
 */
function storeDerivedRecord(record: IngestInput): Promise<IngestResult> {
  return graphitiStore.ingest(withoutOccurredAt(record));
}

/**
 * Store the ingest's own content where reads are served from and announce it, before any
 * graph write, unless the request path already did (`readableId`). Returns the id of the
 * row that holds the content, or null for content that gets no pgvector row.
 *
 * The text goes first because the graph steps can fail for good, past the queue's retries,
 * and a correction's job runs after the fact it corrects was removed: were the text stored
 * after them, a graph outage would lose the correction along with the fact it replaced.
 * A retry stores and announces nothing twice (`storeAndAnnounceOnce`). The row's id is the
 * version memory_version reads and the conflict rule settles, so it is the id announced.
 * Content that gets no pgvector row has only its graph episode to announce, which the job
 * does once that episode is written.
 */
async function storeBeforeGraph(input: IngestInput, content: string): Promise<string | null> {
  if (input.readableId !== undefined) return input.readableId;
  const stored = { ...input, content };
  if (!getsVectorRow(stored)) return null;
  return storeAndAnnounceOnce(stored, input);
}

/**
 * Store `stored` as a version from the queued job and announce it as `input`, each once. A
 * new row is stored, announced and settled in one transaction (`announcedOnStore`); a row
 * the content key already names (an identical ingest's) is announced unless it was.
 * Returns the row's id.
 */
async function storeAndAnnounceOnce(stored: IngestInput, input: IngestInput): Promise<string> {
  const { episodeId, inserted } = await pgvectorStore.ingestOnce(stored, { sameTransaction: announcedOnStore(input) });
  if (!inserted) await recordIngestAppliedOnce(input, episodeId);
  return episodeId;
}

/**
 * The ingest as its graph steps run it once its content is stored under `rowId`: naming
 * the row as `readableId`, as the request path names a row it stored. Every graph write
 * then carries the row's chunk stamp, and the check after the last write retires those
 * writes when the row was deleted meanwhile (`readableRowStands`).
 */
function withReadableRow(input: IngestInput, rowId: string | null): IngestInput {
  return rowId === null ? input : { ...input, readableId: rowId };
}

/** The graph episode for the ingest's own content, which `storeBeforeGraph` already stored. */
function ingestRawContent(input: IngestInput, content: string): Promise<IngestResult> {
  return graphitiStore.ingest(withoutOccurredAt({ ...input, content }));
}

/**
 * The whole job for a write that skips graph extraction: store and announce its row unless
 * the request path did. Returns the row's id.
 */
async function storeWithoutGraph(input: IngestInput): Promise<{ episodeId: string }> {
  return { episodeId: input.readableId ?? (await storeAndAnnounceOnce(input, input)) };
}

/** What `ingestMemory` tells its caller about the write it accepted. */
export interface IngestAck {
  /** True when the content is stored and on the change feed by the time the call
   * returns; false when it is stored once the queued job finishes. */
  readableNow: boolean;
  /** The stored version's id, which a later update names as its `baseVersion`.
   * Absent while the content is only queued. */
  versionId?: string;
  /** Present when the content lost a conflict as it was stored: the id of the version
   * another writer stored first, which memory_query returns in its place. The content
   * itself stays readable by id. */
  supersededBy?: string;
  /** Present when the same text was already stored with another date than this write
   * would have had: nothing was written, so the stored version keeps its own. `occurredAt`
   * is the date its writer stated, or null when it is dated by when it was stored. */
  storedDateKept?: { occurredAt: string | null };
  /** Where this write's graph extraction stands when the call returns. Absent, it continues
   * in the background (`after()` or the Inngest job). Present when it does not:
   *  - `completed`, `kept`, `failed`: it ran before the call returned, under INNGEST_BYPASS
   *    outside a request (the stdio MCP server, scripts), where `after()` is not available
   *    and the ingest is awaited. `completed`: the graph steps finished. `kept`: they failed,
   *    the version is kept in graph_extraction_retries, and the retry job can run here
   *    (`graphExtractionRetryRuns`). `failed`: they failed and no retry will come: the
   *    version could not be kept, the failure came before any graph step, or no retry job
   *    runs on this install (a self-hosted one has no Inngest; a kept row then waits unused).
   *  - `none`: the write skips graph extraction (`skipGraphExtraction`), or an awaited ingest
   *    returned without completing its graph steps (`runMemoryIngest` resolved false).
   *  - `earlier`: nothing was written; an earlier write stored the same text and queued its
   *    extraction then. */
  graphExtraction?: GraphExtractionState;
}

/** Where a write's graph extraction stands when ingestMemory returns (`IngestAck.graphExtraction`). */
export type GraphExtractionState = InlineGraphExtraction | "earlier";

/** How an awaited request-path ingest ended. */
export type InlineGraphExtraction = "completed" | "kept" | "failed" | "none";

/**
 * Whether the graph-extraction retry job (lib/inngest/scheduled-jobs.ts `graphExtractionRetry`,
 * the only thing that attempts a kept version again) can run on this install: Inngest Cloud
 * keys are set, or an Inngest dev server is in use. A self-hosted install sets neither. This
 * reads configuration; it cannot tell whether that server is up.
 */
export function graphExtractionRetryRuns(env: Record<string, string | undefined> = process.env): boolean {
  if (env.INNGEST_SIGNING_KEY?.trim()) return true;
  // As the Inngest SDK reads it: unset, "0" and "false" mean cloud mode, not a dev server.
  const dev = env.INNGEST_DEV?.trim().toLowerCase();
  return Boolean(dev) && dev !== "0" && dev !== "false";
}

/**
 * The one-line error for a local queue nobody is listening on, or null for any other
 * failure. In development (`INNGEST_DEV` set outside production) the events go to the
 * Inngest dev server; when it is not running, the SDK's own error is a bare
 * "fetch failed", which names neither the cause nor the fix.
 */
function localQueueDown(error: unknown): Error | null {
  const devServer = Boolean(process.env.INNGEST_DEV) && process.env.NODE_ENV !== "production";
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  if (!devServer || cause?.code !== "ECONNREFUSED") return null;
  return new Error(
    "Could not queue the write: no Inngest dev server is answering. Start one with: npx inngest-cli@latest dev (docs/development.md, Full path, step 6).",
  );
}

/** The fact a based write targets, as services/memory/fact-update.ts names it. */
function basedWriteTarget(data: IngestInput & { baseVersion: string }): BasedWriteTarget {
  if (!data.name?.trim()) {
    throw new Error("baseVersion needs name: a version is a version of the fact that name and scope identify.");
  }
  return {
    orgId: data.groupId,
    entityName: data.name,
    storedScopePath: data.scopePath ?? null,
    eventScopePath: data.scopePath ?? orgRootPath(data.groupId),
    baseVersionId: data.baseVersion,
  };
}

/**
 * Refuse a based write whose base is no longer current before anything is stored. An
 * identical retry of a based write that was already stored skips this: its replay is
 * answered from the row it stored (`ingestMemory`), the way its first attempt was.
 */
async function refuseStaleBaseBeforeStoring(data: IngestInput & { baseVersion: string }): Promise<void> {
  if (await pgvectorStore.storedVersionOf(data)) return;
  await assertBaseVersionCurrent(db, basedWriteTarget(data));
}

/** The fact and writer a tracked write without a base is checked for, or null when it is not checked. */
function unbasedTrackedWriter(data: IngestInput): FactWriter | null {
  if (data.baseVersion !== undefined || !data.readsTracked || !data.name?.trim()) return null;
  return {
    orgId: data.groupId,
    agentId: data.actorId,
    entityName: data.name,
    storedScopePath: data.scopePath ?? null,
    eventScopePath: data.scopePath ?? orgRootPath(data.groupId),
    ...(data.receivedAt === undefined ? {} : { receivedAt: data.receivedAt }),
  };
}

/**
 * Refuse a tracked write without a base that comes from a stale read, before anything is
 * stored. An identical retry of a write already stored skips this, like a based retry.
 */
async function refuseUnreadVersionBeforeStoring(data: IngestInput, writer: FactWriter): Promise<void> {
  if (await pgvectorStore.storedVersionOf(data)) return;
  await assertNoUnreadVersion(db, writer);
}

/**
 * Whether `data` is a session-state capture that replaces its own session's earlier capture: one
 * marked as a capture, named as one, that names the version it replaces. The store checks that
 * base is a version of this very fact, so the session's first capture was already counted, and
 * every later one is the same episode. It is
 * neither checked against the free plan's cap nor counted toward it.
 */
function replacesOwnCapture(data: IngestInput): boolean {
  return (
    data.sessionStateCapture === true &&
    data.baseVersion !== undefined &&
    data.role === "progress" &&
    (data.name?.startsWith(SESSION_STATE_NAME_OPENING) ?? false)
  );
}

/**
 * Accept one write into memory: store it where reads are served from and announce it
 * when it can be, then queue graph extraction, unless the write skips it
 * (`skipGraphExtraction`).
 *
 * @throws StaleBaseVersionError when `data.baseVersion` names a version a newer one has
 *   replaced. When the write was already stored by then, the error names the stored copy,
 *   which is superseded; no graph extraction is queued for it.
 * @throws UnknownBaseVersionError when `data.baseVersion` is not a version of this fact.
 * @throws VersionNotStoredError when the transaction that stores the write and decides its
 *   outcome failed: nothing was stored or queued, and the same write can be sent again.
 * @throws UnstorableTextError when the content, name or source holds a NUL character,
 *   which Postgres cannot store; nothing is stored or queued.
 * @throws UnreadVersionError when a tracked write without a base comes from a stale read
 *   (services/memory/fact-reads.ts); when it was already stored, the stored copy is
 *   superseded and no graph extraction is queued for it.
 */
export async function ingestMemory(request: IngestInput): Promise<IngestAck> {
  const unstorable = unstorableText({ content: request.content, name: request.name, source: request.source });
  if (unstorable) throw unstorable;
  // When this write was received, taken before the checks and the embedding below can
  // delay it: the conflict rule judges contention by it (services/memory/received-at.ts).
  // memory_ingest over MCP takes it at its own entry and passes it on; every other
  // caller's write is received here. It travels with the write, so a write the queued job
  // stores is still dated by when it was received.
  const receivedAt = request.receivedAt ?? (await receivedNow());
  const data: IngestInput = receivedAt === undefined ? request : { ...request, receivedAt };
  if (!(await ingestSourceIsConnected(data))) throw new SourceNotConnectedError(data.sourceId!);
  const sameEpisode = replacesOwnCapture(data);
  if (!sameEpisode) await checkEpisodeCap(data.groupId);
  const based = data.baseVersion === undefined ? null : { ...data, baseVersion: data.baseVersion };
  if (based) await refuseStaleBaseBeforeStoring(based);
  const tracked = unbasedTrackedWriter(data);
  if (tracked) await refuseUnreadVersionBeforeStoring(data, tracked);

  const writeThrough = await storeForReading(data);
  if (writeThrough.kind === "replay") {
    // The same fact is already stored, announced and queued for graph extraction
    // by an earlier ingest. Nothing to write; the caller's retry succeeds like its first attempt did.
    if (based) {
      const current = await currentVersionReplacing(db, data.groupId, writeThrough.episodeId);
      if (current) throw staleStored(based, writeThrough.episodeId, current);
    }
    if (tracked) {
      const current = await currentVersionReplacing(db, data.groupId, writeThrough.episodeId);
      if (current) throw await unreadVersionError(db, tracked, { storedVersionId: writeThrough.episodeId, current });
    }
    if (data.confirmDelivery) await markContactIngestDelivered(data.confirmDelivery);
    const kept = storedDateKept(data, writeThrough.existingDates);
    return {
      readableNow: true,
      versionId: writeThrough.episodeId,
      graphExtraction: "earlier",
      ...(kept ? { storedDateKept: kept } : {}),
    };
  }
  const stale =
    writeThrough.kind === "stored" &&
    writeThrough.outcome.supersededBy !== null &&
    writeThrough.outcome.cause === "stale-read"
      ? { storedVersionId: writeThrough.episodeId, current: writeThrough.outcome.supersededBy }
      : null;
  if (stale && based) {
    // Lost to a newer version while it was being stored: kept, superseded and announced,
    // but never extracted into the graph, where its text could retire the newer version's.
    throw staleStored(based, stale.storedVersionId, stale.current);
  }
  if (stale && tracked) {
    // The same, for a write without a base that raced a version its writer had not read.
    throw await unreadVersionError(db, tracked, stale);
  }
  const input: IngestInput = writeThrough.kind === "stored" ? { ...data, readableId: writeThrough.episodeId } : data;

  // A stored write that skips graph extraction has nothing left for the job to do.
  if (data.skipGraphExtraction && writeThrough.kind === "stored") {
    if (!sameEpisode) await recordEpisode(data.groupId);
    return { ...storedAck(writeThrough), graphExtraction: "none" };
  }

  let graphExtraction: InlineGraphExtraction | undefined;
  if (process.env.INNGEST_BYPASS === "1") {
    // Bare fire-and-forget loses the work on serverless: the response returns, the
    // instance freezes, and the ingest never finishes: uploads silently produce
    // nothing in prod. `after()` keeps compute alive past the
    // response. Outside a request scope (scripts, tests) it throws, so fall back.
    const run = (): Promise<InlineGraphExtraction> =>
      runMemoryIngest(input).then((extracted) => (extracted ? "completed" : "none"), keepFailedExtraction);
    try {
      const { after } = await import("next/server");
      after(run);
    } catch {
      // Outside a request scope: the stdio MCP server, scripts, tests. The ingest runs now and
      // the reply says how it ended, since it no longer continues after the reply.
      const ended = await run();
      graphExtraction = ended === "kept" && !graphExtractionRetryRuns() ? "failed" : ended;
    }
  } else {
    await inngest.send({ name: MEMORY_INGEST_EVENT, data: input }).catch((e: unknown) => {
      throw localQueueDown(e) ?? e;
    });
  }

  await recordEpisode(data.groupId);
  const ran = graphExtraction === undefined ? {} : { graphExtraction };
  if (writeThrough.kind !== "stored") return { readableNow: false, ...ran };
  return { ...storedAck(writeThrough), ...ran };
}

/**
 * What the request path does when the ingest it ran after replying fails. A stored version
 * whose graph extraction failed is kept for another attempt (services/memory/graph-extraction-retry.ts);
 * anything else is only logged, as nothing durable names it. Every line starts
 * "[memory] ingest failed", which the production log check counts.
 */
async function keepFailedExtraction(error: unknown): Promise<"kept" | "failed"> {
  if (!(error instanceof GraphExtractionError)) {
    console.error("[memory] ingest failed:", error);
    return "failed";
  }
  try {
    await deferGraphExtraction(error);
    console.error(`[memory] ingest failed: ${error.message}; kept for another attempt`);
    return "kept";
  } catch (recordError) {
    console.error(`[memory] ingest failed: ${error.message}; could not keep it for another attempt:`, recordError);
    return "failed";
  }
}

/** The reply for a write the request path stored: its version, and the one it lost to, if any. */
function storedAck({ episodeId, outcome }: Extract<WriteThrough, { kind: "stored" }>): IngestAck {
  return {
    readableNow: true,
    versionId: episodeId,
    ...(outcome.supersededBy === null ? {} : { supersededBy: outcome.supersededBy }),
  };
}

/**
 * The stored version's date, when a write that found its text already stored would have
 * dated it otherwise; null when the dates agree. A replay writes nothing, so the stored
 * date stands either way: this says when the writer should know it.
 *
 * The write's own date is compared as the store would have recorded it: its `occurredAt`
 * clamped to the stored row's write time, the way the original write was clamped, or no
 * stated date at all. So a retried post-dated write agrees with its clamped row, and an
 * undated write is told when the row carries another writer's stated date.
 */
function storedDateKept(data: IngestInput, stored: StoredDates | null): { occurredAt: string | null } | null {
  if (!stored) return null;
  const wanted =
    data.occurredAt === undefined ? null : Math.min(Date.parse(data.occurredAt), stored.createdAt.getTime());
  const kept = stored.occurredAt?.getTime() ?? null;
  return wanted === kept ? null : { occurredAt: stored.occurredAt?.toISOString() ?? null };
}

/** The refusal for a based write whose stored copy `storedVersionId` is superseded by `current`. */
function staleStored(
  data: IngestInput & { baseVersion: string },
  storedVersionId: string,
  current: string,
): StaleBaseVersionError {
  const target = basedWriteTarget(data);
  return new StaleBaseVersionError(
    { entityName: target.entityName, scopePath: target.eventScopePath },
    { baseVersionId: data.baseVersion, currentVersionId: current, storedVersionId },
  );
}

export const memoryIngest = inngest.createFunction(
  {
    id: "memory-ingest",
    name: "Memory: ingest episode",
    retries: 3,
    triggers: [{ event: MEMORY_INGEST_EVENT }],
    // A job that failed all its retries keeps its stored write for the graph-extraction retry pass
    // (services/memory/graph-extraction-retry.ts). A write with no stored version names nothing to retry.
    onFailure: async ({ event, error }) => {
      const data = event.data.event.data as IngestInput;
      if (data.readableId === undefined) return;
      const job = { ...data, readableId: data.readableId };
      try {
        await deferGraphExtraction(new GraphExtractionError(job, error));
        console.error(`[memory] ingest failed: ${error.message}; kept for another attempt`);
      } catch (recordError) {
        console.error(`[memory] ingest failed: ${error.message}; could not keep it for another attempt:`, recordError);
      }
    },
  },
  async ({ event, step }) => {
    const input = event.data as IngestInput;

    // A queued ingest naming a connector source writes nothing once that source
    // has no connection, however it was connected when the event was sent. The
    // row the request path stored before queueing goes too. The source is checked
    // again after the last write (`withdrawnWrite`), which is what closes the window
    // between this check and the writes: a disconnect that lands in between is
    // seen there and what the job wrote is removed.
    const refused = { episodeId: null, refused: "source not connected" } as const;
    if (input.sourceId && !(await step.run("verify-source", () => ingestSourceIsConnected(input)))) {
      await step.run("drop-readable-row", () => dropReadableRow(input));
      return refused;
    }
    // A fact deleted before this job ran is not written into the graph. The row is checked
    // again after the last write (`withdrawnWrite`), which closes the window between this check
    // and the writes, the same way the source check does.
    const deleted = { episodeId: null, refused: "fact deleted" } as const;
    if (input.readableId !== undefined && !(await step.run("verify-readable-row", () => readableRowExists(input)))) {
      return deleted;
    }
    // A correction of a version a person erasure removed is part of what was erased: checked
    // before any write, and again after the last one (`verify-corrected-version-after-write`).
    const erased = { episodeId: null, refused: "corrects an erased version" } as const;
    if (input.correctionOf && (await step.run("verify-corrected-version", () => correctsErasedVersion(input)))) {
      return erased;
    }
    /** Why the job's writes to `job` were withdrawn after the fact, or null when they stand. */
    const withdrawnWrite = async (job: IngestInput) => {
      if (job.sourceId && !(await step.run("verify-source-after-write", () => sourceWriteStands(job)))) {
        return refused;
      }
      if (
        job.readableId !== undefined &&
        !(await step.run("verify-readable-row-after-write", () => readableRowStands(job)))
      ) {
        return deleted;
      }
      return null;
    };

    if (input.skipGraphExtraction) {
      const stored = await step.run("store-without-graph", () => storeWithoutGraph(input));
      return (await withdrawnWrite(input)) ?? stored;
    }

    // Step 1: resolve entity references for human-written content (pronouns, etc).
    const shouldResolve = input.resolve !== false && input.actorType === "human";
    const content = shouldResolve
      ? await step.run("resolve-entities", async () => {
          const { resolvedText } = await resolveEntities(input.groupId, input.actorId, input.content, {
            llm: true,
            actorName: input.actorName,
          });
          return resolvedText;
        })
      : input.content;

    // Step 2: store and announce the content before any graph step (storeBeforeGraph),
    // so a graph step that fails past its retries cannot lose it.
    const rowId = await step.run("store-readable", () => storeBeforeGraph(input, content));
    const job = withReadableRow(input, rowId);

    // Step 3: distill long/abstract content into concrete declarative facts before
    // Graphiti sees it. Short content and extraction-provenance content are already
    // concrete — pass them straight through. Long human/document content benefits
    // from distillation because Graphiti's entity extractor produces cleaner edges
    // when each episode is a tight subject-verb-object sentence.
    const shouldDistill = shouldDistillContent(job, content);

    if (shouldDistill) {
      const { facts, entitySeeds, attributes, decisions } = await step.run("distill-facts", () =>
        distillFacts(content),
      );

      if (facts.length > 0 || attributes.length > 0 || decisions.length > 0) {
        // Seed B2B entity nodes first so Graphiti creates them before the facts
        // reference them — this produces proper edges instead of orphaned mentions.
        if (entitySeeds.length > 0) {
          await step.run("graphiti-seed-entities", async () => {
            for (const seed of entitySeeds) {
              await memory.ingest({
                ...withoutOccurredAt(job),
                content: seed,
                actorType: "extraction", // entity definitions are system-level facts
              });
            }
          });
        }

        // Node attribute facts + relationship facts share one governed pipeline:
        // rendered to declarative sentences and bulk-ingested at the input's own
        // provenance so they inherit ranking, temporal validity, and disputes.
        const attributeSentences = attributes.map(attributeToSentence);
        const distilled = [...facts, ...attributeSentences];
        if (distilled.length > 0) {
          await step.run("graphiti-add-distilled-facts", () =>
            graphitiStore.ingestBulk(distilled.map((fact) => ({ ...withoutOccurredAt(job), content: fact }))),
          );
        }

        // Decisions one at a time, each stored verbatim as a Decision fact by the
        // memory service: a bulk episode is paraphrased by Graphiti's extractor,
        // which is how a decision's content was lost before.
        if (decisions.length > 0) {
          await step.run("graphiti-add-decisions", async () => {
            for (const decision of decisions) {
              await storeDerivedRecord({ ...job, content: decision, recordType: "decision" });
            }
          });
        }

        // The raw content as its own graph episode.
        const raw = await step.run("graphiti-add-raw-episode", () => ingestRawContent(job, content));
        const withdrawn = await withdrawnWrite(job);
        if (withdrawn) return withdrawn;
        if (
          input.correctionOf &&
          !(await step.run("verify-corrected-version-after-write", () => correctionStands(job, rowId ?? raw.episodeId)))
        ) {
          return erased;
        }
        if (job.confirmDelivery) {
          await step.run("mark-contact-ingested", () => markContactIngestDelivered(job.confirmDelivery!));
        }
        if (rowId === null) {
          await step.run("record-applied-change", () => recordIngestAppliedOnce(input, raw.episodeId));
        }
        return {
          episodeId: "distilled",
          factCount: facts.length,
          entityCount: entitySeeds.length,
          attributeCount: attributes.length,
          decisionCount: decisions.length,
        };
      }
      // Distillation returned nothing — warn (silent-loss visibility) + fall through.
      console.warn(
        `[memory] distill extracted 0 facts for a ${input.actorType} episode (scope=${input.scopePath ?? "root"}); ingesting raw — Graphiti may not yield graph edges for it`,
      );
    }

    // Standard path: the content as one undistilled graph episode.
    const result = await step.run("graphiti-add-episode", () => ingestRawContent(job, content));
    const withdrawn = await withdrawnWrite(job);
    if (withdrawn) return withdrawn;
    if (
      input.correctionOf &&
      !(await step.run("verify-corrected-version-after-write", () => correctionStands(job, rowId ?? result.episodeId)))
    ) {
      return erased;
    }
    if (job.confirmDelivery) {
      await step.run("mark-contact-ingested", () => markContactIngestDelivered(job.confirmDelivery!));
    }
    if (rowId === null) {
      await step.run("record-applied-change", () => recordIngestAppliedOnce(input, result.episodeId));
    }
    return { episodeId: rowId ?? result.episodeId };
  },
);
