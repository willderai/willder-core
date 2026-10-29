// POST /api/memory/ingest: enqueue text for ingestion; check() gates memory.write on the scope before
// anything is queued, and tenant + actor come from the session, never the body. With an
// Idempotency-Key header, a retried request queues nothing (services/memory/ingest-key.ts).
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { ingestMemory } from "@/lib/inngest";
import { AccessDeniedError, check, orgRootPath, resolveCallerScopePath } from "@/services/access";
import { isRateLimited, per } from "@/lib/rate-limit";
import { sanitizeForLLM, LIMITS } from "@/lib/sanitize";
import { GuardrailError } from "@/services/guardrails";
import {
  IngestKeyInProgressError,
  IngestKeyReusedError,
  ingestKeySchema,
  ingestRequestHash,
  withIngestKey,
} from "@/services/memory/ingest-key";
import { unstorableText } from "@/lib/unstorable-text";
import type { IngestInput } from "@/types/memory";

// A request stops after 60 s. The Idempotency-Key lease is derived from this number
// (KEYED_ROUTE_MAX_DURATION_SECONDS in services/memory/ingest-key.ts); change both.
export const maxDuration = 60;

// POST /api/memory/ingest — enqueue content for ingestion. Extraction is slow, so we
// fire an Inngest event and return a job id immediately (202); the actual Graphiti
// ingest runs in the background (lib/inngest/memory-ingest.ts). Tenant + actor
// are derived server-side, never trusted from the client. Writing memory is gated by the
// `memory.write` check (default deny, audited) — owner/admin pass by default.
export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (isRateLimited(`memory:ingest:${rc.org.id}`, 60, per.hour)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  let body: { content?: string; source?: string; name?: string; scope?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  // Before sanitizing, which strips control characters: a NUL is refused, not silently
  // dropped, the same as on every other write path (lib/unstorable-text.ts).
  const unstorable = unstorableText({ content: body.content, name: body.name, source: body.source });
  if (unstorable) return NextResponse.json({ error: unstorable.message }, { status: 400 });
  const { safe: content, injectionDetected } = sanitizeForLLM(body.content, LIMITS.memoryContent);
  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  if (injectionDetected) {
    return NextResponse.json({ error: "content contains disallowed patterns" }, { status: 400 });
  }
  const rawKey = req.headers.get("idempotency-key");
  const parsedKey = rawKey === null ? null : ingestKeySchema.safeParse(rawKey);
  if (parsedKey !== null && !parsedKey.success) {
    return NextResponse.json(
      { error: `Idempotency-Key header: ${parsedKey.error.issues[0]?.message}` },
      { status: 400 },
    );
  }

  // A malformed scope is refused by name, with one deny row, rather than reaching
  // check()'s `::ltree` cast raw or being stored at a path no read accepts. An absent
  // scope writes at the org root.
  let scope: string;
  try {
    scope = await resolveCallerScopePath(
      rc.ctx,
      body.scope,
      { scopePath: orgRootPath(rc.org.id) },
      { onInvalid: "refuse", action: "memory.write", field: "scope" },
    );
  } catch (e) {
    if (e instanceof AccessDeniedError) return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    throw e;
  }

  const decision = await check(rc.ctx, { action: "memory.write", scope, target: "ingest" });
  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: 403 });
  }

  const data: IngestInput = {
    groupId: rc.org.id, // internal org id = Neo4j group_id (tenant isolation)
    content,
    source: body.source,
    name: body.name,
    actorType: "human",
    origin: rc.ctx.origin,
    actorId: rc.user.id,
    actorName: rc.user.name ?? undefined,
    scopePath: scope,
    authorizedById: decision.auditLogId,
  };

  const queue = async () => {
    await ingestMemory(data);
    return { jobId: "queued" };
  };

  try {
    if (parsedKey === null) return NextResponse.json(await queue(), { status: 202 });
    const { reply } = await withIngestKey(
      { orgId: rc.org.id, actorType: "human", actorId: rc.user.id },
      {
        key: parsedKey.data,
        label: "Idempotency-Key",
        requestHash: ingestRequestHash([data.content, data.source, data.name, data.scopePath]),
      },
      queue,
    );
    return NextResponse.json(reply, { status: 202 });
  } catch (e) {
    if (e instanceof IngestKeyReusedError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    if (e instanceof IngestKeyInProgressError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    if (e instanceof GuardrailError) {
      return NextResponse.json({ error: e.message }, { status: 402 });
    }
    throw e;
  }
}
