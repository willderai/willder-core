// The deletion job: at the end of the 7 days, clear every store an org has and write
// its receipt.
//
// The rules it enforces:
//
// - Nothing of another org changes. People whose row lives in the org but who belong to
//   another org move there first, and the job refuses to go on while any other org's row
//   still references a row of this one, since deleting it would cascade into that org.
//   Someone another org's rows reference who belongs to no other org (they left it) is
//   moved there too, so the org's own rows can go, and then deleted, as their removal
//   would have deleted them had this org not been the one they last used.
// - Nothing is left. The database rows (the org row's cascade reaches every table with
//   an `orgId`), the graph, the raw files and final export in Blob storage, and the job
//   finishes only when a fresh count of each finds nothing of the org. The org's Clerk
//   organization is deleted too, so it cannot be reopened as a new, empty org.
// - It can die anywhere and run again. Each step is safe to repeat; what must be read
//   before anything is removed (the counts the receipt reports) is stored on the
//   deletion row the first time, and a run that fails records why and leaves the
//   deletion running for the next.
import { db } from "@/lib/db";
import { Prisma, type OrgDeletion } from "@/lib/generated/prisma/client";
import { deletePrivateBlob, listPrivateBlobs } from "@/lib/blob-storage";
import { graphitiStore } from "@/services/memory/store";
import { deleteUsersWithoutMembership, lockOrgDeletion, pruneAdminDepartures } from "@/services/access";
import { exportPrefix, produceFinalExport, discardFinalExport } from "./final-export";
import { fixRecipientsBeforeClearing } from "./request";
import { deleteClerkOrganization } from "./clerk-org";

/** How long after a deletion its copies in backups are gone, at the longest. Every
 * store's backup retention must stay within it (docs/legal/dpa.md, section 10). */
export const BACKUP_AGE_OUT_DAYS = 30;
const DAY_MS = 86_400_000;

/** The Blob prefixes an org's files live under: uploads, connector syncs, the final export. */
export function blobPrefixes(orgId: string): string[] {
  return [`memory/${orgId}/`, `sources/${orgId}/`, exportPrefix(orgId)];
}

/** Counts taken before anything is removed, kept on the deletion so a resumed run reports them. */
interface Counts {
  /** Rows per table, the org row itself included. */
  database: Record<string, number>;
  graph: { nodes: number; relationships: number };
  files: { count: number; bytes: number };
  finalExport: boolean;
}

interface Progress {
  counts?: Counts;
  /** users.id of people moved to another org that references them. */
  moved?: string[];
  /** users.id of the org's members whose row lives in another org, read before the org row goes. */
  membersHomedElsewhere?: string[];
}

/** What the owner is told was removed, and what is kept. */
export interface DeletionReceipt {
  org: { id: string; name: string };
  trigger: OrgDeletion["trigger"];
  requestedAt: string;
  effectiveAt: string;
  completedAt: string;
  removed: Counts;
  /** What stays: this receipt, which holds no memory content. */
  kept: string;
  /** By when every backup copy of the org is gone. */
  backupsAgeOutBy: string;
}

const KEPT =
  "This receipt: the organization's name and id, the Clerk ids of the people who may read it, " +
  "when the deletion was asked for and carried out, and these counts. No memory content, file or audit row is kept.";

/** One foreign key of one column: `child.column` references `parent.ref`. */
interface ForeignKey {
  child: string;
  column: string;
  parent: string;
  ref: string;
}

/** A trusted catalog identifier, quoted for SQL. */
const ident = (name: string) => Prisma.raw(`"${name.replace(/"/g, '""')}"`);

/** Every table with an `orgId` column, the receipts excluded. */
async function orgScopedTables(): Promise<string[]> {
  const rows = await db.$queryRaw<{ table_name: string }[]>`
    SELECT c.table_name::text AS table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND c.column_name = 'orgId'
      AND t.table_type = 'BASE TABLE' AND c.table_name <> 'org_deletions'
    ORDER BY 1`;
  return rows.map((r) => r.table_name);
}

