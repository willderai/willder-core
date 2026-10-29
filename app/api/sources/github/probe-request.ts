// The request and reply shapes the GitHub token probe routes share
// (POST /api/sources/github/repositories and /reach): the token read from the
// body and checked before it goes into a header, every reply marked no-store,
// and a GitHub refusal turned into the status the connect form acts on.

import { NextResponse } from "next/server";
import { isRateLimited, per } from "@/lib/rate-limit";
import { looksLikeGitHubToken, type GitHubProbeError } from "@/services/connectors/github-token-probe";

/** A JSON reply no cache keeps: it describes what one token can reach. */
export function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export const bad = (error: string) => reply({ error }, 400);

/** Where a GitHub refusal sends the form: fix the token (400), wait (429), or try again (502). */
export function probeErrorReply(error: GitHubProbeError) {
  const status = error.reason === "rate-limited" ? 429 : error.reason === "unavailable" ? 502 : 400;
  return reply({ error: error.message, reason: error.reason, retryAt: error.retryAt }, status);
}

/** The request body's token, trimmed, or why it is refused. */
export function readToken(value: unknown): { token: string } | { error: string } {
  if (typeof value !== "string" || value.trim() === "") return { error: "token is required" };
  const token = value.trim();
  if (!looksLikeGitHubToken(token))
    return { error: "That does not look like a GitHub token. Paste the whole token, with no spaces." };
  return { token };
}

/** Probes per person per hour, across both routes. Search and paging each count; the listing cache keeps most of them off GitHub. */
const PROBES_PER_HOUR = 300;

/** True when this person has used up their probes for the hour. */
export function probeLimitReached(orgId: string, userId: string): boolean {
  return isRateLimited(`sources:github-probe:${orgId}:${userId}`, PROBES_PER_HOUR, per.hour);
}

export const tooManyProbes = () => reply({ error: "Too many repository lookups. Try again in a few minutes." }, 429);
