// Self-serve export: everything a person may read of their org's memory, as JSON Lines
// in the format export-format.ts defines (docs/export-format.md).
//
// The one rule: an export follows access. A person exports exactly the scopes their
// grants let them read (an admin, whose grant covers the root, gets the whole org and its
// audit log), an agent token exports nothing, and anything an erasure removed stays out.
// The export is read a page at a time and written as it is read, so its size is bounded
// by the page, never by the org. An upload's raw file is read from storage as it is
// written, a part at a time, so it is bounded by the part, never by the file.
import { createHash } from "node:crypto";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { readPrivateBlob } from "@/lib/blob-storage";
import {
  AccessDeniedError,
  flattenSql,
  isValidLtreePath,
  orgRootPath,
  pathCovers,
  readableScopePaths,
  readsWholeOrg,
  recordRefusal,
  withinReadableScopesSql,
  writeAuditRow,
  type AccessContext,
  type AuditOrigin,
} from "@/services/access";
import { SYSTEM_ACTOR_ID } from "@/services/access/system-actors";
import { factVersionSql } from "./conflict";
import { loadErasedContentFilter, type ErasedContentFilter } from "./erasure-suppression";
import { erasureCovers, passageWrittenAt } from "./export-erasure";
import {
  DATA_RECORD_TYPES,
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  relativeScope,
  UPLOAD_PART_BYTES,
  type AuditRecord,
  type BriefRecord,
  type ConventionRecord,
  type DataRecord,
  type EdgeRecord,
  type EndRecord,
  type ExportRecord,
  type FactRecord,
  type ManifestRecord,
  type ScopeRecord,
  type SourceRecord,
  type UploadFileRecord,
  type UploadRecord,
  type WorkingNoteRecord,
} from "./export-format";
import { uploadIsKept } from "./uploads";

/** Rows read per query. Bounds the memory an export holds at once. */
export const EXPORT_PAGE_SIZE = 500;

/** Told to an agent that asks for an export. */
const AGENT_REFUSAL = "Agent tokens cannot export memory. A person in the org exports it from Settings.";
/** Told to a person who can read no scope of the org. */
const NO_SCOPE_REFUSAL = "You cannot read any scope in this org, so there is nothing you may export.";
/** Told to a person who asked for one scope and can read nothing in it, whether or not it exists. */
const SCOPE_REFUSAL = "You cannot read that scope, so there is nothing in it you may export.";

/** Where a page of a table starts: after the last row of the previous page. */
type PageCursor = { createdAt: Date; id: string } | null;

/** The keyset condition for the page after `cursor`, on a table's `createdAt` and `id`. */
function after(cursor: PageCursor, createdAt: Prisma.Sql = Prisma.raw('"createdAt"')): Prisma.Sql {
  return cursor === null ? Prisma.sql`TRUE` : Prisma.sql`(${createdAt}, id) > (${cursor.createdAt}, ${cursor.id})`;
}

