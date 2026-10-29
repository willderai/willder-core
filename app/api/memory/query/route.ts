// POST /api/memory/query: retrieve facts for a query; every read passes guardedMemory's check() gate.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { guardedMemory, MemoryServiceError } from "@/services/memory";
import { settledRuleCopiesFirst } from "@/services/memory/rule-copies";
import { AccessDeniedError, orgRootPath, resolveCallerScopePath, scopeIsAbsent } from "@/services/access";
import { isRateLimited, per } from "@/lib/rate-limit";

// POST /api/memory/query — retrieve facts for a query, scoped to the caller's org
// AND access-checked. This is "Ask." Fast/synchronous (no LLM extraction on read).
// Every read passes through the check() gate (default deny) and is audited; group_id
// isolates the tenant, check() enforces the actor's grants on top.
export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (isRateLimited(`memory:query:${rc.org.id}`, 120, per.hour)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  let body: { query?: string; limit?: number; scope?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }
  const query = body.query?.trim();
  if (!query) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 50) : undefined;
  try {
    // A malformed scope is refused by name, with one deny row, rather than reaching
    // check()'s `::ltree` cast raw. No scope stays no scope: the read keeps its
    // org-wide partition, so the resolver's fallback is never used.
    const scope = scopeIsAbsent(body.scope)
      ? undefined
      : await resolveCallerScopePath(
          rc.ctx,
          body.scope,
          { scopePath: orgRootPath(rc.org.id) },
          { onInvalid: "refuse", action: "memory.read", field: "scope" },
        );
    const result = await guardedMemory.retrieve(rc.ctx, { groupId: rc.org.id, query, limit }, scope);
    // A rule's text stored as a fact carries the rule's standing (`rule`), settled rules first.
    const facts = await settledRuleCopiesFirst(rc.org.id, result.facts);
    return NextResponse.json({ ...result, facts }); // { facts, breakdown, degraded?, partialScopeCoverage? }
  } catch (e) {
    if (e instanceof AccessDeniedError) {
      return NextResponse.json({ error: e.decision.reason }, { status: 403 });
    }
    if (e instanceof MemoryServiceError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    throw e;
  }
}
