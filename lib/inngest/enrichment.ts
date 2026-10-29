// UC4 enrichment: research a CRM record, write the findings to memory, and
// link the resulting entity back onto the record that asked for it.
import { db } from "@/lib/db";
import { memory } from "@/services/memory";
import { graphReadAllowedFor } from "@/services/memory/raw-rows";
import { enrich, type EnrichmentTarget } from "@/services/enrichment";
import type { AuditOrigin } from "@/services/access/origin";
import type { IngestResult } from "@/types/memory";
import { RESEARCH_AGENT_NAME } from "@/services/access/system-actors";
import { inngest } from "./client";

export const ENRICH_EVENT = "enrichment/requested";

/** Event payload: what to research + which CRM record to link the resulting entity
 *  onto + who dispatched it (provenance). The route derives all of this. */
export interface EnrichmentJobInput {
  orgId: string;
  target: EnrichmentTarget;
  /** Account id or Contact id (per target.kind) to stamp with the memory entityId. */
  recordId: string;
  actorId: string;
  actorName?: string;
  /** The entry point the request for this research came in through. */
  origin: AuditOrigin;
}

/**
 * Best-effort link from the CRM record to the memory entity the findings created.
 * After ingest, entities exist in the graph; we match one by name and set entityId
 * (Postgres ↔ Neo4j link). Returns the linked entity uuid, or null if no match —
 * not finding one is fine (the facts are still in memory under the tenant).
 */
export async function linkEntity(input: EnrichmentJobInput): Promise<string | null> {
  // An org whose tier does not read the graph gets no graph entity id on its record,
  // since nothing it reads would resolve one.
  if (!(await graphReadAllowedFor(input.orgId))) return null;
  const want = input.target.name.trim().toLowerCase();

  // Up to 3 attempts, with a short delay before each retry — Graphiti writes
  // entities asynchronously after add_episode returns, so the node may not
  // appear in the graph immediately.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
    const graph = await memory.graph({ groupId: input.orgId, limit: 300 });
    const node =
      graph.nodes.find((n) => n.name.trim().toLowerCase() === want) ??
      graph.nodes.find((n) => {
        const have = n.name.trim().toLowerCase();
        return have.includes(want) || want.includes(have);
      });
    if (node) {
      if (input.target.kind === "account") {
        await db.account.update({ where: { id: input.recordId }, data: { entityId: node.uuid } });
      } else {
        await db.contact.update({ where: { id: input.recordId }, data: { entityId: node.uuid } });
      }
      return node.uuid;
    }
  }
  return null;
}

/**
 * Store research findings about the record in memory, under no fact name.
 *
 * Findings are research about the record, not a version of a fact named after it. The
 * store marks them as no version (`factVersion`, services/memory/conflict.ts), so the
 * winner rule and the stale-read checks never count them; leaving the name off as well
 * keeps any reader that matches rows by name alone from taking them for one. Without the
 * name they are still found by search; the graph service used the name only as the
 * episode's label.
 */
function storeFindings(input: EnrichmentJobInput, content: string): Promise<IngestResult> {
  return memory.ingest({
    groupId: input.orgId,
    content,
    source: "enrichment",
    actorType: "agent",
    origin: input.origin,
    actorId: input.actorId,
    actorName: input.actorName ?? RESEARCH_AGENT_NAME,
  });
}

/** Core enrichment pipeline — shared between the Inngest function and the direct
 *  dev-mode path (called from the route handler to avoid SDK v4 / CLI v1.31 step
 *  execution incompatibility). */
export async function runEnrichment(input: EnrichmentJobInput) {
  async function setStatus(status: string | null) {
    const data = { enrichStatus: status };
    if (input.target.kind === "contact") {
      await db.contact.updateMany({ where: { id: input.recordId, orgId: input.orgId }, data });
    } else {
      await db.account.updateMany({ where: { id: input.recordId, orgId: input.orgId }, data });
    }
  }

  await setStatus("Gathering research…");
  const findings = await enrich(input.target);
  if (!findings.hasFindings) {
    await setStatus(null);
    return { ingested: false, results: findings.results };
  }

  await setStatus("Ingesting to memory…");
  const { episodeId } = await storeFindings(input, findings.content);

  await setStatus("Linking entity…");
  const entityId = await linkEntity(input);
  await setStatus(null);
  return { ingested: true, episodeId, entityId, results: findings.results };
}

export const enrichmentRun = inngest.createFunction(
  {
    id: "enrichment-run",
    name: "Enrichment: research → memory",
    retries: 2,
    triggers: [{ event: ENRICH_EVENT }],
  },
  async ({ event }) => {
    const input = event.data as EnrichmentJobInput;

    async function setStatus(status: string | null) {
      const data = { enrichStatus: status };
      if (input.target.kind === "contact") {
        await db.contact.updateMany({ where: { id: input.recordId, orgId: input.orgId }, data });
      } else {
        await db.account.updateMany({ where: { id: input.recordId, orgId: input.orgId }, data });
      }
    }

    await setStatus("Gathering research…");
    const findings = await enrich(input.target);
    if (!findings.hasFindings) {
      await setStatus(null);
      return { ingested: false, results: findings.results };
    }

    await setStatus("Ingesting to memory…");
    const { episodeId } = await storeFindings(input, findings.content);

    await setStatus("Linking entity…");
    const entityId = await linkEntity(input);

    await setStatus(null);
    return { ingested: true, episodeId, entityId, results: findings.results };
  },
);