/** Every page of a table, read with `readPage` until one comes back short. */
async function* pages<T extends { id: string; createdAt: Date }>(
  readPage: (cursor: PageCursor) => Promise<T[]>,
): AsyncGenerator<T[]> {
  let cursor: PageCursor = null;
  for (;;) {
    const rows = await readPage(cursor);
    if (rows.length > 0) yield rows;
    if (rows.length < EXPORT_PAGE_SIZE) return;
    const last = rows.at(-1)!;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}

const iso = (at: Date | null): string | null => (at === null ? null : at.toISOString());

/** What one export reads with: the org, its root, the caller's readable scopes. */
interface ExportReader {
  orgId: string;
  root: string;
  readable: string[];
  erased: ErasedContentFilter;
  /**
   * Uploads with a passage an erasure covers, found as the facts are read. An erasure takes
   * the whole raw file of such an upload, since a file cannot be redacted, so neither does
   * the export write it.
   */
  erasedUploads: Set<string>;
}

/** "This row's scope is one the caller may read", over a fixed column of this file. */
function visible(reader: ExportReader, column: string): Prisma.Sql {
  return withinReadableScopesSql(Prisma.raw(column), reader.orgId, reader.readable);
}

/** A row's scope relative to the root; undefined for a row outside it, which is not exported. */
function scopeOf(reader: ExportReader, scopePath: string | null): string | null | undefined {
  if (scopePath === null) return null;
  return relativeScope(scopePath, reader.root) ?? undefined;
}

async function* scopeRecords(reader: ExportReader): AsyncGenerator<ScopeRecord> {
  type Row = { id: string; path: string; name: string; createdAt: Date };
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT id, path, name, "createdAt" FROM scopes
      WHERE "orgId" = ${reader.orgId} AND ${visible(reader, '"path"')} AND ${after(cursor)}
      ORDER BY "createdAt", id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    for (const row of rows) {
      const path = scopeOf(reader, row.path);
      if (typeof path === "string")
        yield { type: "scope", path, name: row.name, createdAt: row.createdAt.toISOString() };
    }
  }
}

async function* sourceRecords(reader: ExportReader): AsyncGenerator<SourceRecord> {
  type Row = { id: string; scopePath: string; type: string; externalId: string; name: string; createdAt: Date };
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT id, "scopePath", type::text AS type, "externalId", name, "createdAt" FROM sources
      WHERE "orgId" = ${reader.orgId} AND ${visible(reader, '"scopePath"')} AND ${after(cursor)}
      ORDER BY "createdAt", id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    const files = await db.sourceFile.findMany({
      where: { sourceId: { in: rows.map((r) => r.id) } },
      select: { sourceId: true, externalFileId: true, checksum: true, syncedAt: true },
      orderBy: [{ sourceId: "asc" }, { externalFileId: "asc" }],
    });
    for (const row of rows) {
      const scope = scopeOf(reader, row.scopePath);
      if (typeof scope !== "string") continue;
      yield {
        type: "source",
        id: row.id,
        scope,
        sourceType: row.type,
        externalId: row.externalId,
        name: row.name,
        files: files
          .filter((f) => f.sourceId === row.id)
          .map((f) => ({ externalFileId: f.externalFileId, checksum: f.checksum, syncedAt: f.syncedAt.toISOString() })),
        createdAt: row.createdAt.toISOString(),
      };
    }
  }
}

async function* factRecords(reader: ExportReader): AsyncGenerator<FactRecord> {
  type Row = {
    id: string;
    scopePath: string | null;
    content: string;
    entityName: string | null;
    factVersion: boolean;
    role: string | null;
    source: string;
    actorType: string;
    actorId: string | null;
    actorName: string | null;
    sourceId: string | null;
    /** The upload the passage came from, whether or not the reader may read it. */
    fromUpload: string | null;
    /** The same, only when the upload is kept and in a scope the reader may read. */
    uploadId: string | null;
    /** When the upload the passage came from was made, while its record exists. */
    uploadedAt: Date | null;
    occurredAt: Date | null;
    createdAt: Date;
  };
  const readableUpload = Prisma.sql`EXISTS (
    SELECT 1 FROM uploaded_files u
    WHERE u.id = c."uploadId" AND u."orgId" = ${reader.orgId} AND u."removedAt" IS NULL AND ${visible(reader, 'u."scopePath"')})`;
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT c.id, c."scopePath", c.content, c."entityName", ${factVersionSql("c")} AS "factVersion",
             c.role::text AS role, c.source, c."actorType", c."actorId", c."actorName", c."sourceId",
             c."uploadId" AS "fromUpload", CASE WHEN ${readableUpload} THEN c."uploadId" END AS "uploadId",
             (SELECT u."createdAt" FROM uploaded_files u WHERE u.id = c."uploadId" AND u."orgId" = ${reader.orgId}) AS "uploadedAt",
             c."occurredAt", c."createdAt"
      FROM memory_chunks c
      WHERE c."orgId" = ${reader.orgId} AND ${visible(reader, 'c."scopePath"')}
        AND ${after(cursor, Prisma.raw('c."createdAt"'))}
      ORDER BY c."createdAt", c.id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    for (const row of rows) {
      const scope = scopeOf(reader, row.scopePath);
      if (scope === undefined) continue;
      const record: FactRecord = {
        type: "fact",
        id: row.id,
        scope,
        content: row.content,
        entityName: row.entityName,
        factVersion: row.factVersion,
        role: row.role,
        source: row.source,
        actorType: row.actorType,
        actorId: row.actorId,
        actorName: row.actorName,
        sourceId: row.sourceId,
        uploadId: row.uploadId,
        occurredAt: iso(row.occurredAt),
        createdAt: row.createdAt.toISOString(),
      };
      const writtenAt = passageWrittenAt(row.createdAt, row.uploadedAt).toISOString();
      if (!erasureCovers(reader.erased, { ...record, createdAt: writtenAt })) yield record;
      else if (row.fromUpload !== null) reader.erasedUploads.add(row.fromUpload);
    }
  }
}

