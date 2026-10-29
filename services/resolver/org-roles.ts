// The org role registry: which person holds a job title in an org (CEO, CTO,
// founder), so "our CEO" resolves to that person's name before text reaches the
// graph.
//
// A role names a person for all of the org's memory, and saving one also records
// that fact at the org. The rule this file enforces: a person lists, saves or
// removes a role only when check() allows the read or write at the org root, as
// with the alias registry (services/memory/entity-aliases.ts). An org admin role
// alone is not enough, since an admin can lose the org-root grant like any other.
// The functions below that serve a person take that person's AccessContext and
// make the decision themselves, before reading a role, a person or a row id, so a
// caller cannot reach a row without it.
//
// One path takes no decision, by design: the ingest job's resolver reading the
// registry to rewrite text it is about to store. It returns no row to a caller.
import { db } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { parseAccessListQuery } from "@/lib/access-lists";
import { unstorableText } from "@/lib/unstorable-text";
import { ORG_ROLE_LIST_SPEC, SETTINGS_PAGE_SIZE } from "@/lib/settings-lists";
import { anyElementIlike, containsPattern, ilike, readSqlPage, sqlDirection } from "@/services/memory/sql-list-page";
import { decideRegistryWrite } from "@/services/memory/entity-aliases";
import { check, liveMembership, orgRootPath, type AccessContext } from "@/services/access";
import type { KnownEntity } from "./types";

/** Decide a read of the whole registry: at the org root, with one audit row either way. */
async function decideRegistryRead(ctx: AccessContext, target: string) {
  const decision = await check(ctx, { action: "memory.read", scope: orgRootPath(ctx.orgId), target });
  return decision.allowed;
}

