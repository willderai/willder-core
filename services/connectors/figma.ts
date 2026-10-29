// Figma connector — read-only ingestion of a user-picked file's comment
// thread into memory: scoped, read-only, no autonomous writes, no new
// subscriptions. OAuth is not wired up, so the real branch below is written to
// the documented Figma REST API shape but has not been exercised against a
// live file — do not treat it as verified until an OAuth token exists to test
// it with.
//
// MOCK (default outside production): set FIGMA_MOCK=false to use the real
// Figma REST API. Production always uses the real API branch — see slack.ts's
// SLACK_MOCK comment for why (fixture content must never be ingested into a
// real tenant graph).

import { createHash } from "node:crypto";

export const FIGMA_MOCK = process.env.VERCEL_ENV === "production" ? false : process.env.FIGMA_MOCK !== "false";

export interface FigmaComment {
  /** Figma comment id (stable, unique within the file). */
  id: string;
  text: string;
  /** Figma user handle who authored the comment. */
  author: string;
  /** ISO-8601 when the comment was posted (Figma's `created_at`) — used to
   *  stamp real ingest grounding (referenceTime) instead of ingest-time. */
  createdAt?: string;
  /** Hash of the comment text — Figma comments are effectively immutable, but
   *  hash anyway so a resolved/edited thread is still detected correctly. */
  checksum: string;
}

function checksumOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * List a file's top-level comments, bounded to `limit` (default 200 — an
 * initial bounded sync). Read-only: GET /v1/files/:key/comments only, never
 * posts a reply or reaction.
 */
export async function listFileComments(
  fileKey: string,
  token: string,
  opts?: { limit?: number },
): Promise<FigmaComment[]> {
  const limit = opts?.limit ?? 200;

  if (FIGMA_MOCK) {
    const fixtures = [
      {
        text: "Can we tighten the spacing on the source citation chip?",
        author: "mock_designer",
        createdAt: "2026-09-01T10:00:00.000Z",
      },
      {
        text: "Love the empty state here, matches the brand doc.",
        author: "mock_pm",
        createdAt: "2026-09-02T14:30:00.000Z",
      },
      {
        text: "This frame is stale, see the updated flow in the Connectors page instead.",
        author: "mock_designer",
        createdAt: "2026-09-03T09:15:00.000Z",
      },
    ];
    return fixtures.slice(0, limit).map((f, i) => ({
      id: `mock_comment_${fileKey}_${i}`,
      text: f.text,
      author: f.author,
      createdAt: f.createdAt,
      checksum: checksumOf(f.text),
    }));
  }

  if (!token) {
    throw new Error("Figma token is required outside fixture mode (FIGMA_MOCK)");
  }

  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}/comments`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`Figma files/comments failed: ${res.status} ${err}`);
  }
  const data = (await res.json()) as {
    comments?: { id: string; message?: string; user?: { handle?: string }; created_at?: string }[];
  };

  return (data.comments ?? [])
    .filter((c) => c.message)
    .slice(0, limit)
    .map((c) => ({
      id: c.id,
      text: c.message as string,
      author: c.user?.handle ?? "unknown",
      createdAt: c.created_at,
      checksum: checksumOf(c.message as string),
    }));
}