/**
 * The uploads with a passage an erasure covers in a scope the reader may not read, among
 * `uploaded`: each upload's id and when it was made. The passages in scopes they may read
 * were judged as facts (`erasedUploads`).
 */
async function uploadsWithHiddenErasedPassages(
  reader: ExportReader,
  uploaded: Map<string, Date>,
): Promise<Set<string>> {
  const uploadIds = [...uploaded.keys()];
  type Row = { id: string; uploadId: string; content: string; entityName: string | null; createdAt: Date };
  const found = new Set<string>();
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT c.id, c."uploadId", c.content, c."entityName", c."createdAt" FROM memory_chunks c
      WHERE c."orgId" = ${reader.orgId} AND c."uploadId" = ANY(${uploadIds}::text[])
        AND (${visible(reader, 'c."scopePath"')}) IS NOT TRUE AND ${after(cursor, Prisma.raw('c."createdAt"'))}
      ORDER BY c."createdAt", c.id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    for (const row of rows) {
      const writtenAt = passageWrittenAt(row.createdAt, uploaded.get(row.uploadId) ?? null).toISOString();
      const passage = {
        type: "fact" as const,
        id: row.id,
        content: row.content,
        entityName: row.entityName,
        createdAt: writtenAt,
      };
      if (erasureCovers(reader.erased, passage)) found.add(row.uploadId);
    }
  }
  return found;
}

/**
 * The kept uploads the reader may read, each followed by its raw file. An upload is left
 * out when an erasure covers its filename or one of its passages, a passage judged as written
 * when the file was uploaded (export-erasure.ts, passageWrittenAt). One removed since its
 * page was read is left out too, checked again just before its raw file is read; one still
 * kept whose raw file is gone is written as "missing", so the file says what it lacks.
 */
async function* uploadRecords(reader: ExportReader): AsyncGenerator<UploadRecord | UploadFileRecord> {
  type Row = {
    id: string;
    scopePath: string;
    filename: string;
    fileType: string;
    actorId: string;
    blobUrl: string;
    createdAt: Date;
  };
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT id, "scopePath", filename, "fileType", "actorId", "blobUrl", "createdAt" FROM uploaded_files
      WHERE "orgId" = ${reader.orgId} AND "removedAt" IS NULL AND ${visible(reader, '"scopePath"')} AND ${after(cursor)}
      ORDER BY "createdAt", id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    const hiddenErased = await uploadsWithHiddenErasedPassages(reader, new Map(rows.map((r) => [r.id, r.createdAt])));
    for (const row of rows) {
      const scope = scopeOf(reader, row.scopePath);
      if (typeof scope !== "string") continue;
      const record: UploadRecord = {
        type: "upload",
        id: row.id,
        scope,
        filename: row.filename,
        fileType: row.fileType,
        actorId: row.actorId,
        file: "follows",
        createdAt: row.createdAt.toISOString(),
      };
      if (reader.erasedUploads.has(row.id) || hiddenErased.has(row.id) || erasureCovers(reader.erased, record))
        continue;
      if (!(await uploadIsKept(db, reader.orgId, row.id))) continue;
      const body = await readPrivateBlob(row.blobUrl);
      if (body === null) {
        if (await uploadIsKept(db, reader.orgId, row.id)) yield { ...record, file: "missing" };
        continue;
      }
      yield* fileWithParts(record, body);
    }
  }
}

