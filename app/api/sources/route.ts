import { randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { scopeNameTooLong } from "@/services/access/scope-name";
import { requireAccessContext } from "@/lib/access-context";
import {
  check,
  computeWidening,
  decideWidening,
  isMintableScopePath,
  isValidLtreePath,
  normalizeScopePath,
  orgRootPath,
  scopeAudience,
  type DerivedAuditAction,
} from "@/services/access";
import { wideningAcknowledged, wideningNotAcknowledged } from "@/services/access/deny-reason";
import { readersAtSource } from "@/services/connectors/source-readers";
import { writeAuditRow } from "@/services/access/audit-row";
import { inngest, SOURCE_SYNC_EVENT } from "@/lib/inngest";
import { isRateLimited, per } from "@/lib/rate-limit";
import type { SourceSyncInput } from "@/lib/inngest";
import type { SourceType } from "@/lib/generated/prisma/enums";
import type { Prisma } from "@/lib/generated/prisma/client";
import { SLACK_MOCK } from "@/services/connectors/slack";
import { FIGMA_MOCK } from "@/services/connectors/figma";
import { normalizePostHogHost, POSTHOG_DEFAULT_HOST, PostHogConnectorError } from "@/services/connectors/posthog";
import { assertRepositoryReadable, parseRepoFullName, GitHubConnectorError } from "@/services/connectors/github";
import { SourceAccessError } from "@/services/connectors/source-access";
import { sealSecret } from "@/lib/crypto";
import { retireSourceContent } from "@/services/memory/source-retirement";
import { recordSourceChange } from "@/services/memory/source-change-event";
import { pageOfSource, pageSourceIds } from "@/services/memory/source-page";
import { parseAccessListQuery } from "@/lib/access-lists";
import { SOURCE_LIST_SPEC, SOURCE_PAGE_SIZE } from "@/lib/source-lists";

// GET  /api/sources?page=N — one page of this org's connected sources, searched (q),
//   filtered (type, status, kind=connector) and ordered (sort, order) as
//   lib/source-lists.ts lists them: `{ sources, total, count, page, pageSize }`, the
//   Integrations panels' read. With `at=<source id>`, the page answered is the one
//   holding that source in this view (the requested page when it is not there), and
//   `found` says which. Without `page`, every source, newest first, for the API
//   clients that look one up.
// POST /api/sources — connect a new source (Drive folder, website domain,
//   Slack channel, Figma file, or PostHog insight).
//   Body: { type: "gdrive", folderId, folderName, token, scopePath? }
//         { type: "website", domain, scopePath? }
//         { type: "slack", channelId, channelName, token?, scopePath? }
//         { type: "figma", fileKey, fileName, token?, scopePath? }
//         { type: "posthog", projectId, insightId, insightName, apiKey, host?, scopePath? }
//         { type: "github", repo: "owner/name", token, scopePath? }
//   Every body may also carry `acknowledgeWidening` (see "Widening" below).
// Gated: memory.write on the scope the source lands in — the path in
// `scopePath`, the scope a reconnected source already uses, or the new child
// of the org root a first connect mints. Grants match ancestor-or-self, so an
// org-wide writer still passes for any of them, and a scope admin passes
// inside the subtree they administer and nowhere else.
//
// Slack/Figma read-only ingestion has no OAuth yet, so `token` is optional
// for these two while fixture mode is active (SLACK_MOCK/FIGMA_MOCK; see
// services/connectors/{slack,figma}.ts). Fixture mode is off in production,
// where `token` is required: a bare unauthenticated POST must never ingest
// fabricated fixture content into a real tenant. A non-empty token is sealed
// onto `Source.encryptedTokens`, never validated and discarded, so a later
// re-sync that supplies no fresh token can unseal it (see the sync route).
//
// Widening: a source takes its scope's access, not its own sharing list at the
// source. After the permission checks and before anything is written, the
// connect counts the people who can read the scope but are not shown to read
// the source, and the agents holding a live capability token on the scope
// (services/access/source-widening.ts). When either count is above zero, or the
// connector cannot report its readers at all, the connect is refused with 409
// unless `acknowledgeWidening` is `{ people, agents }` naming exactly the counts
// the refusal named (`people: "unknown"` for a source that cannot report its
// readers). The path taken, both counts, who decided and when are recorded on
// the source row beside `connectAuthorizationId`, and an acknowledgement also
// writes a `source.widening.acknowledged` audit row.
//
// PostHog is not fixture-gated at all: `apiKey` is always required. It is the
// customer's own real, read-only personal API key, pasted here, never read
// from an env var or forwarded to a model, sealed with lib/crypto's
// sealSecret (AES-256-GCM, APP_ENCRYPTION_KEY, same primitive
// services/integrations/mailbox.ts uses for OAuth tokens) into
// Source.encryptedTokens, and never selected back out by GET's own `select`.

const SUPPORTED_TYPES: SourceType[] = ["gdrive", "website", "slack", "figma", "posthog", "github"];

/** Every body field feeding `toLabel`/scope naming must be a real string, not
 *  merely truthy: a non-empty non-string JSON value (a number, object, array)
 *  passes `!body.channelName`, and `toLabel` then calls `.toLowerCase()` on it
 *  and throws a raw TypeError, an uncaught 500 instead of a validation 400. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toLabel(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "source";
  return `${slug}_${randomBytes(3).toString("hex")}`;
}

/**
 * Record on `Source.meta` that a connect has asked for a new sync.
 *
 * Drops the error, and the lost access, the previous sync left: it described the credential and
 * state that sync ran with, and a reconnect is exactly how a customer replaces
 * a credential that failed. Keeping it made a reconnected source read as still
 * failing until the new sync finished. Stamps `syncRequestedAt`, so a reader
 * can tell a sync that is queued or running (`syncRequestedAt` after
 * `lastSyncAt`) from one that was never asked for.
 *
 * Also stamps `syncRequestId`, which names this connect's sync and travels on its
 * event. It makes this connect's sync the only one that writes for the source: a
 * sync another connect fired earlier and that is still queued or running stands
 * down at its next step (`sourceWriteState` in lib/inngest/source-state.ts), so a
 * retried connect never runs two full syncs side by side.
 *
 * One statement, so it cannot overwrite fields a sync finishing at the same
 * moment writes; every other key in `meta` is kept.
 */
async function markSyncRequested(
  tx: Prisma.TransactionClient,
  sourceId: string,
  at: Date,
  syncRequestId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "sources"
    SET "meta" = (COALESCE("meta", '{}'::jsonb) - 'error' - 'accessLost')
      || jsonb_build_object('syncRequestedAt', ${at.toISOString()}::text, 'syncRequestId', ${syncRequestId}::text)
    WHERE "id" = ${sourceId}
  `;
}

/** Set a source's `meta` to `meta`, keeping the `syncRunId` it holds (see POST's upsert). */
async function replaceMetaKeepingSyncRun(
  tx: Prisma.TransactionClient,
  sourceId: string,
  meta: Record<string, string>,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "sources"
    SET "meta" = ${JSON.stringify(meta)}::jsonb
      || jsonb_strip_nulls(jsonb_build_object('syncRunId', "meta"->'syncRunId'))
    WHERE "id" = ${sourceId}
  `;
}

/** The columns GET returns: never `encryptedTokens`, the sealed credential. */
const SOURCE_COLUMNS = {
  id: true,
  type: true,
  externalId: true,
  name: true,
  scopePath: true,
  status: true,
  meta: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { files: true } },
} as const;

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const decision = await check(rc.ctx, { action: "memory.write", target: "sources:list" });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  const params = new URL(req.url).searchParams;
  const query = parseAccessListQuery(params, SOURCE_LIST_SPEC);
  if (query === null) {
    const sources = await db.source.findMany({
      where: { orgId: rc.org.id },
      orderBy: { createdAt: "desc" },
      select: SOURCE_COLUMNS,
    });
    return NextResponse.json({ sources });
  }
  if ("error" in query) return NextResponse.json({ error: query.error }, { status: 400 });

  const at = params.get("at");
  if (at?.includes("\u0000"))
    return NextResponse.json({ error: "at must not contain a NUL character" }, { status: 400 });
  const located = at === null ? null : await pageOfSource(rc.org.id, query, at);
  const page = located ?? query.page;
  const { ids, total, count } = await pageSourceIds(rc.org.id, { ...query, page });
  const found = await db.source.findMany({ where: { orgId: rc.org.id, id: { in: ids } }, select: SOURCE_COLUMNS });
  const byId = new Map(found.map((source) => [source.id, source]));
  return NextResponse.json({
    sources: ids.flatMap((id) => byId.get(id) ?? []),
    total,
    count,
    page,
    pageSize: SOURCE_PAGE_SIZE,
    ...(at === null ? {} : { found: located !== null }),
  });
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (isRateLimited(`sources:connect:${rc.org.id}`, 20, per.hour)) {
    return NextResponse.json({ error: "rate limit exceeded" }, { status: 429 });
  }

  let body: {
    type?: string;
    folderId?: string;
    folderName?: string;
    domain?: string;
    channelId?: string;
    channelName?: string;
    fileKey?: string;
    fileName?: string;
    token?: string;
    scopePath?: string;
    projectId?: string;
    insightId?: string;
    insightName?: string;
    apiKey?: string;
    host?: string;
    repo?: string;
    /** The widening the caller confirms: the `acknowledge` value a refusal named. */
    acknowledgeWidening?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json body" }, { status: 400 });
  }

  const type = body.type as SourceType;
  if (!SUPPORTED_TYPES.includes(type)) {
    return NextResponse.json(
      { error: "type must be gdrive, website, slack, figma, posthog, or github" },
      { status: 400 },
    );
  }

  let externalId: string;
  let name: string;
  /** Sealed and stored on Source.encryptedTokens below: a caller-supplied
   *  posthog apiKey, or slack/figma token. Left `undefined` (leaves the
   *  column untouched on a reconnect that doesn't resupply one) whenever the
   *  caller didn't send a real value. */
  let encryptedTokens: string | undefined;
  /** Only set for type "posthog" — non-secret, needed by sourceSync to re-fetch. */
  let posthogMeta: { projectId: string; host: string } | undefined;
  /** Only set for type "github": the pasted token, checked against the repository before anything is written. */
  let githubToken: string | undefined;

  if (type === "gdrive") {
    if (!isNonEmptyString(body.folderId) || !isNonEmptyString(body.folderName)) {
      return NextResponse.json({ error: "folderId and folderName are required for gdrive" }, { status: 400 });
    }
    if (!isNonEmptyString(body.token)) {
      return NextResponse.json({ error: "token is required for gdrive" }, { status: 400 });
    }
    externalId = body.folderId;
    name = body.folderName;
  } else if (type === "slack") {
    if (!isNonEmptyString(body.channelId) || !isNonEmptyString(body.channelName)) {
      return NextResponse.json({ error: "channelId and channelName are required for slack" }, { status: 400 });
    }
    // SLACK_MOCK is production-gated off (services/connectors/slack.ts), so
    // once real API mode is active (prod, or a deliberate SLACK_MOCK=false
    // locally), a tokenless connect is rejected here rather than reaching the
    // real API with an empty bearer token and failing deep inside the sync job.
    // isNonEmptyString, not truthiness: a whitespace-only token passes
    // `!body.token` but fails the isNonEmptyString guard below that gates
    // sealSecret, so it would be accepted as "present" and never stored.
    if (!SLACK_MOCK && !isNonEmptyString(body.token)) {
      return NextResponse.json({ error: "token is required for slack outside fixture mode" }, { status: 400 });
    }
    externalId = body.channelId;
    name = body.channelName;
    if (isNonEmptyString(body.token)) encryptedTokens = sealSecret({ token: body.token });
  } else if (type === "figma") {
    if (!isNonEmptyString(body.fileKey) || !isNonEmptyString(body.fileName)) {
      return NextResponse.json({ error: "fileKey and fileName are required for figma" }, { status: 400 });
    }
    if (!FIGMA_MOCK && !isNonEmptyString(body.token)) {
      return NextResponse.json({ error: "token is required for figma outside fixture mode" }, { status: 400 });
    }
    externalId = body.fileKey;
    name = body.fileName;
    if (isNonEmptyString(body.token)) encryptedTokens = sealSecret({ token: body.token });
  } else if (type === "posthog") {
    if (!isNonEmptyString(body.projectId) || !isNonEmptyString(body.insightId) || !isNonEmptyString(body.insightName)) {
      return NextResponse.json(
        { error: "projectId, insightId and insightName are required for posthog" },
        { status: 400 },
      );
    }
    if (!/^\d+$/.test(body.projectId) || !/^\d+$/.test(body.insightId)) {
      return NextResponse.json({ error: "posthog projectId and insightId must be numeric" }, { status: 400 });
    }
    // Never optional/mock: this is the customer's own real, read-only key,
    // pasted directly — there's no fixture equivalent to fall back to.
    if (!isNonEmptyString(body.apiKey)) {
      return NextResponse.json({ error: "apiKey is required for posthog" }, { status: 400 });
    }
    let host: string;
    try {
      host = normalizePostHogHost(body.host ?? POSTHOG_DEFAULT_HOST);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof PostHogConnectorError ? e.message : "invalid posthog host" },
        { status: 400 },
      );
    }
    // A PostHog insight id is only unique within its own project, not across
    // an org's projects, so the bare insight id can't be this row's identity
    // (two projects' insight 42 would collide onto one Source, the second
    // connect silently overwriting the first's key and scope). Carrying the
    // project in externalId makes the identity actually unique.
    externalId = `${body.projectId}:${body.insightId}`;
    name = body.insightName;
    encryptedTokens = sealSecret({ apiKey: body.apiKey });
    posthogMeta = { projectId: body.projectId, host };
  } else if (type === "github") {
    // Same model as posthog: the customer's own read-only token, sealed at
    // rest, never a client token per sync. `repo` is `owner/name` and is the
    // row's identity; the token is fine-grained to that one repository.
    if (!isNonEmptyString(body.repo)) {
      return NextResponse.json({ error: "repo (owner/name) is required for github" }, { status: 400 });
    }
    if (!isNonEmptyString(body.token)) {
      return NextResponse.json({ error: "token is required for github" }, { status: 400 });
    }
    try {
      const r = parseRepoFullName(body.repo);
      externalId = `${r.owner}/${r.name}`;
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof GitHubConnectorError ? e.message : "invalid github repo" },
        { status: 400 },
      );
    }
    name = externalId;
    githubToken = body.token;
    encryptedTokens = sealSecret({ token: body.token });
  } else {
    if (!isNonEmptyString(body.domain)) {
      return NextResponse.json({ error: "domain is required for website" }, { status: 400 });
    }
    externalId = body.domain.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    name = externalId;
  }

  // Resolve scope: use provided path if it exists in this org; else, on a
  // RECONNECT of a source already known for this (org, type, externalId),
  // reuse its existing scope; else mint a new child scope under the org root.
  //
  // A reconnect must reuse the existing scope. `toLabel` mints a fresh random
  // suffix every call, so minting on every connect that omitted scopePath
  // would give a reconnected source (a token refresh, re-adding the same
  // Slack channel) a brand new scope each time. `sourceSync` writes freshly
  // (re-)ingested items under the source's *current* scopePath, but already
  // synced, unchanged items (`planConnectorSync`'s `skippedCount`) keep their
  // episodes under whatever scope was current when they were ingested, which
  // would split one logical source's content across two scopes with no way to
  // tell they were ever the same source.
  const findExistingSource = () =>
    db.source.findUnique({
      where: { orgId_type_externalId: { orgId: rc.org.id, type, externalId } },
      select: { id: true, orgId: true, scopePath: true, status: true },
    });

  // The caller's scopePath is canonicalized before it is used, so the path the
  // permission check runs against and the path looked up below cannot differ,
  // and an invalid one is rejected before reaching check()'s `::ltree` cast.
  const requestedScopePath = isNonEmptyString(body.scopePath) ? normalizeScopePath(body.scopePath) : undefined;
  if (requestedScopePath !== undefined && !isMintableScopePath(requestedScopePath)) {
    const error = isValidLtreePath(requestedScopePath)
      ? "scopePath holds a dash; scope labels are letters, digits and underscores"
      : "scopePath is not a valid scope path";
    return NextResponse.json({ error }, { status: 400 });
  }

  // Only needed here when the caller named no scope, since that is the only
  // branch whose target depends on it. The reconnect reconciliation further
  // down needs it too, but that runs after the permission check.
  let existingSource = requestedScopePath === undefined ? await findExistingSource() : null;

  /** The scope this connect lands in, and whether it still has to be created. */
  const target: { path: string; create: boolean } =
    requestedScopePath !== undefined
      ? { path: requestedScopePath, create: false }
      : existingSource
        ? { path: existingSource.scopePath, create: false }
        : { path: `${orgRootPath(rc.org.id)}.${toLabel(name)}`, create: true };
  // A connect that mints its scope names it after the source; that name is held to every scope name's limit.
  const nameTooLong = target.create ? scopeNameTooLong(name) : null;
  if (nameTooLong)
    return NextResponse.json(
      {
        error: `${nameTooLong} The source's name is used as its new scope's name; connect it into an existing scope with scopePath instead.`,
      },
      { status: 400 },
    );

  // Authorize against the scope this connect actually targets, not the org
  // root. Grants match ancestor-or-self, so an org-root grant still covers
  // every path in the org — this only ever admits callers the org-root check
  // turned away, never the reverse. The one it admits is a scope admin
  // connecting a source into a scope they administer, which is the same
  // authority app/api/access/scopes/route.ts already gives them over child
  // scopes, and which an org-root check would refuse even inside their own
  // subtree. A scope admin stays denied outside that subtree: their grant is
  // not an ancestor of any path outside it.
  const decision = await check(rc.ctx, {
    action: "memory.write",
    scope: target.path,
    target: "sources:connect",
  });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: 403 });

  if (requestedScopePath !== undefined) {
    // Existence is only revealed to a caller already authorized on that path.
    const scope = await db.scope.findUnique({
      where: { orgId_path: { orgId: rc.org.id, path: requestedScopePath } },
      select: { id: true },
    });
    if (!scope) return NextResponse.json({ error: "scopePath not found in this org" }, { status: 404 });
    existingSource = await findExistingSource();
  }

  const scopePath = target.path;
  /** The scope this source is leaving, on a reconnect that moves it. */
  const movedFrom = existingSource && existingSource.scopePath !== scopePath ? existingSource : null;
  /**
   * The source this connect brings back at the scope it was disconnected from. What it
   * still holds there was written under the connect that was removed: a write its sync
   * had in flight lands after the disconnect's purge, with a sync record that would make
   * this connect's sync skip that item as unchanged.
   */
  const reconnectedFrom =
    existingSource && !movedFrom && existingSource.status === "disconnected" ? existingSource : null;

  // A move needs write on the scope the source is LEAVING as well as the one it
  // is joining, because the reconciliation below retires everything already
  // ingested under the old scope. Authorizing only the destination would let an
  // admin of scope A pull a source out of scope B — destroying B's ingested
  // content, then re-ingesting it where A can read it — on the strength of
  // their grant on A alone. Naming the destination scope above is what makes
  // that reachable (an org-root check would already imply write everywhere in
  // the org), so the two checks go together.
  if (movedFrom) {
    const origin = await check(rc.ctx, {
      action: "memory.write",
      scope: movedFrom.scopePath,
      target: "sources:connect",
    });
    if (!origin.allowed) return NextResponse.json({ error: origin.reason }, { status: 403 });
  }

  // A GitHub token that cannot read the repository is refused here, with the
  // fix, before anything is written. Connected, it would sync nothing and look
  // like an empty repository: GitHub answers 404 to a token that cannot see a
  // private one.
  if (githubToken !== undefined) {
    try {
      await assertRepositoryReadable(externalId, githubToken);
    } catch (e) {
      if (e instanceof SourceAccessError) {
        return NextResponse.json({ error: e.message, code: "source_unreadable" }, { status: 400 });
      }
      return NextResponse.json(
        { error: "GitHub did not answer whether this token can read the repository. Try again in a minute." },
        { status: 502 },
      );
    }
  }

  // Widening, decided before anything is written: a refused connect creates no
  // scope, moves nothing and records nothing. The scope's readers are counted by
  // path, so a scope this connect is about to mint counts the grants it will
  // inherit from its ancestors; the admin grant it gives the person connecting
  // does not matter, because that person is never counted.
  const widening = computeWidening(
    await scopeAudience(rc.org.id, scopePath),
    rc.user.id,
    await readersAtSource({ type, externalId, token: isNonEmptyString(body.token) ? body.token : undefined }),
  );
  const wideningDecision = decideWidening(widening, body.acknowledgeWidening);
  if (!wideningDecision.proceed) {
    const { reason } = wideningNotAcknowledged(widening, wideningDecision.acknowledge, scopePath);
    return NextResponse.json(
      {
        error: reason,
        code: "widening_not_acknowledged",
        widening:
          widening.status === "known"
            ? { status: "known", people: widening.people, agents: widening.agents }
            : { status: "unknown", atMost: widening.atMost, agents: widening.agents },
        acknowledge: wideningDecision.acknowledge,
      },
      { status: 409 },
    );
  }

  if (target.create) {
    // Create the scope atomically and grant the creator admin on it (Google-Docs-style).
    await db.$transaction(async (tx) => {
      const scope = await tx.scope.create({ data: { orgId: rc.org.id, path: target.path, name } });
      await tx.grant.create({
        data: {
          orgId: rc.org.id,
          scopeId: scope.id,
          granteeType: "user",
          granteeId: rc.user.id,
          permission: "admin",
          createdBy: rc.user.id,
        },
      });
    });
  }

  // A reconnect that MOVES the source to a different scope has to take its
  // already-ingested content with it. Graphiti partitions by group_id, which is
  // the scope an episode was written under, so rewriting `Source.scopePath`
  // alone leaves every already-ingested episode sitting in the old group:
  // still retrievable to anyone with access there, and no longer addressable by
  // the sync (which only ever knows the source's current scope). Narrowing a
  // source's scope is exactly the case that has to work: it is how a customer
  // restricts who can see a connector's content.
  //
  // A reconnect that OMITS scopePath reuses the source's existing scope (see
  // the scope resolution above). The branch that passes an explicit scopePath
  // moves the pointer, so the old scope is reconciled here: retire this
  // source's content wherever it was written, then drop its sync records so
  // the sync fired below re-ingests everything under the new scope. The cost
  // is one full re-sync of a moved source; the alternative is content that
  // outlives the scope it was restricted to.
  //
  // Order matters. Both steps run BEFORE the upsert rewrites `scopePath`: if
  // either throws, the route 500s with the source still pointing at the old
  // scope and its records intact, so a retry reconciles the same pair again
  // rather than stranding content under a scope nothing records any more.
  if (movedFrom) {
    await retireSourceContent(movedFrom, scopePath);
    await db.sourceFile.deleteMany({ where: { sourceId: movedFrom.id } });
  }
  // A source connected again where it was disconnected starts from nothing the same
  // way, before the upsert marks it connected: the disconnected run's own cleanup
  // (`retireAfterDisconnect` in lib/inngest/connector-sync.ts) stands down once the
  // source is connected again, so whatever that run wrote late is retired here.
  if (reconnectedFrom) {
    await retireSourceContent(reconnectedFrom, null);
    await db.sourceFile.deleteMany({ where: { sourceId: reconnectedFrom.id } });
  }

  // The sync this connect fires, and the one credential its event carries. The
  // event never holds a token in clear (see SourceSyncInput). gdrive's token is
  // never stored, so it travels sealed. Slack/figma (fixture-backed without a
  // token), posthog and github carry none: sourceSync reads the credential
  // sealed above back off the Source row. A website connect fires none.
  const syncsOnConnect = type !== "website";
  /** Names this connect's sync; see `markSyncRequested`. */
  const syncRequestId = randomUUID();
  const sealedSyncToken = type === "gdrive" ? sealSecret({ token: body.token }) : undefined;

  // Upsert the Source row (idempotent re-connect). `encryptedTokens` is set
  // whenever this connect supplied one (posthog and github always do;
  // slack/figma do when the caller filled in the optional token field) —
  // `undefined` leaves the column untouched on update and unset (schema
  // default) on create. Nothing about the row's previous status gates this or
  // the sync below: a reconnect after a failed sync is how a customer recovers
  // from a bad credential. `meta` is only ever set for posthog.
  //
  // `connectAuthorizationId` records THIS connect's own allow row, on create and on
  // update alike. A connector sync runs no `check()` of its own, so this row is the
  // authority every later sync write happens under (lib/inngest/connector-sync.ts
  // stamps it onto each one), and a reconnect is a fresh authorization -- possibly by
  // a different person, possibly against a different scope -- so the newer row
  // replaces the older rather than the source keeping the one it was first connected
  // under. Events already written keep the row that was in force when they landed.
  //
  // The upsert and its change-feed event share one transaction, so the feed never
  // announces a connect that rolled back. `orgId` is the upsert's own key, so it is
  // the stored value. `existingSource` is loaded on every path that can find one;
  // two concurrent first connects can both label their event `create`, which costs
  // a reader nothing, since either way it learns that this source id changed.
  //
  // The widening columns are rewritten on every connect for the same reason: a
  // reconnect is a fresh decision. An acknowledgement writes its audit row in the
  // same transaction, so the row and the source never disagree about it.
  const source = await db.$transaction(async (tx) => {
    const decidedAt = new Date();
    const acknowledgement =
      wideningDecision.path === "no_widening"
        ? null
        : await writeAuditRow(
            {
              orgId: rc.org.id,
              actorType: rc.ctx.actor.type,
              actorId: rc.user.id,
              action: "source.widening.acknowledged" satisfies DerivedAuditAction,
              target: `${scopePath}/sources:connect`,
              decision: "allow",
              reason: wideningAcknowledged(widening, scopePath).auditReason,
              metadata: {
                type,
                externalId,
                path: wideningDecision.path,
                people: widening.status === "known" ? widening.people : "unknown",
                agents: widening.agents,
                connectAuthorizationId: decision.auditLogId ?? null,
              },
              origin: rc.ctx.origin,
            },
            tx,
          );
    const wideningRecord = {
      connectWideningPath: wideningDecision.path,
      connectWideningCount: widening.status === "known" ? widening.people : null,
      connectWideningAgentCount: widening.agents,
      connectWideningById: rc.user.id,
      connectWideningAt: decidedAt,
      connectWideningAuditId: acknowledgement?.id ?? null,
    };
    const written = await tx.source.upsert({
      where: { orgId_type_externalId: { orgId: rc.org.id, type, externalId } },
      create: {
        orgId: rc.org.id,
        type,
        externalId,
        name,
        scopePath,
        status: "active",
        encryptedTokens,
        meta: posthogMeta,
        connectAuthorizationId: decision.auditLogId,
        ...wideningRecord,
      },
      update: {
        name,
        scopePath,
        status: "active",
        updatedAt: decidedAt,
        encryptedTokens,
        connectAuthorizationId: decision.auditLogId,
        ...wideningRecord,
      },
      select: { id: true, type: true, name: true, scopePath: true, status: true },
    });
    // A reconnect keeps `meta.syncRunId`: a run still reading its stored listing when
    // the row turns "active" stays the run the row names, so an erasure in between
    // keeps that listing (`dropIdleListings`, lib/source-listing-blobs.ts). The upsert
    // holds the row's lock, so no run stamps another id between it and this write.
    if (posthogMeta) await replaceMetaKeepingSyncRun(tx, written.id, posthogMeta);
    if (syncsOnConnect) await markSyncRequested(tx, written.id, new Date(), syncRequestId);
    await recordSourceChange(
      tx,
      { ...written, orgId: rc.org.id },
      existingSource ? "update" : "create",
      rc.user.id,
      rc.ctx.origin,
    );
    return written;
  });

  // A sync already running when the old scope was purged above can still finish
  // a write there, and, if it was its last, mark itself complete, all before the
  // upsert moved the pointer, so it never sees the move. Purge the old scope once
  // more now that the pointer has moved. A write that lands after this is caught
  // by the old run itself (`retireAfterMove` in lib/inngest/connector-sync.ts),
  // which stops at its next check and retires the old scope only, so the sync
  // fired below keeps what it writes at the new one.
  // Only records still pinned to the old scope go; the first purge dropped the rest.
  if (movedFrom) {
    await retireSourceContent(movedFrom, scopePath);
    await db.sourceFile.deleteMany({ where: { sourceId: movedFrom.id, episodeScopePath: movedFrom.scopePath } });
  }
  // A late write of the removed connect can land between the purge above and the
  // upsert. Purge once more, before this connect's sync is fired below.
  if (reconnectedFrom) {
    await retireSourceContent(reconnectedFrom, null);
    await db.sourceFile.deleteMany({ where: { sourceId: reconnectedFrom.id } });
  }

  let jobId: string | undefined;
  if (syncsOnConnect) {
    const { ids } = await inngest.send({
      name: SOURCE_SYNC_EVENT,
      data: {
        sourceId: source.id,
        orgId: rc.org.id,
        syncRequestId,
        ...(sealedSyncToken ? { sealedToken: sealedSyncToken } : {}),
      } satisfies SourceSyncInput,
    });
    jobId = ids[0];
  }

  return NextResponse.json({ source, jobId }, { status: 201 });
}