/** Every single-column foreign key in the schema. */
async function foreignKeys(): Promise<ForeignKey[]> {
  return db.$queryRaw<ForeignKey[]>`
    SELECT child.relname::text AS child, ca.attname::text AS column,
           parent.relname::text AS parent, pa.attname::text AS ref
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
    WHERE con.contype = 'f' AND cardinality(con.conkey) = 1
      AND child.relnamespace = to_regnamespace(current_schema())
    ORDER BY 1, 2`;
}

async function count(query: Prisma.Sql): Promise<number> {
  const [row] = await db.$queryRaw<{ n: bigint }[]>(query);
  return Number(row.n);
}

/**
 * Move each person whose row lives in `orgId` but whom another org's rows reference (a
 * membership, a role, an owned account, a connection) to that org, so deleting this
 * one does not delete them there. A live membership is preferred, the most recently
 * asserted first. A person no other org can take without two rows sharing an email
 * stops the job. A person moved who belongs to no org (another org's rows still
 * reference them: an ended membership, an owned account) is deleted once the org row
 * is gone.
 */
async function moveMembersOfOtherOrgs(orgId: string, keys: ForeignKey[], scoped: Set<string>): Promise<string[]> {
  const homed = await db.user.findMany({ where: { orgId }, select: { id: true, email: true }, orderBy: { id: "asc" } });
  const userKeys = keys.filter((k) => k.parent === "users" && scoped.has(k.child));
  const moved: string[] = [];
  for (const user of homed) {
    const live = await db.orgMembership.findMany({
      where: { userId: user.id, removedAt: null, orgId: { not: orgId } },
      orderBy: [{ assertedAt: "desc" }, { orgId: "asc" }],
      select: { orgId: true },
    });
    const referencing = new Set<string>();
    for (const key of userKeys) {
      const rows = await db.$queryRaw<{ orgId: string }[]>`
        SELECT DISTINCT "orgId" FROM ${ident(key.child)} WHERE ${ident(key.column)} = ${user.id} AND "orgId" <> ${orgId}`;
      for (const row of rows) referencing.add(row.orgId);
    }
    if (referencing.size === 0 && live.length === 0) continue;
    const candidates = [...new Set([...live.map((m) => m.orgId), ...[...referencing].sort()])];
    let target: string | null = null;
    for (const candidate of candidates) {
      const clash = await db.user.findFirst({
        where: { orgId: candidate, email: user.email, id: { not: user.id } },
        select: { id: true },
      });
      if (!clash) {
        target = candidate;
        break;
      }
    }
    if (target === null) {
      throw new Error(
        `user ${user.id} belongs to other orgs but each has another account with the same email; move them by hand`,
      );
    }
    const membership = await db.orgMembership.findUnique({
      where: { orgId_userId: { orgId: target, userId: user.id } },
      select: { role: true },
    });
    // Under the target's deletion lock, as a removal re-homes a row: a cancel of the
    // target's deletion then either sees the person there and deletes them with the rows
    // it keeps, or has committed, and the person is deleted after this org's row as a
    // person who belongs to no org.
    await db.$transaction(async (tx) => {
      await lockOrgDeletion(tx, target);
      await tx.user.update({
        where: { id: user.id },
        data: { orgId: target, ...(membership ? { role: membership.role } : {}) },
      });
    });
    moved.push(user.id);
  }
  return moved;
}

/**
 * Refuse while any row of another org references a row of `orgId`: deleting the org
 * would delete or blank that row through its foreign key. No such reference is ever
 * written on purpose, so finding one is a defect to look at, not to delete through.
 */