/** An upload's record, its raw file as `upload_part` lines of {@link UPLOAD_PART_BYTES}, then its `upload_end`. */
async function* fileWithParts(
  record: UploadRecord,
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<UploadRecord | UploadFileRecord> {
  const uploadId = record.id;
  const sha256 = createHash("sha256");
  const file = body.getReader();
  let held: Buffer = Buffer.alloc(0);
  let index = 0;
  let bytes = 0;
  let finished = false;
  const part = (data: Buffer): UploadFileRecord => ({
    type: "upload_part",
    uploadId,
    index: index++,
    data: data.toString("base64"),
  });
  try {
    yield record;
    for (;;) {
      const { done, value } = await file.read();
      if (value !== undefined && value.length > 0) {
        sha256.update(value);
        bytes += value.length;
        held =
          held.length === 0 ? Buffer.from(value.buffer, value.byteOffset, value.length) : Buffer.concat([held, value]);
      }
      let start = 0;
      while (held.length - start >= UPLOAD_PART_BYTES || (done && held.length > start)) {
        const end = Math.min(start + UPLOAD_PART_BYTES, held.length);
        yield part(held.subarray(start, end));
        start = end;
      }
      held = held.subarray(start);
      if (done) break;
    }
    finished = true;
  } finally {
    // An export abandoned mid-file (the download was cancelled) stops reading storage too.
    if (!finished) await file.cancel().catch(() => {});
  }
  yield { type: "upload_end", uploadId, parts: index, bytes, sha256: sha256.digest("hex") };
}

async function* conventionRecords(reader: ExportReader): AsyncGenerator<ConventionRecord> {
  type Row = {
    id: string;
    scopePath: string;
    kind: string;
    subject: string;
    text: string;
    actorId: string;
    supersedesId: string | null;
    supersededById: string | null;
    retiredAt: Date | null;
    retiredBy: string | null;
    createdAt: Date;
  };
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT id, "scopePath", kind::text AS kind, subject, text, "actorId", "supersedesId", "supersededById",
             "retiredAt", "retiredBy", "createdAt"
      FROM conventions
      WHERE "orgId" = ${reader.orgId} AND ${visible(reader, '"scopePath"')} AND ${after(cursor)}
      ORDER BY "createdAt", id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    for (const row of rows) {
      const scope = scopeOf(reader, row.scopePath);
      if (typeof scope !== "string") continue;
      const record: ConventionRecord = {
        type: "convention",
        id: row.id,
        scope,
        kind: row.kind,
        subject: row.subject,
        text: row.text,
        actorId: row.actorId,
        supersedesId: row.supersedesId,
        supersededById: row.supersededById,
        retiredAt: iso(row.retiredAt),
        retiredBy: row.retiredBy,
        createdAt: row.createdAt.toISOString(),
      };
      if (!erasureCovers(reader.erased, record)) yield record;
    }
  }
}

