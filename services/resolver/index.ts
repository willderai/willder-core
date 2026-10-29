// Entity resolver: normalizes text before it reaches Graphiti so entity names
// are always canonical, preventing graph fragmentation and reducing traversals.
//
// Tiers:
//   1. Alias registry (Postgres, admin-curated) — highest priority
//   2. Structured CRM data (users/accounts/contacts from Postgres) — deterministic
//   3. LLM coreference pass (opt-in) — pronouns + relational refs ("my mom", "the CEO")
//
// Integration: call resolveEntities() before memory.ingest() in the Inngest job.
// For human actor writes only; agent/extraction content is already structured.

import { createLLMClient, LLM_MODEL_EXTRACT } from "@/lib/llm";
import { loadAliasEntities } from "@/services/memory/entity-aliases";
import { loadStructuredEntities } from "./structured";
import { loadOrgRoleEntities } from "./org-roles";
import { normalizeStr, buildPattern, applyPatterns } from "./normalize";
import type { KnownEntity, Resolution, ResolveResult } from "./types";

export { upsertAlias, deleteAlias, loadAliasEntities } from "@/services/memory/entity-aliases";
export { loadOrgRoleEntities } from "./org-roles";
export type { ResolveResult, EntityType } from "./types";

// Pronoun / relational reference patterns that trigger the LLM pass.
const PRONOUN_RE = /\b(my|her|his|their|our|the)\s+\w+/i;

// ── Build resolution map ──────────────────────────────────────────────────────
// Merges alias entities (Tier 2, higher priority) with structured entities (Tier 1).
// Deduplicates by entityId; alias registry wins on conflict.
// Returns pairs sorted longest-alias-first to prevent partial matches.

function buildPairs(
  aliasEntities: KnownEntity[],
  structuredEntities: KnownEntity[],
): [RegExp, string, string, string | null | undefined][] {
  // Alias registry wins: collect their entityIds
  const aliasIds = new Set(aliasEntities.map((e) => e.id));

  const all = [...aliasEntities, ...structuredEntities.filter((e) => !aliasIds.has(e.id))];

  const pairs: [string, string, string, string | null | undefined][] = [];

  for (const entity of all) {
    // A blank name would replace every alias of the entity with nothing.
    if (!entity.canonicalName.trim()) continue;
    for (const alias of entity.aliases) {
      const trimmed = alias.trim();
      if (!trimmed) continue;
      // Skip aliases that already equal the canonical name (no-op substitution)
      if (normalizeStr(trimmed) === normalizeStr(entity.canonicalName)) continue;
      pairs.push([trimmed, entity.canonicalName, entity.type, entity.entityId]);
    }
  }

  // Sort longest alias first to prevent "Acme" matching inside "Acme Corporation"
  pairs.sort((a, b) => b[0].length - a[0].length);

  return pairs.map(([alias, canonical, type, entityId]) => [buildPattern(alias), canonical, type, entityId]);
}

// ── LLM coreference pass ──────────────────────────────────────────────────────
// Only called when PRONOUN_RE matches. Uses a fast small model (8b).
// Input: text + known canonical names. Output: rewritten text (no other content).

async function llmCoreference(text: string, knownEntities: KnownEntity[], actorName?: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return text;

  const model = LLM_MODEL_EXTRACT;
  const llm = createLLMClient();

  const entityList = knownEntities
    .slice(0, 40) // cap context size
    .map(
      (e) =>
        `${e.canonicalName} (${e.type})${e.aliases.length ? ` — also known as: ${e.aliases.slice(0, 4).join(", ")}` : ""}`,
    )
    .join("\n");

  const system = [
    "You are an entity normalizer. Your only job is to rewrite the given text,",
    "replacing pronouns and relational references (like 'my mom', 'her colleague', 'the CEO')",
    "with the canonical entity names from the list below.",
    "Rules:",
    "  - Only replace references that clearly match a known entity.",
    "  - Do NOT change facts, structure, or any other wording.",
    "  - Return ONLY the rewritten text. No explanation. No markdown.",
    actorName ? `The text was written by: ${actorName}.` : "",
    "",
    "Known entities:",
    entityList,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await llm.chat.completions.create({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      temperature: 0,
      max_tokens: Math.min(text.length * 3, 2048),
    });
    // Only a reply the model finished is the text rewritten. One cut short (by the token
    // limit or a content filter) is a fragment of it, and an empty one is none of it:
    // storing either would lose what the person wrote.
    const choice = res.choices[0];
    const rewritten = choice?.message?.content?.trim();
    if (choice?.finish_reason !== "stop" || !rewritten) return text;
    return rewritten;
  } catch {
    // LLM pass is best-effort; fall back to deterministic result
    return text;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function resolveEntities(
  orgId: string,
  _actorId: string,
  text: string,
  opts: { llm?: boolean; actorName?: string } = {},
): Promise<ResolveResult> {
  if (!text.trim()) return { resolvedText: text, resolutions: [], changed: false };

  // Load Tier 1 (structured + org roles) + Tier 2 (alias registry) in parallel
  const [aliasEntities, structuredEntities, orgRoleEntities] = await Promise.all([
    loadAliasEntities(orgId),
    loadStructuredEntities(orgId),
    loadOrgRoleEntities(orgId),
  ]);

  // Merge: alias registry > org roles > structured CRM data (priority order)
  const pairs = buildPairs(aliasEntities, [...orgRoleEntities, ...structuredEntities]);

  // ── Deterministic pass ──
  const { text: afterDeterministic, substitutions } = applyPatterns(text, pairs);

  const resolutions: Resolution[] = substitutions.map((s) => ({
    original: s.original,
    canonical: s.canonical,
    type: s.type as Resolution["type"],
    entityId: s.entityId,
  }));

  // ── LLM pass (opt-in, only when pronoun patterns remain) ──
  let resolvedText = afterDeterministic;
  if (opts.llm && PRONOUN_RE.test(afterDeterministic)) {
    const allEntities = [...aliasEntities, ...orgRoleEntities, ...structuredEntities];
    resolvedText = await llmCoreference(afterDeterministic, allEntities, opts.actorName);
  }

  return {
    resolvedText,
    resolutions,
    changed: resolvedText !== text,
  };
}