async function assertNoCrossOrgReferences(orgId: string, keys: ForeignKey[], scoped: Set<string>): Promise<void> {
  for (const key of keys) {
    if (key.parent === "orgs" || !scoped.has(key.child) || !scoped.has(key.parent)) continue;
    const n = await count(Prisma.sql`
      SELECT count(*)::bigint AS n FROM ${ident(key.child)} c
      JOIN ${ident(key.parent)} p ON p.${ident(key.ref)} = c.${ident(key.column)}
      WHERE p."orgId" = ${orgId} AND c."orgId" IS DISTINCT FROM ${orgId}`);
    if (n > 0) {
      throw new Error(
        `${n} row(s) of ${key.child} in another org reference ${key.parent} rows of this org; refusing to delete through them`,
      );
    }
  }
}

/** Rows of the org per table: tables with `orgId`, then tables reached only through a parent that has one. */
async function databaseCounts(orgId: string, keys: ForeignKey[], scoped: Set<string>): Promise<Record<string, number>> {
  const counts: Record<string, number> = {
    orgs: await count(Prisma.sql`SELECT count(*)::bigint AS n FROM orgs WHERE id = ${orgId}`),
  };
  for (const table of [...scoped].sort()) {
    const n = await count(Prisma.sql`SELECT count(*)::bigint AS n FROM ${ident(table)} WHERE "orgId" = ${orgId}`);
    if (n > 0) counts[table] = n;
  }
  for (const key of keys) {
    if (scoped.has(key.child) || !scoped.has(key.parent) || key.child === "org_deletions") continue;
    const n = await count(Prisma.sql`
      SELECT count(*)::bigint AS n FROM ${ident(key.child)} c
      JOIN ${ident(key.parent)} p ON p.${ident(key.ref)} = c.${ident(key.column)}
      WHERE p."orgId" = ${orgId}`);
    if (n > 0) counts[key.child] = (counts[key.child] ?? 0) + n;
  }
  return counts;
}

/** The org's blobs: every one under its prefixes, plus each upload's own URL. */
async function orgBlobs(orgId: string): Promise<Map<string, number>> {
  const blobs = new Map<string, number>();
  for (const prefix of blobPrefixes(orgId)) {
    for (const blob of await listPrivateBlobs(prefix)) blobs.set(blob.url, blob.size);
  }
  const uploads = await db.uploadedFile.findMany({ where: { orgId }, select: { blobUrl: true } });
  for (const { blobUrl } of uploads) if (!blobs.has(blobUrl)) blobs.set(blobUrl, 0);
  return blobs;
}

/** The people whose `users` row the org's cascade or {@link deleteOrgRow} may delete: homed in the org, or holding a membership of it. */
async function peopleOf(tx: Prisma.TransactionClient, orgId: string): Promise<{ id: string; homedHere: boolean }[]> {
  return tx.$queryRaw<{ id: string; homedHere: boolean }[]>`
    SELECT u."id", u."orgId" = ${orgId} AS "homedHere" FROM "users" u
    WHERE u."orgId" = ${orgId}
       OR EXISTS (SELECT 1 FROM "org_memberships" m WHERE m."userId" = u."id" AND m."orgId" = ${orgId})
    ORDER BY u."id"`;
}

/** How many times {@link deleteOrgRow} reads the org's people again when someone joined it meanwhile. */
const PEOPLE_READS = 3;

/**
 * Delete the org row, and with its cascade every row of the org, in one transaction that
 * first locks, in id order, the `users` row of everyone the cascade or the job may delete,
 * and then the org row. A removal locks a person before their memberships, so the two
 * wait for each other instead of deadlocking. Under the org row's lock no membership of
 * the org and no `users` row homed in it can be written, so the people are read again:
 * anyone who joined in between means the transaction is rolled back and the people read
 * again. A person homed in the org with a membership of another org (re-homed here since
 * the move, by a signed-in request) stops the run, and the next one moves them again.
 * The org's members homed elsewhere are recorded on the deletion in the same transaction,
 * so a run resumed after the row went still knows whom the cascade may have left with no org.
 */
