// Enrichment orchestrator (UC4, Day 4). Researches a target across providers —
// Apollo (firmographics/people), Exa (recent web signals), Firecrawl (the company's
// own site) — and composes a single findings document to ingest into memory (UC1).
//
// Resilient by design: each provider runs independently and a failure is recorded,
// not fatal — partial findings are still worth ingesting. The composed `content` is
// what the memory pipeline extracts facts from; `results` is the per-provider status
// for the run record / logs.
import { enrichOrganization, enrichPerson } from "./apollo";
import { researchCompany } from "./exa";
import { scrapeSite, siteUrl } from "./firecrawl";

type EnrichmentProvider = "apollo" | "exa" | "firecrawl";

interface AccountEnrichmentTarget {
  kind: "account";
  /** Company name — used for the episode title + research query. */
  name: string;
  /** Company domain — required to enrich firmographics + scrape the site. */
  domain?: string;
}

interface ContactEnrichmentTarget {
  kind: "contact";
  name: string;
  /** Person email — required for Apollo people match. */
  email?: string;
  /** Optional company domain for added web context. */
  domain?: string;
}

export type EnrichmentTarget = AccountEnrichmentTarget | ContactEnrichmentTarget;

interface ProviderResult {
  provider: EnrichmentProvider;
  ok: boolean;
  error?: string;
  /** True when the provider was deliberately not run (e.g. Apollo disabled), as
   *  opposed to run-and-failed. Keeps the run record honest about cost decisions. */
  skipped?: boolean;
}

/**
 * Apollo is the only paid, per-credit provider; it is OFF by default to control
 * cost (Exa + Firecrawl cover most of the signal cheaply). Flip it on per-env with
 * `ENRICHMENT_APOLLO_ENABLED=1` (or true/on/yes) when firmographics are worth the
 * credits. When off, enrich() records Apollo as `skipped` rather than running it.
 */
function apolloEnabled(): boolean {
  const v = (process.env.ENRICHMENT_APOLLO_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export interface EnrichmentFindings {
  /** The composed text to ingest as one memory episode. Empty if everything failed. */
  content: string;
  /** Per-provider outcome (for the run record + logs). */
  results: ProviderResult[];
  /** True if at least one provider produced content. */
  hasFindings: boolean;
}

/** Run a single provider, capturing its text on success or its error on failure. */
async function run(
  provider: EnrichmentProvider,
  fn: () => Promise<string>,
  blocks: string[],
  results: ProviderResult[],
): Promise<void> {
  try {
    const text = await fn();
    blocks.push(text);
    results.push({ provider, ok: true });
  } catch (e) {
    results.push({ provider, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Enrich a target and return composed findings. Runs the relevant providers in
 * parallel; each is independent so one outage doesn't sink the run.
 */
export async function enrich(target: EnrichmentTarget): Promise<EnrichmentFindings> {
  const blocks: string[] = [];
  const results: ProviderResult[] = [];
  const tasks: Promise<void>[] = [];

  const useApollo = apolloEnabled();

  if (target.kind === "account") {
    if (target.domain) {
      if (useApollo) {
        tasks.push(run("apollo", () => enrichOrganization(target.domain as string), blocks, results));
      } else {
        results.push({ provider: "apollo", ok: false, skipped: true });
      }
      tasks.push(run("firecrawl", () => scrapeSite(siteUrl(target.domain as string)), blocks, results));
    }
    tasks.push(run("exa", () => researchCompany(target.name, target.domain), blocks, results));
  } else {
    if (target.email) {
      if (useApollo) {
        tasks.push(run("apollo", () => enrichPerson(target.email as string), blocks, results));
      } else {
        results.push({ provider: "apollo", ok: false, skipped: true });
      }
    }
    // Exa: search by name + domain if available, name-only as fallback so
    // contacts like "Paul Graham" (no email/domain) still get web signals.
    tasks.push(run("exa", () => researchCompany(target.name, target.domain), blocks, results));
  }

  await Promise.all(tasks);

  const header = `Research findings for ${target.name}${
    target.domain ? ` (${target.domain})` : ""
  }, gathered ${target.kind === "account" ? "for the account" : "for the contact"}.`;
  const content = blocks.length ? `${header}\n\n${blocks.join("\n\n")}` : "";

  return { content, results, hasFindings: blocks.length > 0 };
}