async function* workingNoteRecords(reader: ExportReader): AsyncGenerator<WorkingNoteRecord> {
  type Row = {
    id: string;
    scopePath: string;
    agentId: string;
    task: string;
    kind: string;
    body: string;
    expiresAt: Date;
    releasedAt: Date | null;
    createdAt: Date;
  };
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT id, "scopePath", "agentId", task, kind::text AS kind, body, "expiresAt", "releasedAt", "createdAt"
      FROM working_notes
      WHERE "orgId" = ${reader.orgId} AND ${visible(reader, '"scopePath"')} AND ${after(cursor)}
      ORDER BY "createdAt", id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    for (const row of rows) {
      const scope = scopeOf(reader, row.scopePath);
      if (typeof scope !== "string") continue;
      const record: WorkingNoteRecord = {
        type: "working_note",
        id: row.id,
        scope,
        agentId: row.agentId,
        task: row.task,
        kind: row.kind,
        body: row.body,
        expiresAt: row.expiresAt.toISOString(),
        releasedAt: iso(row.releasedAt),
        createdAt: row.createdAt.toISOString(),
      };
      if (!erasureCovers(reader.erased, record)) yield record;
    }
  }
}

async function* briefRecords(reader: ExportReader): AsyncGenerator<BriefRecord> {
  type Row = {
    id: string;
    scopePath: string;
    type: string;
    title: string;
    summary: string;
    sections: unknown;
    milestones: unknown;
    charts: unknown;
    decisions: unknown;
    diagram: string | null;
    granteeName: string | null;
    granteeRole: string | null;
    scopeLabel: string | null;
    createdAt: Date;
  };
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT id, "scopePath", type::text AS type, title, summary, sections, milestones, charts, decisions,
             diagram, "granteeName", "granteeRole", "scopeLabel", "createdAt"
      FROM briefs
      WHERE "orgId" = ${reader.orgId} AND ${visible(reader, '"scopePath"')} AND ${after(cursor)}
      ORDER BY "createdAt", id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    const ids = rows.map((r) => r.id);
    const [citations, provenance, retirements] = await Promise.all([
      db.briefCitation.findMany({
        where: { briefId: { in: ids } },
        select: { briefId: true, sectionIndex: true, factId: true, factText: true },
        orderBy: [{ briefId: "asc" }, { sectionIndex: "asc" }, { factId: "asc" }],
      }),
      db.briefProvenance.findMany({ where: { briefId: { in: ids } }, select: { briefId: true, sourceIds: true } }),
      db.briefRetirement.findMany({
        where: { briefId: { in: ids } },
        select: { briefId: true, sourceId: true, reason: true, legacy: true, createdAt: true },
        orderBy: [{ briefId: "asc" }, { sourceId: "asc" }],
      }),
    ]);
    for (const row of rows) {
      const scope = scopeOf(reader, row.scopePath);
      const body = {
        sections: row.sections,
        milestones: row.milestones,
        charts: row.charts,
        decisions: row.decisions,
        diagram: row.diagram,
        granteeName: row.granteeName,
        granteeRole: row.granteeRole,
        scopeLabel: row.scopeLabel,
      };
      if (typeof scope !== "string") continue;
      const record: BriefRecord = {
        type: "brief",
        id: row.id,
        scope,
        briefType: row.type,
        title: row.title,
        summary: row.summary,
        body,
        citations: citations
          .filter((c) => c.briefId === row.id)
          .map((c) => ({ sectionIndex: c.sectionIndex, factId: c.factId, factText: c.factText })),
        sourceIds: provenance.find((p) => p.briefId === row.id)?.sourceIds ?? [],
        retirements: retirements
          .filter((r) => r.briefId === row.id)
          .map((r) => ({
            sourceId: r.sourceId,
            reason: r.reason,
            legacy: r.legacy,
            createdAt: r.createdAt.toISOString(),
          })),
        createdAt: row.createdAt.toISOString(),
      };
      if (!erasureCovers(reader.erased, record)) yield record;
    }
  }
}

/**
 * An edge's `toId` is a record in the caller's readable scopes. An edge's own scope is its
 * `from` record's, so without this a scoped export could name a record it may not show.
 */