async function deleteOrgRow(orgId: string, progress: Progress, deletionId: string): Promise<void> {
  for (let read = 1; read <= PEOPLE_READS; read += 1) {
    const deleted = await db.$transaction(
      async (tx) => {
        const people = await peopleOf(tx, orgId);
        const ids = people.map((p) => p.id);
        await tx.$queryRaw`SELECT 1 FROM "users" WHERE "id" = ANY(${ids}) ORDER BY "id" FOR UPDATE`;
        await tx.$queryRaw`SELECT 1 FROM "orgs" WHERE "id" = ${orgId} FOR UPDATE`;
        const locked = new Set(ids);
        const now = await peopleOf(tx, orgId);
        if (now.some((p) => !locked.has(p.id))) return false;
        const strays = await tx.$queryRaw<{ id: string }[]>`
          SELECT u."id" FROM "users" u
          WHERE u."orgId" = ${orgId}
            AND EXISTS (SELECT 1 FROM "org_memberships" m WHERE m."userId" = u."id" AND m."orgId" <> ${orgId})
          ORDER BY u."id"`;
        if (strays.length > 0) {
          throw new Error(
            `${strays.length} person(s) homed in this org since the move also belong to another org; the next run moves them`,
          );
        }
        const elsewhere = now.filter((p) => !p.homedHere).map((p) => p.id);
        if (elsewhere.length > 0) {
          progress.membersHomedElsewhere = [
            ...new Set([...(progress.membersHomedElsewhere ?? []), ...elsewhere]),
          ].sort();
          await tx.orgDeletion.update({
            where: { id: deletionId },
            data: { progress: progress as Prisma.InputJsonObject },
          });
        }
        await tx.org.deleteMany({ where: { id: orgId } });
        return true;
      },
      // The cascade removes every row of the org; it is not a five-second statement.
      { timeout: ORG_ROW_DELETE_TIMEOUT_MS },
    );
    if (deleted) return;
  }
  throw new Error(
    `people kept joining the org while its row was being deleted, ${PEOPLE_READS} times; the next run tries again`,
  );
}

/** The longest the transaction that deletes the org row and its cascade may run. */
const ORG_ROW_DELETE_TIMEOUT_MS = 10 * 60_000;

/** Whatever of the org a store still holds, by store; empty when nothing is left. */
async function residue(orgId: string, scoped: Set<string>): Promise<string[]> {
  const left: string[] = [];
  if ((await count(Prisma.sql`SELECT count(*)::bigint AS n FROM orgs WHERE id = ${orgId}`)) > 0) left.push("orgs: 1");
  for (const table of [...scoped].sort()) {
    const n = await count(Prisma.sql`SELECT count(*)::bigint AS n FROM ${ident(table)} WHERE "orgId" = ${orgId}`);
    if (n > 0) left.push(`${table}: ${n}`);
  }
  const graph = await graphitiStore.orgResidue(orgId);
  if (graph.nodes > 0 || graph.relationships > 0)
    left.push(`graph: ${graph.nodes} nodes, ${graph.relationships} relationships`);
  const files = (await Promise.all(blobPrefixes(orgId).map(listPrivateBlobs))).flat();
  if (files.length > 0) left.push(`blob storage: ${files.length} files`);
  return left;
}

/**
 * Run one due deletion to the end, or resume one a previous run left part-way. Returns
 * the finished deletion, or null when it is not due, was cancelled, or is already done.
 */
