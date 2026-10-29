// The entity alias registry: which names in an org stand for one canonical
// entity, so text is normalized before it reaches the graph.
//
// An alias row is memory, not configuration. The merge route records every
// merged entity's old name here, so the registry holds names taken from the
// graph at whatever scope the entity lived in, under no scope of its own. The
// rule this file enforces: a person sees or edits the registry only when check()
// allows the action at the org root, the one scope that covers every scope an
// alias may have come from. An org role alone is not enough, since an admin can
// lose the org-root grant like any other.
//
// Two paths take no decision of their own, by design: the ingest job's resolver
// reading the registry to rewrite text it is about to store, and the merge route
// recording the alias for an entity check() just allowed it to merge. Neither
// returns a row to a caller. Every write path refuses text Postgres cannot store,
// with a 400-ready error naming the field.
import { db } from "@/lib/db";
import { unstorableText, UnstorableTextError } from "@/lib/unstorable-text";
import { Prisma } from "@/lib/generated/prisma/client";
import { SETTINGS_PAGE_SIZE, type AliasListQuery } from "@/lib/settings-lists";
import { anyElementIlike, containsPattern, ilike, readSqlPage, sqlDirection } from "@/services/memory/sql-list-page";
import type { EntityAlias } from "@/lib/generated/prisma/client";
import { can, check, orgRootPath, type AccessContext } from "@/services/access";
import type { KnownEntity, EntityType } from "@/services/resolver/types";

/** Every alias in the org, as the resolver matches them. For the ingest job only. */
export async function loadAliasEntities(orgId: string): Promise<KnownEntity[]> {
  const rows = await db.entityAlias.findMany({
    where: { orgId },
    select: { id: true, entityId: true, entityType: true, canonicalName: true, aliases: true },
  });

  return rows.map((r) => ({
    id: r.entityId,
    type: r.entityType as EntityType,
    canonicalName: r.canonicalName,
    aliases: r.aliases,
  }));
}

/** The longest entity id the registry stores, in UTF-8 bytes: room for the org id and index overhead in the composite B-tree key. */
const MAX_ENTITY_ID_BYTES = 1000;

/** A merge records its alias under the entity id `merge:<old name>`. */
const MERGE_ENTITY_ID_PREFIX = "merge:";

/**
 * The refusal for a merge of `fromName` into `toName` whose alias entry Postgres
 * cannot store, naming the request field, or undefined. The merge route asks before
 * anything is transferred, so a refused merge changes nothing. `fromName` is stored
 * twice: inside the entity id, under its byte cap, and as the alias.
 */
export function unstorableMergeAlias(fromName: string, toName: string): UnstorableTextError | undefined {
  const fromNameMaxBytes = MAX_ENTITY_ID_BYTES - Buffer.byteLength(MERGE_ENTITY_ID_PREFIX);
  return (
    unstorableText({ fromName }, { wellFormed: true, maxBytes: fromNameMaxBytes }) ??
    unstorableText({ toName }, { wellFormed: true })
  );
}

/**
 * Record that `fromName` now stands for `toName`, after check() allowed merging the
 * one into the other. Throws the {@link unstorableMergeAlias} refusal, writing nothing.
 */
export async function recordMergeAlias(
  orgId: string,
  fromName: string,
  toName: string,
  createdBy: string,
): Promise<void> {
  const unstorable = unstorableMergeAlias(fromName, toName);
  if (unstorable) throw unstorable;
  await upsertAlias(orgId, `${MERGE_ENTITY_ID_PREFIX}${fromName}`, "user", toName, [fromName], createdBy);
}

/** Create or replace the aliases of entity `entityId`, returning the stored row. */
export async function upsertAlias(
  orgId: string,
  entityId: string,
  entityType: EntityType,
  canonicalName: string,
  aliases: string[],
  createdBy?: string,
): Promise<EntityAlias> {
  return db.entityAlias.upsert({
    where: { orgId_entityId: { orgId, entityId } },
    create: { orgId, entityId, entityType, canonicalName, aliases, createdBy },
    update: { canonicalName, aliases },
  });
}

/** Remove every alias of entity `entityId`. */
export async function deleteAlias(orgId: string, entityId: string): Promise<void> {
  await db.entityAlias.deleteMany({ where: { orgId, entityId } });
}

/** Decide `action` on the whole registry: at the org root, audited. */
async function decideRegistry(ctx: AccessContext, action: "memory.read" | "memory.write", target: string) {
  return check(ctx, { action, scope: orgRootPath(ctx.orgId), target });
}

/** A registry write's decision: allowed, refused, or allowed by the grants for a key holding a NUL. */
export type RegistryWriteDecision = "allowed" | "denied" | { unstorable: UnstorableTextError };