/** Every role in the org, as the resolver matches them. For the ingest job only. */
export async function loadOrgRoleEntities(orgId: string): Promise<KnownEntity[]> {
  const roles = await db.orgRole.findMany({
    where: { orgId },
    select: {
      userId: true,
      role: true,
      aliases: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  return roles
    .filter((r) => r.user.name)
    .map((r) => ({
      id: r.user.id,
      type: "user" as const,
      canonicalName: r.user.name!,
      // role title itself + all admin-supplied aliases
      aliases: [r.role, ...r.aliases],
    }));
}

/** An org role as the Settings table shows it. */
export type OrgRoleRow = {
  id: string;
  role: string;
  aliases: string[];
  user: { id: string; name: string | null; email: string };
};

/** The name a role's person shows under, the text the Person sort reads. */
const PERSON = Prisma.sql`COALESCE(u."name", u."email")`;

/**
 * One page of the org's role mappings, as the Settings list asks for it in `params`
 * (lib/settings-lists.ts), searched over the title, the person's name and email and
 * the extra aliases, and ordered by title or person. Null when check() refuses
 * reading the org root, decided before the query is read, so a refused caller gets
 * the same answer whatever it sent; `{ error }` for a query the list does not offer.
 */
export async function readOrgRolePage(ctx: AccessContext, params: URLSearchParams) {
  if (!(await decideRegistryRead(ctx, "org_roles"))) return null;
  const q = parseAccessListQuery(params, ORG_ROLE_LIST_SPEC);
  if (q === null) return { error: "page is required" };
  if ("error" in q) return q;

  const narrowed: Prisma.Sql[] = [];
  if (q.search !== "") {
    const p = containsPattern(q.search);
    narrowed.push(Prisma.sql`(${ilike(Prisma.sql`r."role"`, p)} OR ${ilike(Prisma.sql`u."name"`, p)}
      OR ${ilike(Prisma.sql`u."email"`, p)} OR ${anyElementIlike(Prisma.sql`r."aliases"`, p)})`);
  }
  const dir = sqlDirection(q.order);
  const order =
    q.sort === "person"
      ? Prisma.sql`lower(${PERSON}) ${dir}, lower(r."role") ASC, r."id" ASC`
      : Prisma.sql`lower(r."role") ${dir}, r."id" ${dir}`;

  const { rows, total, count } = await readSqlPage<{
    id: string;
    role: string;
    aliases: string[];
    userId: string;
    userName: string | null;
    userEmail: string;
  }>({
    select: Prisma.sql`r."id", r."role", r."aliases", u."id" AS "userId", u."name" AS "userName", u."email" AS "userEmail"`,
    from: Prisma.sql`"org_roles" r JOIN "users" u ON u."id" = r."userId"`,
    inOrg: Prisma.sql`r."orgId" = ${ctx.orgId}`,
    narrowed,
    order,
    page: q.page,
    pageSize: SETTINGS_PAGE_SIZE,
  });
  return {
    rows: rows.map(
      (r): OrgRoleRow => ({
        id: r.id,
        role: r.role,
        aliases: r.aliases,
        user: { id: r.userId, name: r.userName, email: r.userEmail },
      }),
    ),
    total,
    count,
    page: q.page,
    pageSize: SETTINGS_PAGE_SIZE,
  };
}

/**
 * What saving a role did: refused, refused because a field holds text Postgres cannot
 * take (`error` names the field), refused because the person is not in the org, or saved.
 */
export type SaveOrgRoleOutcome =
  | { outcome: "denied" }
  | { outcome: "unstorable"; error: string }
  | { outcome: "not-a-member" }
  | {
      outcome: "saved";
      row: OrgRoleRow;
      /**
       * The name the graph knew this role's holder by until now, whose facts now
       * belong to the person: the role title itself for a new role, the previous
       * holder's name when the role changed hands, null when the holder is unchanged.
       */
      previousName: string | null;
    };

/**
 * Give role `role` to person `userId`, with extra `aliases`, on behalf of a person.
 * Refused unless check() allows writing at the org root, decided before the person
 * is looked up, so a refused caller cannot learn who is in the org. Text Postgres
 * cannot bind (a NUL in any field, half of a surrogate pair, a role over the key's
 * byte cap) is refused after that decision, before any query, naming the field; a NUL
 * in the role reaches check()'s target, so decideRegistryWrite tells it apart there.
 *
 * The saved row is built from this request's own write and the person it looked up,
 * not read back: a remove or another save of the same role landing in between would
 * otherwise fail the read or answer with the other request's holder.
 */
export async function saveOrgRole(
  ctx: AccessContext,
  input: { role: string; userId: string; aliases: string[] },
): Promise<SaveOrgRoleOutcome> {
  const decision = await decideRegistryWrite(ctx, "org_role", "role", input.role);
  if (decision === "denied") return { outcome: "denied" };
  if (decision !== "allowed") return { outcome: "unstorable", error: decision.unstorable.message };

  // Leave room for the org id and index overhead in the composite B-tree key.
  const unstorable =
    unstorableText({ role: input.role }, { wellFormed: true, maxBytes: 1000 }) ??
    unstorableText({ userId: input.userId }, { wellFormed: true }) ??
    input.aliases.map((alias) => unstorableText({ aliases: alias }, { wellFormed: true })).find(Boolean);
  if (unstorable) return { outcome: "unstorable", error: unstorable.message };

  const membership = await liveMembership(ctx.orgId, input.userId);
  const user =
    membership &&
    (await db.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true, email: true } }));
  if (!user) return { outcome: "not-a-member" };

  const where = { orgId_role: { orgId: ctx.orgId, role: input.role } };
  const existing = await db.orgRole.findUnique({ where, select: { userId: true, user: { select: { name: true } } } });
  // No relation in the upsert's own select, so Prisma runs it as one INSERT … ON
  // CONFLICT; with one, two first saves of a role race and one fails on the unique key.
  try {
    const saved = await db.orgRole.upsert({
      where,
      create: { orgId: ctx.orgId, role: input.role, userId: input.userId, aliases: input.aliases },
      update: { userId: input.userId, aliases: input.aliases },
      select: { id: true, role: true, aliases: true },
    });

    const previousName = !existing ? input.role : existing.userId !== input.userId ? existing.user.name : null;
    return { outcome: "saved", row: { ...saved, user }, previousName };
  } catch (error) {
    // Only a vanished holder is a missing person; the org FK and unidentified
    // integrity errors must still propagate. Prisma's pg adapter names the FK here.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      const meta = error.meta as { driverAdapterError?: { cause?: { constraint?: { index?: unknown } } } } | undefined;
      if (meta?.driverAdapterError?.cause?.constraint?.index === "org_roles_userId_fkey") {
        return { outcome: "not-a-member" };
      }
    }
    throw error;
  }
}

/**
 * Delete role row `id` on behalf of a person. `denied` is decided before the row is
 * looked up, so a refused caller cannot tell an id that exists from one that does
 * not. The delete is scoped to the org, so another org's row and a row already
 * deleted both answer `missing`, as does an id holding a NUL, unqueried.
 */
export async function removeOrgRole(ctx: AccessContext, id: string): Promise<"deleted" | "missing" | "denied"> {
  const decision = await decideRegistryWrite(ctx, "org_role", "id", id);
  if (decision === "denied") return "denied";
  if (decision !== "allowed") return "missing";
  const { count } = await db.orgRole.deleteMany({ where: { id, orgId: ctx.orgId } });
  return count > 0 ? "deleted" : "missing";
}
