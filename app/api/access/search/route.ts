import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  SEARCH_KINDS,
  searchAgents,
  searchAudit,
  searchScopes,
  searchSources,
  searchTokens,
  type Hits,
  type SearchKind,
} from "@/services/search/access-search";

// GET /api/access/search?q=<text>[&kinds=scopes,audit][&limit=5][&decision=allow|deny]
//
// Searches the caller's org only. Each kind is gated by the same check() its
// own list route runs, so search never shows a row the caller could not already
// list: scopes, tokens and audit rows need access.manage (as /api/access/scopes,
// /api/access/capabilities and /api/audit), sources need memory.write (as
// /api/sources), and agents need only a signed-in org member (as /api/agents).
// A kind the caller may not search comes back as { denied: true }, never as an
// empty list that reads like "no matches".

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;

type KindResult<T> = (Hits<T> & { denied: false }) | { denied: true };

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LENGTH || q.length > MAX_QUERY_LENGTH) {
    return NextResponse.json(
      { error: `q must be ${MIN_QUERY_LENGTH} to ${MAX_QUERY_LENGTH} characters` },
      { status: 400 },
    );
  }
  const parsedKinds = parseKinds(url.searchParams.get("kinds"));
  if (!parsedKinds) {
    return NextResponse.json({ error: `kinds must be a comma list of ${SEARCH_KINDS.join(", ")}` }, { status: 400 });
  }
  const kinds: SearchKind[] = parsedKinds;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
  const decisionParam = url.searchParams.get("decision");
  const decision = decisionParam === "allow" || decisionParam === "deny" ? decisionParam : undefined;

  const orgId = rc.org.id;
  const needsManage = kinds.some((k) => k === "scopes" || k === "tokens" || k === "audit");
  const [manage, write] = await Promise.all([
    needsManage ? check(rc.ctx, { action: "access.manage", target: "access:search" }) : null,
    kinds.includes("sources") ? check(rc.ctx, { action: "memory.write", target: "sources:search" }) : null,
  ]);
  const mayManage = manage?.allowed === true;
  const mayWrite = write?.allowed === true;

  async function run<T>(kind: SearchKind, allowed: boolean, search: () => Promise<Hits<T>>) {
    if (!kinds.includes(kind)) return undefined;
    if (!allowed) return { denied: true } as KindResult<T>;
    return { ...(await search()), denied: false } as KindResult<T>;
  }

  const [scopes, agents, tokens, sources, audit] = await Promise.all([
    run("scopes", mayManage, () => searchScopes(orgId, q, limit)),
    run("agents", true, () => searchAgents(orgId, q, limit)),
    run("tokens", mayManage, () => searchTokens(orgId, q, limit)),
    run("sources", mayWrite, () => searchSources(orgId, q, limit)),
    run("audit", mayManage, () => searchAudit(orgId, q, limit, decision)),
  ]);

  return NextResponse.json({ q, scopes, agents, tokens, sources, audit });
}

/** Every kind when the parameter is absent; null when it names an unknown kind. */
function parseKinds(raw: string | null): SearchKind[] | null {
  if (raw === null || raw.trim() === "") return [...SEARCH_KINDS];
  const parts = raw.split(",").map((p) => p.trim());
  const known = new Set<string>(SEARCH_KINDS);
  return parts.every((p) => known.has(p)) ? (parts as SearchKind[]) : null;
}