export async function runOrgDeletion(deletionId: string, now: Date = new Date()): Promise<OrgDeletion | null> {
  const claimed = await db.orgDeletion.updateMany({
    where: {
      id: deletionId,
      OR: [{ status: "pending", effectiveAt: { lte: now } }, { status: "deleting" }],
    },
    data: { status: "deleting", attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return null;
  const deletion = await db.orgDeletion.findUniqueOrThrow({ where: { id: deletionId } });
  if (deletion.startedAt === null)
    await db.orgDeletion.update({ where: { id: deletion.id }, data: { startedAt: now } });
  const { orgId } = deletion;
  const progress = (deletion.progress ?? {}) as Progress;

  try {
    const [tables, keys] = await Promise.all([orgScopedTables(), foreignKeys()]);
    const scoped = new Set(tables);

    // Before anything is counted or removed: the people another org still needs.
    const moved = await moveMembersOfOtherOrgs(orgId, keys, scoped);
    if (moved.length > 0) progress.moved = [...new Set([...(progress.moved ?? []), ...moved])];
    await assertNoCrossOrgReferences(orgId, keys, scoped);

    if (!progress.counts) {
      const blobs = await orgBlobs(orgId);
      progress.counts = {
        database: await databaseCounts(orgId, keys, scoped),
        graph: await graphitiStore.orgResidue(orgId),
        files: { count: blobs.size, bytes: [...blobs.values()].reduce((a, b) => a + b, 0) },
        finalExport: deletion.exportUrl !== null,
      };
    }
    await db.orgDeletion.update({ where: { id: deletion.id }, data: { progress: progress as Prisma.InputJsonObject } });
    // Who reads the receipt is settled while the memberships it is read from still exist.
    await fixRecipientsBeforeClearing(deletion.id, now);

    await graphitiStore.purgeOrg(orgId);
    for (const url of (await orgBlobs(orgId)).keys()) await deletePrivateBlob(url);
    // The Clerk organization goes before the org row, so no one can sign in to it in
    // between and be given a new org, and while the row still names it: a run resumed
    // after the row went has done this already. A deletion Clerk started or joined has
    // no Clerk organization left.
    const clerkOrg = await db.org.findUnique({ where: { id: orgId }, select: { clerkOrgId: true } });
    if (clerkOrg?.clerkOrgId && deletion.clerkEventId === null) await deleteClerkOrganization(clerkOrg.clerkOrgId);
    await deleteOrgRow(orgId, progress, deletion.id);
    // Of the people moved, those who belong to no org were moved only so the org's rows
    // could go, and a member homed elsewhere whose last other membership ended while the
    // job ran kept their row for it (recordMembershipRemoved): with the org gone, each row
    // goes as a removal would take it, with the departures it keeps.
    const leftIds = [...new Set([...(progress.moved ?? []), ...(progress.membersHomedElsewhere ?? [])])].sort();
    if (leftIds.length > 0)
      await db.$transaction((tx) => deleteUsersWithoutMembership(tx, { id: { in: leftIds } }, now));

    const left = await residue(orgId, scoped);
    if (left.length > 0) throw new Error(`still holds ${left.join("; ")}`);
    // The org's cancelled deletions are its records too (who asked, who cancelled), and
    // go with it; only this receipt stays.
    await db.orgDeletion.deleteMany({ where: { orgId, status: "cancelled" } });

    const receipt: DeletionReceipt = {
      org: { id: orgId, name: deletion.orgName },
      trigger: deletion.trigger,
      requestedAt: deletion.requestedAt.toISOString(),
      effectiveAt: deletion.effectiveAt.toISOString(),
      completedAt: now.toISOString(),
      removed: progress.counts,
      kept: KEPT,
      backupsAgeOutBy: new Date(now.getTime() + BACKUP_AGE_OUT_DAYS * DAY_MS).toISOString(),
    };
    // The row is the receipt from now on, and keeps only what the DPA says a receipt
    // holds (section 10): the org's name and id, the dates, the counts, the readers'
    // Clerk ids and the Clerk event id that makes a redelivery start nothing. Who asked,
    // the revoked token ids, the people moved and any error text go.
    await db.orgDeletion.updateMany({
      where: { id: deletion.id, status: "deleting" },
      data: {
        status: "deleted",
        completedAt: now,
        requestedBy: null,
        revokedCapabilityIds: [],
        progress: {},
        exportUrl: null,
        exportBytes: null,
        exportError: null,
        lastError: null,
        receipt: receipt as unknown as Prisma.InputJsonObject,
      },
    });
    return db.orgDeletion.findUnique({ where: { id: deletion.id } });
  } catch (error) {
    await db.orgDeletion.update({
      where: { id: deletion.id },
      data: {
        lastError: error instanceof Error ? error.message : String(error),
        progress: progress as Prisma.InputJsonObject,
      },
    });
    throw error;
  }
}

/** What one pass of the scheduled job did. */
export interface SweepResult {
  deleted: string[];
  failed: { id: string; error: string }[];
  exportsMade: string[];
  /** Cancelled deletions whose export copies this pass deleted. */
  exportsDiscarded: string[];
  /** Finished deletions whose org had a file stored after it was cleared, deleted this pass. */
  lateFilesDeleted: string[];
  /** Admin departures past their three days, deleted this pass. */
  departuresPruned: number;
}

/** How long after a cancel or a finished deletion each pass looks again for a late copy. */
const LATE_COPY_WINDOW_MS = DAY_MS;

/**
 * The scheduled job's one pass: run every due or unfinished deletion, make any final
 * export a pending deletion still lacks, and delete what a run stored too late: an
 * export finished after its deletion was cancelled, or a file stored after its org was
 * cleared, by a run that died before deleting its own copy; then prune admin departures
 * past their three days. One deletion failing is recorded on it and logged, and does
 * not stop the others.
 */
export async function sweepOrgDeletions(now: Date = new Date()): Promise<SweepResult> {
  const result: SweepResult = {
    deleted: [],
    failed: [],
    exportsMade: [],
    exportsDiscarded: [],
    lateFilesDeleted: [],
    departuresPruned: 0,
  };
  const fail = (id: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[org-deletion] ${id}: ${message}`);
    result.failed.push({ id, error: message });
  };

  const due = await db.orgDeletion.findMany({
    where: { OR: [{ status: "pending", effectiveAt: { lte: now } }, { status: "deleting" }] },
    orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  for (const { id } of due) {
    try {
      if (await runOrgDeletion(id, now)) result.deleted.push(id);
    } catch (error) {
      fail(id, error);
    }
  }

  const unexported = await db.orgDeletion.findMany({
    where: { status: "pending", exportUrl: null, effectiveAt: { gt: now } },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  for (const { id } of unexported) {
    try {
      await produceFinalExport(id, now);
      result.exportsMade.push(id);
    } catch (error) {
      fail(id, error);
    }
  }

  const since = new Date(now.getTime() - LATE_COPY_WINDOW_MS);
  const cancelled = await db.orgDeletion.findMany({
    where: { status: "cancelled", OR: [{ cancelledAt: { gte: since } }, { exportUrl: { not: null } }] },
    select: { id: true, orgId: true },
  });
  for (const deletion of cancelled) {
    try {
      if ((await discardFinalExport(deletion)) > 0) result.exportsDiscarded.push(deletion.id);
    } catch (error) {
      fail(deletion.id, error);
    }
  }

  const finished = await db.orgDeletion.findMany({
    where: { status: "deleted", completedAt: { gte: since } },
    select: { id: true, orgId: true },
  });
  for (const deletion of finished) {
    try {
      // Only while the org is still gone: an id is never reused, but this never reaches
      // the files of an org that exists.
      if (await db.org.findUnique({ where: { id: deletion.orgId }, select: { id: true } })) continue;
      const late = (await Promise.all(blobPrefixes(deletion.orgId).map(listPrivateBlobs))).flat();
      for (const blob of late) await deletePrivateBlob(blob.url);
      if (late.length > 0) result.lateFilesDeleted.push(deletion.id);
    } catch (error) {
      fail(deletion.id, error);
    }
  }

  result.departuresPruned = await pruneAdminDepartures(now);
  return result;
}