function edgeTargetVisible(reader: ExportReader): Prisma.Sql {
  const inTable = (table: string) => Prisma.sql`EXISTS (
    SELECT 1 FROM ${Prisma.raw(table)} target
    WHERE target.id = fact_edges."toId" AND target."orgId" = ${reader.orgId} AND ${visible(reader, 'target."scopePath"')})`;
  return Prisma.sql`(${inTable("memory_chunks")} OR ${inTable("conventions")} OR ${inTable("briefs")})`;
}

async function* edgeRecords(reader: ExportReader): AsyncGenerator<EdgeRecord> {
  type Row = {
    id: string;
    fromId: string;
    toId: string;
    kind: string;
    scopePath: string;
    actorType: string;
    actorId: string;
    createdAt: Date;
  };
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT id, "fromId", "toId", kind::text AS kind, "scopePath", "actorType"::text AS "actorType", "actorId", "createdAt"
      FROM fact_edges
      WHERE "orgId" = ${reader.orgId} AND ${visible(reader, '"scopePath"')} AND ${edgeTargetVisible(reader)}
        AND ${after(cursor)}
      ORDER BY "createdAt", id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    for (const row of rows) {
      const scope = scopeOf(reader, row.scopePath);
      if (typeof scope !== "string") continue;
      yield {
        type: "edge",
        fromId: row.fromId,
        toId: row.toId,
        kind: row.kind,
        scope,
        actorType: row.actorType,
        actorId: row.actorId,
        createdAt: row.createdAt.toISOString(),
      };
    }
  }
}

/** The org's audit log. Its rows carry no scope, so only a whole-org export includes it. */
async function* auditRecords(reader: ExportReader): AsyncGenerator<AuditRecord> {
  type Row = {
    id: string;
    actorType: string;
    actorId: string;
    action: string;
    target: string | null;
    decision: string;
    reason: string | null;
    createdAt: Date;
  };
  for await (const rows of pages<Row>((cursor) =>
    db.$queryRaw<Row[]>(
      ...flattenSql(Prisma.sql`
      SELECT id, "actorType", "actorId", action, target, decision::text AS decision, reason, at AS "createdAt"
      FROM audit_log
      WHERE "orgId" = ${reader.orgId} AND ${after(cursor, Prisma.raw("at"))}
      ORDER BY at, id LIMIT ${EXPORT_PAGE_SIZE}`),
    ),
  )) {
    for (const row of rows) {
      yield {
        type: "audit",
        id: row.id,
        actorType: row.actorType,
        actorId: row.actorId,
        action: row.action,
        target: row.target,
        decision: row.decision,
        reason: row.reason,
        at: row.createdAt.toISOString(),
      };
    }
  }
}

/** Refuses the export with `reason`, recording the refusal in the audit log first. */
async function refuse(ctx: AccessContext, reason: string): Promise<never> {
  await recordRefusal(ctx, { action: "memory.read", target: `${orgRootPath(ctx.orgId)}:export`, auditReason: reason });
  throw new AccessDeniedError({ allowed: false, reason });
}

/**
 * The readable scopes inside `scope`: `scope` itself when a readable scope covers it,
 * otherwise the readable scopes below it. Empty when the caller can read nothing there,
 * and for a `scope` that is not a scope path at all.
 */
function readableWithin(readable: string[], scope: string): string[] {
  if (!isValidLtreePath(scope)) return [];
  if (readable.some((path) => pathCovers(path, scope))) return [scope];
  return readable.filter((path) => pathCovers(scope, path));
}

/** What to export. Without a scope, everything the caller may read. */
interface ExportOptions {
  /**
   * One absolute scope path: export only it and its descendants, as far as the caller
   * may read them. The org root is the same as no scope.
   */
  scope?: string;
}

/**
 * The org's memory as `ctx` may read it, one JSON Lines line at a time: a manifest, the
 * data records in {@link DATA_RECORD_TYPES} order, then an end record with the counts.
 * Throws AccessDeniedError, before writing anything, for an agent, for a person who can
 * read no scope, and for a person who asked for a scope they can read nothing of.
 * Starting an export writes one allow row to the audit log.
 */