/**
 * Decide a write at the org root whose audit target is `${kind}:${value}`, where `value`
 * is the request's `field`. check() refuses a target holding a NUL
 * whatever the grants say; this asks the grants alone (can(), no second audit row)
 * only after that refusal, so the caller they allow is told which field to fix and a
 * caller they refuse gets the same "denied" whatever it sent.
 */
export async function decideRegistryWrite(
  ctx: AccessContext,
  kind: string,
  field: string,
  value: string,
): Promise<RegistryWriteDecision> {
  const scope = orgRootPath(ctx.orgId);
  const decision = await check(ctx, { action: "memory.write", scope, target: `${kind}:${value}` });
  if (decision.allowed) return "allowed";
  const unstorable = unstorableText({ [field]: value });
  if (unstorable && (await can(ctx, { action: "memory.write", scope })).allowed) return { unstorable };
  return "denied";
}

/** An alias entry as the Settings table shows it. */
export type AliasRow = {
  id: string;
  entityId: string;
  entityType: string;
  canonicalName: string;
  aliases: string[];
  createdAt: string;
};

/**
 * One page of the org's aliases, searched over the canonical name, the type and
 * every alias, filtered by type and ordered by name, type or date added; or null
 * when check() refuses reading the org root.
 */
export async function readEntityAliasPage(ctx: AccessContext, q: AliasListQuery) {
  const decision = await decideRegistry(ctx, "memory.read", "entity_aliases");
  if (!decision.allowed) return null;

  const narrowed: Prisma.Sql[] = [];
  if (q.filters.type) narrowed.push(Prisma.sql`e."entityType" = ${q.filters.type}`);
  if (q.search !== "") {
    const p = containsPattern(q.search);
    narrowed.push(Prisma.sql`(${ilike(Prisma.sql`e."canonicalName"`, p)} OR ${ilike(Prisma.sql`e."entityType"`, p)}
      OR ${anyElementIlike(Prisma.sql`e."aliases"`, p)})`);
  }
  const dir = sqlDirection(q.order);
  const order =
    q.sort === "type"
      ? Prisma.sql`e."entityType" ${dir}, lower(e."canonicalName") ASC, e."id" ASC`
      : q.sort === "created"
        ? Prisma.sql`e."createdAt" ${dir}, e."id" ${dir}`
        : Prisma.sql`lower(e."canonicalName") ${dir}, e."id" ${dir}`;

  const { rows, total, count } = await readSqlPage<Omit<AliasRow, "createdAt"> & { createdAt: Date }>({
    select: Prisma.sql`e."id", e."entityId", e."entityType", e."canonicalName", e."aliases", e."createdAt"`,
    from: Prisma.sql`"entity_aliases" e`,
    inOrg: Prisma.sql`e."orgId" = ${ctx.orgId}`,
    narrowed,
    order,
    page: q.page,
    pageSize: SETTINGS_PAGE_SIZE,
  });
  return {
    rows: rows.map((r): AliasRow => ({ ...r, createdAt: r.createdAt.toISOString() })),
    total,
    count,
    page: q.page,
    pageSize: SETTINGS_PAGE_SIZE,
  };
}

/**
 * Create or replace an alias entry on behalf of a person, or null when check()
 * refuses writing at the org root. Invalid text, a NUL in the entity id included, is
 * refused (thrown as UnstorableTextError) only after that decision.
 */
export async function saveEntityAlias(
  ctx: AccessContext,
  input: { entityId: string; entityType: EntityType; canonicalName: string; aliases: string[]; createdBy: string },
): Promise<EntityAlias | null> {
  const decision = await decideRegistryWrite(ctx, "entity_alias", "entityId", input.entityId);
  if (decision === "denied") return null;
  if (decision !== "allowed") throw decision.unstorable;
  const unstorable =
    unstorableText({ entityId: input.entityId }, { wellFormed: true, maxBytes: MAX_ENTITY_ID_BYTES }) ??
    unstorableText({ canonicalName: input.canonicalName }, { wellFormed: true }) ??
    input.aliases.map((alias) => unstorableText({ aliases: alias }, { wellFormed: true })).find(Boolean);
  if (unstorable) throw unstorable;
  return upsertAlias(ctx.orgId, input.entityId, input.entityType, input.canonicalName, input.aliases, input.createdBy);
}

/**
 * Delete alias row `id` on behalf of a person. `denied` is decided before the
 * row is looked up, so a refused caller cannot tell an id that exists from one
 * that does not. An id holding a NUL names no row, so it is `missing` unqueried.
 */
export async function removeEntityAlias(ctx: AccessContext, id: string): Promise<"deleted" | "missing" | "denied"> {
  const decision = await decideRegistryWrite(ctx, "entity_alias", "id", id);
  if (decision === "denied") return "denied";
  if (decision !== "allowed") return "missing";
  const { count } = await db.entityAlias.deleteMany({ where: { id, orgId: ctx.orgId } });
  return count > 0 ? "deleted" : "missing";
}
