/**
 * Re-applying an org's past person erasures after a database restore.
 *
 * The rule this file enforces: after a backup taken before an erasure is
 * restored, every contact and vector chunk the erasure removed and the restore
 * put back is removed again, and nothing written after that erasure is touched.
 * "Removed and put back" is decided by the suppression list
 * (services/memory/erasure-suppression.ts): a row that names an erased person
 * and was written at or before that erasure is an old copy. A contact is theirs
 * by its whole address, or, without one, by its id being one the erasure removed;
 * a chunk by its text or the name it is filed under.
 *
 * A restored contact still holds the person's address and name in plain text, so
 * it is erased again through `erasePerson`, which reaches the graph and every
 * other store with those values and records its own request and audit rows. A
 * restored chunk with no contact left to name the person is deleted here
 * directly, when its text names them, it is filed under their name, or it is a
 * version the erasure removed by id, such as a correction of a fact about them
 * (services/memory/erasure-lineage.ts). A chunk that is a passage of an upload is judged as
 * written when its file was uploaded (export-erasure.ts, passageWrittenAt), and its upload
 * goes with it, raw file and all, as the erasure takes it; so does an upload whose filename
 * names them. That also finds a file uploaded before an erasure whose passages were stored
 * after it, by a file-ingest job that judged them by their own time. A restored rule is redacted again the same way: when
 * its subject or text names them, or it is a rule an erasure redacted, such as a version
 * written in place of one that named them (services/memory/erasure-rules.ts). A restored
 * brief is deleted again when its text or the text of a fact it cited names them, or it
 * cited a version the erasure removed; a restored working note when its task or body
 * names them.
 *
 * Except when the person was added again after their erasure: a contact created
 * after it shares the restored one's address or name. The full erasure matches by
 * value, not by time, so it would remove the re-added person too. Then only the
 * restored contact row is deleted, and the passes below remove the restored chunks,
 * briefs and working notes by time; what the backup put back in ledger snapshots or
 * change-feed summaries for that person is left for the operator. Graph content restored
 * without a contact cannot be found this way:
 * the suppression list keeps digests, not the values the graph erasure needs
 * (docs/consent-deletion-suite.md, "Bar 3: after a backup restore").
 *
 * Only a caller with `access.manage` on the org root may run it. A run that completes marks
 * every entry the list held when it started as applied (`markApplied`); one that stops part-way
 * marks only what the erasures it ran finished. Until every entry is applied, the org reads as
 * not applied, and memory_query's value check makes no claim in it
 * (services/memory/readable-values.ts). A restore's copy-back of the list also marks the org
 * due (erasure_reapply_due), and check() refuses the org's reads and writes until a run leaves
 * its whole list applied and ends that row. `completeRestore` runs the pass for every such org
 * on a restored database, from the restore-completion job or scripts/complete-restore.ts, and
 * says which are applied.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { sqlUtcNow } from "@/lib/sql-utc-now";
import { AccessDeniedError, check, type AccessContext } from "@/services/access";
import { orgRootPath } from "@/services/access/org-root";
import { redactRules } from "./erasure-rules";
import { foldName } from "./person-name-characters";
import {
  endReapplyDue,
  erasuresApplied,
  listEntriesAsOf,
  loadErasedContentFilter,
  markApplied,
  orgsWithReapplyDue,
  reapplyDue,
  type ErasedContentFilter,
} from "./erasure-suppression";
import { erasureCovers, passageWrittenAt } from "./export-erasure";
import { deleteRemovedUploads } from "./uploads";
import { clearWorkingNoteTouches, deleteBriefs, deleteWorkingNotes, erasePerson, pathsAsText } from "./person-erasure";

/** What one run removed. */
export interface ReapplyResult {
  /** Restored contacts erased again, one erasure request each. */
  contactsErased: number;
  /** The `person_erasure:<requestId>` requests those erasures recorded. */
  requestIds: string[];
  /**
   * Restored contacts deleted by row alone, because the same person was added again
   * after their erasure and a full erasure would remove that too.
   */
  reAddedContactsRemoved: number;
  /** Restored chunks removed, beyond those the contact erasures removed. */
  chunksRemoved: number;
  /** Uploads removed, raw file and all, beyond those the contact erasures removed. */
  uploadsRemoved: number;
  /** Restored rules redacted again, beyond those the contact erasures redacted. */
  rulesRedacted: number;
  /** Restored briefs deleted again, beyond those the contact erasures deleted. */
  briefsRemoved: number;
  /** Restored working notes deleted again, beyond those the contact erasures deleted. */
  notesRemoved: number;
}

