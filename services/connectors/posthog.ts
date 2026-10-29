// PostHog connector — one saved insight per connect, not a live analytics
// feed. The customer pastes their OWN read-only PostHog personal API key on
// Integrations. It is stored encrypted at
// rest (services/access route wires this through Source.encryptedTokens via
// lib/crypto's sealSecret/unsealSecret, same AES-256-GCM/APP_ENCRYPTION_KEY
// primitive services/integrations/mailbox.ts uses for OAuth tokens) — never
// in an env var, never in a model prompt. Each (re-)sync re-fetches ONE named
// insight's current computed result and ingests it as a single text episode;
// we never call a raw-events endpoint, so "no raw event export" holds by
// construction, not by convention.
//
// No mock mode, unlike slack.ts/figma.ts: those fixture-gate on OAuth not
// being wired up, and there's no equivalent gap here. A PostHog connect always
// carries a real, customer-supplied key from the first call, so there's
// nothing to fixture around.

import { createHash } from "node:crypto";
import { SourceAccessError } from "./source-access";

const ALLOWED_HOSTS = ["us.posthog.com", "eu.posthog.com", "app.posthog.com"];
export const POSTHOG_DEFAULT_HOST = "https://us.posthog.com";

export class PostHogConnectorError extends Error {}

/** Validate a customer-supplied (or default) PostHog API host: https, no
 *  path/query/credentials, and restricted to PostHog's own known hosts. A real
 *  safety property independent of where the credential comes from. */
export function normalizePostHogHost(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PostHogConnectorError("PostHog host must be a valid URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !ALLOWED_HOSTS.includes(url.hostname)
  ) {
    throw new PostHogConnectorError(`PostHog host must be one of: ${ALLOWED_HOSTS.join(", ")}.`);
  }
  return url.origin;
}

export interface PostHogInsightSnapshot {
  /** Stable per-source item id — this source only ever has one. */
  id: string;
  text: string;
  author: string;
  /** ISO-8601 — PostHog's own `last_refresh` for the insight's result, used
   *  as real ingest grounding (referenceTime) instead of ingest-time. */
  createdAt?: string;
  /** Hash of the summarized text — changes when the insight's name, filters
   *  or computed result change, so an edited insight re-ingests. */
  checksum: string;
}

function checksumOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const MAX_RESULT_CHARS = 4_000;

/** Turn a PostHog insight response into a short, human-readable summary — the
 *  "one saved insight", not the underlying series/rows. `result` is already
 *  PostHog's own aggregated computation (a trend series, funnel steps, a
 *  single number), never per-event rows, so bounding its length here is a
 *  size guard, not an event-export risk in disguise. */
function summarizeInsight(insight: { name?: string; description?: string; result?: unknown }): string {
  const parts: string[] = [];
  if (insight.name) parts.push(`Insight: ${insight.name}`);
  if (insight.description) parts.push(insight.description);
  if (insight.result !== undefined && insight.result !== null) {
    const serialized = JSON.stringify(insight.result);
    parts.push(
      `Result: ${serialized.length > MAX_RESULT_CHARS ? `${serialized.slice(0, MAX_RESULT_CHARS)}…` : serialized}`,
    );
  }
  return parts.join("\n\n") || "(this insight has no name, description or result)";
}

interface RawPostHogInsight {
  name?: string;
  description?: string;
  result?: unknown;
  deleted?: boolean;
  last_refresh?: string;
}

/**
 * Fetch the current state of one PostHog insight, read-only
 * (`GET /api/projects/:project/insights/:id/` only — never a write endpoint,
 * never `/api/projects/:project/events` or any raw-event/query endpoint).
 *
 * Returns an empty array when the insight is gone (`deleted: true`, or a 404
 * for it while its project still answers this key) so the caller's normal
 * vanished-upstream-item retirement path
 * (`planConnectorSync`/`retireVanishedTextItem`) cleans up the stale episode —
 * mirroring how a deleted Slack message or Figma comment is handled, rather
 * than leaving the source stuck in "error" forever. Any OTHER failure (bad
 * key, rate limit, network, 5xx) throws instead of returning empty: those are
 * not evidence the insight is gone, and must never be treated as license to
 * retire already-ingested content. A 403 for the insight, or a 404 for it whose
 * project this key cannot read either, throws `SourceAccessError`: a key that
 * lost the project is not a deleted insight. A 401 (a rejected key) stays an
 * ordinary error, as it does for GitHub.
 */
export async function fetchInsightSnapshot(
  projectId: string,
  insightId: string,
  apiKey: string,
  host: string = POSTHOG_DEFAULT_HOST,
): Promise<PostHogInsightSnapshot[]> {
  if (!apiKey) throw new PostHogConnectorError("PostHog API key is required.");
  if (!/^\d+$/.test(projectId) || !/^\d+$/.test(insightId)) {
    throw new PostHogConnectorError("PostHog project and insight IDs must be numeric.");
  }
  const origin = normalizePostHogHost(host);

  const headers = { Authorization: `Bearer ${apiKey}` };
  const res = await fetch(`${origin}/api/projects/${projectId}/insights/${insightId}/`, { headers });
  if (res.status === 403) {
    throw new SourceAccessError(
      `This PostHog key can't read insight ${insightId} in project ${projectId}. Give the key access to the project and reconnect, or disconnect this source.`,
    );
  }
  if (res.status === 404) {
    const project = await fetch(`${origin}/api/projects/${projectId}/`, { headers });
    if (project.ok) return [];
    if ([401, 403, 404].includes(project.status)) {
      throw new SourceAccessError(
        `PostHog can't find insight ${insightId}, and this key can't read project ${projectId} to tell whether the insight was deleted or the key lost access. Give the key read access to the project and reconnect, or disconnect this source if the insight is gone.`,
      );
    }
    throw new PostHogConnectorError(`PostHog project check failed: ${project.status}`);
  }
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new PostHogConnectorError(`PostHog insight fetch failed: ${res.status} ${err}`);
  }

  const insight = (await res.json()) as RawPostHogInsight;
  if (insight.deleted) return [];

  const text = summarizeInsight(insight);
  return [
    {
      id: `insight-${insightId}`,
      text,
      author: "PostHog",
      createdAt: insight.last_refresh,
      checksum: checksumOf(text),
    },
  ];
}