export async function* exportMemory(
  ctx: AccessContext,
  now: Date = new Date(),
  options: ExportOptions = {},
): AsyncGenerator<string> {
  if (ctx.actor.type !== "human") await refuse(ctx, AGENT_REFUSAL);
  const granted = await readableScopePaths(ctx, "read");
  if (granted.length === 0) await refuse(ctx, NO_SCOPE_REFUSAL);
  const readable = options.scope === undefined ? granted : readableWithin(granted, options.scope);
  if (readable.length === 0) await refuse(ctx, SCOPE_REFUSAL);

  const root = orgRootPath(ctx.orgId);
  const wholeOrg = readsWholeOrg(ctx.orgId, readable);
  const reader: ExportReader = {
    orgId: ctx.orgId,
    root,
    readable,
    erased: await loadErasedContentFilter(ctx.orgId),
    erasedUploads: new Set(),
  };
  const scopes = wholeOrg
    ? [""]
    : [...new Set(readable.map((path) => relativeScope(path, root)).filter((path) => path !== null))].sort();
  await writeAuditRow({
    orgId: ctx.orgId,
    actorType: ctx.actor.type,
    actorId: ctx.actor.id,
    action: "memory.read",
    target: `${root}:export`,
    decision: "allow",
    reason: `export of ${wholeOrg ? "the whole org" : `scopes ${scopes.join(", ")}`}`,
    metadata: {},
    runId: ctx.runId,
    origin: ctx.origin,
  });
  yield* exportRecords(reader, wholeOrg, scopes, now);
}

/**
 * The whole org's export, made by the product itself rather than by a person: the final
 * export an org deletion produces for its owner (services/memory/org-deletion). It holds what an
 * admin's export holds, audit log included, and is recorded on the audit trail as a
 * system read for that deletion. Only the deletion job calls it.
 */
export async function* exportWholeOrg(
  orgId: string,
  deletionId: string,
  origin: AuditOrigin,
  now: Date = new Date(),
): AsyncGenerator<string> {
  const root = orgRootPath(orgId);
  const reader: ExportReader = {
    orgId,
    root,
    readable: [root],
    erased: await loadErasedContentFilter(orgId),
    erasedUploads: new Set(),
  };
  await writeAuditRow({
    orgId,
    actorType: "extraction",
    actorId: SYSTEM_ACTOR_ID,
    action: "memory.read",
    target: `${root}:export`,
    decision: "allow",
    reason: `final export of the whole org for org deletion ${deletionId}`,
    metadata: { deletionId },
    origin,
  });
  yield* exportRecords(reader, true, [""], now);
}

/** The manifest, every record `reader` may see, and the end record with their counts. */
async function* exportRecords(
  reader: ExportReader,
  wholeOrg: boolean,
  scopes: string[],
  now: Date,
): AsyncGenerator<string> {
  const manifest: ManifestRecord = {
    type: "manifest",
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    coverage: wholeOrg ? "org" : "scopes",
    scopes,
  };
  yield line(manifest);

  const counts = Object.fromEntries(DATA_RECORD_TYPES.map((type) => [type, 0])) as EndRecord["counts"];
  const readers: Record<DataRecord["type"], (r: ExportReader) => AsyncGenerator<DataRecord | UploadFileRecord>> = {
    scope: scopeRecords,
    source: sourceRecords,
    fact: factRecords,
    upload: uploadRecords,
    convention: conventionRecords,
    working_note: workingNoteRecords,
    brief: briefRecords,
    edge: edgeRecords,
    audit: auditRecords,
  };
  for (const type of DATA_RECORD_TYPES) {
    if (type === "audit" && !wholeOrg) continue;
    for await (const record of readers[type](reader)) {
      if (record.type === type) counts[type]++;
      yield line(record);
    }
  }
  yield line({ type: "end", counts });
}

function line(record: ExportRecord): string {
  return `${JSON.stringify(record)}\n`;
}