/** Chunks, briefs and working notes are read in pages of this many, so a large org is never loaded at once. */
const CHUNK_PAGE = 500;

/**
 * Remove every restored copy of a person erased from `ctx.orgId`. Idempotent: a
 * second run finds nothing and returns zeros. Throws AccessDeniedError without
 * `access.manage` on the org root, before anything is read.
 */
export async function reapplyErasures(ctx: AccessContext): Promise<ReapplyResult> {
  const decision = await check(ctx, { action: "access.manage", target: "person_erasure:reapply" });
  if (!decision.allowed) throw new AccessDeniedError(decision);

  // What this run covers: the list as it stands before the filter is loaded from it, as of
  // now, so an entry another erasure lists again while this runs is left for that erasure to
  // mark (markApplied, asOf). Its own id, so a later run's entries are never taken for this one's.
  const run = `reapply:${randomUUID()}`;
  const { entries: covered, asOf: listedAt } = await listEntriesAsOf(ctx.orgId);
  const erased = await loadErasedContentFilter(ctx.orgId);

  const contacts = await db.contact.findMany({
    where: { orgId: ctx.orgId },
    select: { id: true, name: true, email: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  // Names and addresses compared folded, as the erasure compares them (foldName).
  const nameKey = (name: string) => foldName(name.trim().replace(/\s+/g, " "));
  const emailKey = (email: string | null) => (email?.trim() ? foldName(email.trim()) : null);
  // A contact with an address is the erased person's only when the address is theirs: the
  // erasure linked contacts by address, so one with the same name and another address is
  // someone else. A contact without one is theirs only when it is a row the erasure
  // removed, by its id: the erasure never linked contacts by name, so another contact
  // with their name and no address is someone else too.
  // The address goes to the filter as stored, not folded here: the filter folds it as the erasure
  // folds now and as it folded when older digests were recorded (erasure-suppression.ts), and
  // folding it first would lose the older form ("ALİ.KIM@" was once recorded as "ali\u0307.kim@").
  const restored = (c: (typeof contacts)[number]) => {
    const email = c.email?.trim();
    return email ? erased.byRecordName(email, c.createdAt) : erased.byContactId(c.id, c.createdAt);
  };
  // A contact that names an erased person but was created after that erasure is a deliberate re-add.
  const reAdded = (c: (typeof contacts)[number]) =>
    contacts.some(
      (other) =>
        other.id !== c.id &&
        !restored(other) &&
        ((emailKey(other.email) !== null && emailKey(other.email) === emailKey(c.email)) ||
          nameKey(other.name) === nameKey(c.name)),
    );

  const requestIds: string[] = [];
  let reAddedContactsRemoved = 0;
  for (const contact of contacts) {
    if (!restored(contact)) continue;
    if (reAdded(contact)) {
      reAddedContactsRemoved += (await db.contact.deleteMany({ where: { orgId: ctx.orgId, id: contact.id } })).count;
      continue;
    }
    // An earlier erasure in this loop may already have removed this row as a duplicate of the same person.
    if (!(await db.contact.findFirst({ where: { orgId: ctx.orgId, id: contact.id }, select: { id: true } }))) continue;
    requestIds.push((await erasePerson(ctx, { contactId: contact.id })).requestId);
  }

  let uploadsRemoved = await markUploadsNamedInFilename(ctx.orgId, erased);
  let chunksRemoved = 0;
  for (let after = ""; ; ) {
    type Chunk = {
      id: string;
      content: string;
      entityName: string | null;
      createdAt: Date;
      uploadId: string | null;
      uploadedAt: Date | null;
    };
    const page = await db.$queryRaw<Chunk[]>`
      SELECT c.id, c.content, c."entityName", c."createdAt", c."uploadId", u."createdAt" AS "uploadedAt"
      FROM memory_chunks c LEFT JOIN uploaded_files u ON u.id = c."uploadId" AND u."orgId" = c."orgId"
      WHERE c."orgId" = ${ctx.orgId} AND c.id > ${after}
      ORDER BY c.id
      LIMIT ${CHUNK_PAGE}
    `;
    if (page.length === 0) break;
    // A passage of an upload is judged as written when its file was uploaded.
    const stale = page.filter((c) =>
      erased(c.content, passageWrittenAt(c.createdAt, c.uploadedAt), c.entityName, c.id),
    );
    if (stale.length > 0) {
      const uploadIds = [...new Set(stale.flatMap((c) => (c.uploadId === null ? [] : [c.uploadId])))];
      // The upload first, in the same transaction, as the erasure marks it: its raw file
      // cannot be redacted, so it goes whole; its passages that name no one erased stay.
      const [marked, removed] = await db.$transaction([
        db.$executeRaw`
          UPDATE uploaded_files SET "removedAt" = ${sqlUtcNow}
          WHERE "orgId" = ${ctx.orgId} AND id = ANY (${uploadIds}::text[]) AND "removedAt" IS NULL
        `,
        db.$executeRaw`
          DELETE FROM memory_chunks WHERE "orgId" = ${ctx.orgId} AND id = ANY (${stale.map((c) => c.id)}::text[])
        `,
      ]);
      uploadsRemoved += marked;
      chunksRemoved += removed;
    }
    after = page[page.length - 1]!.id;
  }
  await deleteRemovedUploads(ctx.orgId);

  const rules = await db.convention.findMany({
    where: { orgId: ctx.orgId, OR: [{ subject: { not: "" } }, { text: { not: "" } }, { retiredAt: null }] },
    select: { id: true, subject: true, text: true, createdAt: true },
  });
  const staleRules = rules
    .filter((r) => erased(`${r.subject}\n${r.text}`, r.createdAt, r.subject) || erased.byRuleId(r.id, r.createdAt))
    .map((r) => r.id);
  const { rules: rulesRedacted } = await db.$transaction((tx) => redactRules(tx, ctx, run, staleRules));

  const staleBriefs = await restoredBriefs(ctx.orgId, erased);
  const { stale: staleNotes, touchesNaming } = await restoredNotes(ctx.orgId, erased);
  const { briefsRemoved, notesRemoved } = await db.$transaction(async (tx) => {
    // Notes first, before a brief's change event takes the org's change-feed lock (deleteWorkingNotes).
    // Each note as it read when judged: one its agent renewed since, with new text, stays.
    const notesRemoved = await deleteWorkingNotes(
      tx,
      ctx,
      Prisma.sql`(id, task, body) IN (SELECT * FROM unnest(${staleNotes.map((n) => n.id)}::text[], ${staleNotes.map((n) => n.task)}::text[], ${staleNotes.map((n) => n.body)}::text[]))`,
    );
    // A kept claim whose restored touches name an erased person keeps the claim, touches emptied.
    await clearWorkingNoteTouches(tx, ctx, Prisma.sql`id = ANY (${touchesNaming}::text[])`);
    const briefsRemoved = await deleteBriefs(tx, ctx, staleBriefs, Prisma.sql`true`);
    // Only now, with every pass above done, the last one in this transaction: a run that
    // stopped part-way leaves its entries unapplied, so the next run looks at them again.
    await markApplied(tx, ctx.orgId, run, { requestIds: [run], entries: covered, asOf: listedAt });
    // And with them, the org's due re-apply, when its whole list now reads as applied.
    await endReapplyDue(tx, ctx.orgId);
    return { notesRemoved, briefsRemoved };
  });

  return {
    contactsErased: requestIds.length,
    requestIds,
    reAddedContactsRemoved,
    chunksRemoved,
    uploadsRemoved,
    rulesRedacted,
    briefsRemoved,
    notesRemoved,
  };
}

/**
 * The org's briefs a restore put back that name an erased person: written at or before the
 * erasure, with text that names them, or citing a fact whose text named them or a version the
 * erasure removed. The text judged is what the erasure itself matches (person-erasure.ts,
 * briefNamesPerson).
 */
async function restoredBriefs(orgId: string, erased: ErasedContentFilter): Promise<string[]> {
  const stale: string[] = [];
  for (let after = ""; ; ) {
    const page = await db.$queryRaw<
      { id: string; text: string; createdAt: Date; citations: { factId: string; factText: string }[] }[]
    >`
      SELECT b.id, b."createdAt",
             concat_ws(chr(10), b.title, b.summary, b.sections::text, b.diagram, b."granteeName", b."granteeRole",
                       b.milestones::text, b.charts::text, b.decisions::text) AS text,
             COALESCE((SELECT json_agg(json_build_object('factId', c."factId", 'factText', c."factText"))
                       FROM brief_citations c WHERE c."briefId" = b.id), '[]'::json) AS citations
      FROM briefs b WHERE b."orgId" = ${orgId} AND b.id > ${after}
      ORDER BY b.id
      LIMIT ${CHUNK_PAGE}
    `;
    if (page.length === 0) return stale;
    for (const b of page) {
      const cites = b.citations.some((c) => erased(c.factText, b.createdAt) || erased("", b.createdAt, null, c.factId));
      if (erased(b.text, b.createdAt) || cites) stale.push(b.id);
    }
    after = page[page.length - 1]!.id;
  }
}

/**
 * The org's working notes a restore put back whose task or body names an erased person, as they
 * read now, and the other notes whose touches name one: those keep the note, touches emptied.
 */
async function restoredNotes(
  orgId: string,
  erased: ErasedContentFilter,
): Promise<{ stale: { id: string; task: string; body: string }[]; touchesNaming: string[] }> {
  const stale: { id: string; task: string; body: string }[] = [];
  const touchesNaming: string[] = [];
  for (let after = ""; ; ) {
    const page = await db.$queryRaw<{ id: string; task: string; body: string; touches: string[]; createdAt: Date }[]>`
      SELECT id, task, body, touches, "createdAt" FROM working_notes
      WHERE "orgId" = ${orgId} AND id > ${after}
      ORDER BY id
      LIMIT ${CHUNK_PAGE}
    `;
    if (page.length === 0) return { stale, touchesNaming };
    for (const n of page) {
      if (erased(`${n.task}\n${n.body}`, n.createdAt)) stale.push({ id: n.id, task: n.task, body: n.body });
      else if (n.touches.length > 0 && erased(pathsAsText(n.touches.join("\n")), n.createdAt)) touchesNaming.push(n.id);
    }
    after = page[page.length - 1]!.id;
  }
}

/**
 * Mark removed every kept upload in the org whose filename an erasure covers, judged as the
 * export judges it (export-erasure.ts). Returns how many it marked.
 */
async function markUploadsNamedInFilename(orgId: string, erased: ErasedContentFilter): Promise<number> {
  let marked = 0;
  for (let after = ""; ; ) {
    const page = await db.uploadedFile.findMany({
      where: { orgId, removedAt: null, id: { gt: after } },
      select: { id: true, filename: true, createdAt: true },
      orderBy: { id: "asc" },
      take: CHUNK_PAGE,
    });
    if (page.length === 0) return marked;
    const named = page.filter((u) =>
      erasureCovers(erased, { type: "upload", filename: u.filename, createdAt: u.createdAt.toISOString() }),
    );
    if (named.length > 0) {
      marked += (
        await db.uploadedFile.updateMany({
          where: { orgId, removedAt: null, id: { in: named.map((u) => u.id) } },
          data: { removedAt: new Date() },
        })
      ).count;
    }
    after = page[page.length - 1]!.id;
  }
}

/** What completing a restore did for one org. */
export interface OrgRestoreCompletion {
  orgId: string;
  /**
   * Whether the org's erasures are now recorded as applied and no re-apply is due in it; the
   * restore is complete only when every org's are.
   */
  applied: boolean;
  /** The admin the re-apply ran as, named on its audit rows; absent when none could. */
  adminUserId?: string;
  result?: ReapplyResult;
  /** Why the re-apply did not run or did not finish. */
  error?: string;
}

/**
 * The last step of every backup restore (docs/consent-deletion-suite.md, "Restore
 * procedure"), run by the restore-completion job (lib/inngest/person-erasure.ts) for every org
 * a copy-back left due, and by scripts/complete-restore.ts for every org: run the re-apply for
 * every such org whose suppression list is not all applied, each as one of its owners, its
 * admins, or a member holding an admin grant on its root (the first, by when they joined, that
 * `access.manage` allows), and read back whether it now is. An org already applied is not
 * re-applied; its due row, if any, is ended. A restore is complete only when every org's
 * entry says `applied`; a run that stops part-way is completed by running it again.
 *
 * @param only the orgs to complete: `"due"` for those a copy-back marked, or every org with a
 *   suppression list or a due row when omitted.
 */
export async function completeRestore({ only }: { only?: "due" } = {}): Promise<OrgRestoreCompletion[]> {
  const due = await orgsWithReapplyDue();
  const listed =
    only === "due"
      ? []
      : (await db.erasureSuppression.findMany({ distinct: ["orgId"], select: { orgId: true } })).map((r) => r.orgId);
  const orgs = [...new Set([...listed, ...due])].sort().map((orgId) => ({ orgId }));
  const completions: OrgRestoreCompletion[] = [];
  for (const { orgId } of orgs) {
    if (await erasuresApplied(orgId)) {
      completions.push({ orgId, applied: await db.$transaction((tx) => endReapplyDue(tx, orgId)) });
      continue;
    }
    // Who may: owners and admins by their live membership or their user row, and anyone, a
    // member included, holding an admin grant on the org root. check() decides from the
    // restored grants; the first it allows runs the pass.
    const rootGrantees = await db.grant.findMany({
      where: { orgId, granteeType: "user", permission: "admin", scope: { path: orgRootPath(orgId) } },
      select: { granteeId: true },
    });
    const admins = await db.user.findMany({
      where: {
        OR: [
          { orgId, role: { in: ["owner", "admin"] } },
          { memberships: { some: { orgId, removedAt: null, role: { in: ["owner", "admin"] } } } },
          { id: { in: rootGrantees.map((g) => g.granteeId) } },
        ],
      },
      select: { id: true, role: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    let completion: OrgRestoreCompletion = {
      orgId,
      applied: false,
      error: "no owner, admin or admin grantee on the org root may run the re-apply",
    };
    for (const admin of admins) {
      const ctx: AccessContext = { orgId, actor: { type: "human", id: admin.id, role: admin.role }, origin: "script" };
      try {
        const result = await reapplyErasures(ctx);
        completion = {
          orgId,
          applied: (await erasuresApplied(orgId)) && !(await reapplyDue(orgId)),
          adminUserId: admin.id,
          result,
        };
        break;
      } catch (e) {
        if (e instanceof AccessDeniedError) continue;
        completion = {
          orgId,
          applied: false,
          adminUserId: admin.id,
          error: e instanceof Error ? e.message : String(e),
        };
        break;
      }
    }
    completions.push(completion);
  }
  return completions;
}
