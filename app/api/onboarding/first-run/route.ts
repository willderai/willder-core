// GET /api/onboarding/first-run — what the overview page's first-run checklist shows:
// the three steps from a new workspace to memory doing something true (write a fact,
// see who wrote it, give an agent less and watch it get refused), each read from the
// org's own records. Nothing here is inferred or stored as a flag: a step is done
// exactly when the row that proves it exists.
//
// Same gate as the audit page and the token list (access.manage): the answer names
// writers, scopes and agents across the whole org. It never carries fact text; the
// first fact is linked to the Timeline, whose detail panel is an audited memory.read.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { AUDIT_ORIGINS, check, orgRootPath } from "@/services/access";
import { queryAuditLog } from "@/services/access/audit-query";
import {
  changeWriterType,
  resolveActorNames,
  resolveConnectorSource,
  resolveUserNames,
} from "@/services/audit/actor-names";
import { latestFactWrite } from "@/services/memory/change-history";
import type { ActorType } from "@/types/memory";

export const dynamic = "force-dynamic";

/** How many of the person's own recent memory reads are searched for a Timeline detail open. */
const OPENED_CHANGE_LOOKBACK = 50;

export interface FirstRunStatus {
  /** The latest fact written in the org, or null before the first one. */
  fact: {
    changeId: string;
    writer: string;
    writerType: ActorType;
    /** The connected source it came from, else the entry point it came in through; null when neither was recorded. */
    source: string | null;
    scopeName: string;
  } | null;
  /** True once this person has opened any change's detail, which shows its writer and source. */
  openedFact: boolean;
  /** The newest live token a person minted on a scope below the org root, or null. */
  subScopeToken: { agent: string; scopeName: string } | null;
  /** Whether that token's agent has been refused since the token was minted. */
  denied: boolean;
}

export async function GET() {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { allowed } = await check(rc.ctx, { action: "access.manage", target: "onboarding:first-run" });
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const orgId = rc.org.id;
  const root = orgRootPath(orgId);
  const [fact, openedFact, token] = await Promise.all([
    latestFactWrite(orgId),
    hasOpenedAChange(orgId, rc.user.id),
    db.capability.findFirst({
      where: {
        orgId,
        issuedByPerson: true,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        scopePath: { startsWith: `${root}.` },
      },
      orderBy: { createdAt: "desc" },
      select: { agentId: true, scopePath: true, createdAt: true },
    }),
  ]);

  const scopeNames = await namesOfScopes(orgId, [fact?.scopePath, token?.scopePath]);
  const status: FirstRunStatus = {
    fact: fact && {
      changeId: fact.id,
      ...(await describeWriter(orgId, fact)),
      scopeName: scopeNames[fact.scopePath] ?? fact.scopePath,
    },
    openedFact,
    subScopeToken: token && {
      agent: (await resolveActorNames(orgId, [token.agentId]))[token.agentId]!,
      scopeName: scopeNames[token.scopePath] ?? token.scopePath,
    },
    denied: token ? await deniedSince(orgId, token.agentId, token.createdAt) : false,
  };
  return NextResponse.json(status);
}

/** The writer's name and type, and the source a fact came from, the way the Timeline names them. */
async function describeWriter(
  orgId: string,
  fact: { actorId: string; actorType: string | null; origin: keyof typeof AUDIT_ORIGINS | null },
): Promise<{ writer: string; writerType: ActorType; source: string | null }> {
  const userNames = await resolveUserNames([fact.actorId]);
  const writerType = changeWriterType(fact, userNames);
  const writer = userNames[fact.actorId] ?? (await resolveActorNames(orgId, [fact.actorId]))[fact.actorId]!;
  const connector = await resolveConnectorSource(orgId, fact.actorId);
  const source = connector ? connector.name : fact.origin ? AUDIT_ORIGINS[fact.origin] : null;
  return { writer, writerType, source };
}

/** True when the person has opened a change's detail in the Timeline: an allowed,
 * audited memory.read whose target names a change (app/api/audit/timeline/[changeId]). */
async function hasOpenedAChange(orgId: string, userId: string): Promise<boolean> {
  const { entries } = await queryAuditLog({
    orgId,
    actorId: userId,
    actorType: "human",
    decision: "allow",
    search: "/change:",
    page: 1,
    pageSize: OPENED_CHANGE_LOOKBACK,
  });
  return entries.some((e) => e.action === "memory.read" && e.target?.includes("/change:"));
}

/** True when the agent has a visible denial recorded at or after `since`. */
async function deniedSince(orgId: string, agentId: string, since: Date): Promise<boolean> {
  const { entries } = await queryAuditLog({
    orgId,
    actorId: agentId,
    actorType: "agent",
    decision: "deny",
    page: 1,
    pageSize: 1,
  });
  return entries.some((e) => e.at >= since);
}

async function namesOfScopes(orgId: string, paths: (string | undefined)[]): Promise<Record<string, string>> {
  const wanted = [...new Set(paths.filter((p): p is string => p !== undefined))];
  if (wanted.length === 0) return {};
  const scopes = await db.scope.findMany({
    where: { orgId, path: { in: wanted } },
    select: { path: true, name: true },
  });
  return Object.fromEntries(scopes.map((s) => [s.path, s.name]));
}
