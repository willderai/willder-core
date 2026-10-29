// Import: a Willder export (export-format.ts) loaded into an org that holds no memory
// yet, so a customer can move to a fresh org, a new deployment, or the open-source core.
//
// The one rule: an import only ever fills an empty org, as an admin of that org, and it
// lands whole or not at all. Every record gets a new id in the target org (a link between
// records is carried over through those ids), every scope is placed under the target's
// own root, and embeddings are computed again from the text. An export that does not end
// with its end record, or whose counts disagree with what it held, is refused.
//
// An import is also a restore, so it answers to the target org's erasures as an export
// does: a record an erasure in that org covers (its text names an erased person, or it is
// a version or rule the erasure removed, and it was written before the erasure) is left
// out and counted, never written, judged by the one rule the export applies
// (services/memory/export-erasure.ts). Without this, exporting, erasing a person and
// importing the earlier file back would serve them again. Once everything is written the
// import re-applies the org's erasures (services/memory/erasure-reapply.ts): that second pass
// catches facts and rules an erasure that started during the import covers, and reaches
// briefs and working notes only where erasure-reapply.ts has passes for them.
//
// An upload's raw file is checked and stored as it is read: its parts are streamed into
// storage and their byte count and SHA-256 compared with the file's `upload_end` before the
// upload is recorded. An upload an erasure covers, by its filename or by a passage of it
// judged as written when the file was uploaded, is never stored, nor is that passage, and a
// failed import deletes the raw files it stored.
import { createHash, type Hash } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { z } from "zod";
import { Prisma } from "@/lib/generated/prisma/client";
import { db } from "@/lib/db";
import { scopeNameTooLong } from "@/services/access/scope-name";
import { deletePrivateBlob, putPrivateBlob, type StoredBlob } from "@/lib/blob-storage";
import {
  AccessDeniedError,
  check,
  flattenSql,
  isValidLtreePath,
  orgRootPath,
  recordRefusal,
  type AccessContext,
} from "@/services/access";
import { embedTexts } from "./embedding-service";
import {
  absoluteScope,
  DATA_RECORD_TYPES,
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  UPLOAD_PART_BYTES,
  type DataRecord,
  type EndRecord,
} from "./export-format";
import { embedPassages, insertPassagesSql, pgVec } from "./pgvector-store";
import { reapplyErasures, type ReapplyResult } from "./erasure-reapply";
import { loadErasedContentFilter, type ErasedContentFilter } from "./erasure-suppression";
import { erasureCovers, passageWrittenAt } from "./export-erasure";
import { deleteRemovedUploads } from "./uploads";

/** Facts embedded and stored per round. */
const FACT_BATCH_SIZE = 64;

/** Why an import was refused: the file, or the org it was aimed at. Safe to show the caller. */
export class ImportRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportRefusedError";
  }
}

/**
 * The import was written but re-applying the org's erasures after it failed, so it was
 * undone: nothing showed that no erased person came back. The file is fine; try again.
 */
export class ImportIncompleteError extends Error {
  constructor(cause: unknown) {
    super(
      "The import was undone because re-applying this org's erasures after it failed. The file is fine: import it again.",
      { cause },
    );
    this.name = "ImportIncompleteError";
  }
}

/** What an import did, per record type. */
export interface ImportReceipt {
  imported: Record<DataRecord["type"], number>;
  /** Records left out because an erasure in the target org covers them, per record type. */
  erased: Record<DataRecord["type"], number>;
  /** Edges whose ends were not imported: not in the export (a scoped export can hold one end only), or left out as erased. */
  skippedEdges: number;
  /** Audit rows in the file. An org's audit log records its own history, so none is written. */
  auditRowsNotImported: number;
  /** Uploads the export marked "missing": their raw file was not in it, so they are not restored. */
  uploadsWithoutFile: number;
  /**
   * The org's erasures re-applied once the import was written: what that second pass
   * removed, from the import's rows or any other. `imported` counts what was written before it.
   */
  erasuresReapplied: ReapplyResult;
}

const isoDate = z.string().datetime({ offset: true });
const relative = z.string().regex(/^$|^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "a scope relative to the org root");

const manifestSchema = z.object({
  type: z.literal("manifest"),
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.number().int().min(1).max(EXPORT_SCHEMA_VERSION),
});

const recordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("scope"), path: relative, name: z.string(), createdAt: isoDate }),
  z.object({
    type: z.literal("source"),
    id: z.string(),
    scope: relative,
    sourceType: z.enum(["gdrive", "website", "slack", "figma", "posthog", "github"]),
    externalId: z.string(),
    name: z.string(),
    files: z.array(z.object({ externalFileId: z.string(), checksum: z.string(), syncedAt: isoDate })),
    createdAt: isoDate,
  }),
  z.object({
    type: z.literal("fact"),
    id: z.string(),
    scope: relative.nullable(),
    content: z.string(),
    entityName: z.string().nullable(),
    factVersion: z.boolean(),
    role: z.enum(["cause", "constraint", "decision", "rejected", "progress"]).nullable(),
    source: z.string(),
    actorType: z.string(),
    actorId: z.string().nullable(),
    actorName: z.string().nullable(),
    sourceId: z.string().nullable(),
    // Schema version 1 carried no uploads.
    uploadId: z.string().nullable().default(null),
    occurredAt: isoDate.nullable(),
    createdAt: isoDate,
  }),
  z.object({
    type: z.literal("convention"),
    id: z.string(),
    scope: relative,
    kind: z.enum(["convention", "decision"]),
    subject: z.string(),
    text: z.string(),
    actorId: z.string(),
    supersedesId: z.string().nullable(),
    supersededById: z.string().nullable(),
    retiredAt: isoDate.nullable(),
    retiredBy: z.string().nullable(),
    createdAt: isoDate,
  }),
  z.object({
    type: z.literal("working_note"),
    id: z.string(),
    scope: relative,
    agentId: z.string(),
    task: z.string(),
    kind: z.enum(["claim", "intent", "status", "question"]),
    body: z.string(),
    expiresAt: isoDate,
    releasedAt: isoDate.nullable(),
    createdAt: isoDate,
  }),
  z.object({
    type: z.literal("brief"),
    id: z.string(),
    scope: relative,
    briefType: z.enum(["handoff", "architecture_plan", "qa_review"]),
    title: z.string(),
    summary: z.string(),
    body: z.object({
      sections: z.unknown(),
      milestones: z.unknown(),
      charts: z.unknown(),
      decisions: z.unknown(),
      diagram: z.string().nullable(),
      granteeName: z.string().nullable(),
      granteeRole: z.string().nullable(),
      scopeLabel: z.string().nullable(),
    }),
    citations: z.array(z.object({ sectionIndex: z.number().int(), factId: z.string(), factText: z.string() })),
    sourceIds: z.array(z.string()),
    retirements: z.array(
      z.object({ sourceId: z.string(), reason: z.string(), legacy: z.boolean(), createdAt: isoDate }),
    ),
    createdAt: isoDate,
  }),
  z.object({
    type: z.literal("edge"),
    fromId: z.string(),
    toId: z.string(),
    kind: z.enum(["derivedFrom", "supersedes", "dependsOn", "ownedBy", "deliveredTo", "causedBy"]),
    scope: relative,
    actorType: z.enum(["human", "agent", "extraction"]),
    actorId: z.string(),
    createdAt: isoDate,
  }),
  z.object({
    type: z.literal("upload"),
    id: z.string(),
    scope: relative,
    filename: z.string().min(1),
    fileType: z.string().min(1),
    actorId: z.string(),
    file: z.enum(["follows", "missing"]),
    createdAt: isoDate,
  }),
  z.object({
    type: z.literal("upload_part"),
    uploadId: z.string(),
    index: z.number().int().min(0),
    data: z
      .string()
      .max((UPLOAD_PART_BYTES / 3) * 4, `at most ${UPLOAD_PART_BYTES} bytes per part`)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "standard base64"),
  }),
  z.object({
    type: z.literal("upload_end"),
    uploadId: z.string(),
    parts: z.number().int().min(0),
    bytes: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "a SHA-256 in hex"),
  }),
  z.object({ type: z.literal("audit") }).passthrough(),
]);

const endSchema = z.object({
  type: z.literal("end"),
  counts: z.record(z.string(), z.number().int().min(0)),
});

type Parsed = z.infer<typeof recordSchema>;
type Of<T extends Parsed["type"]> = Extract<Parsed, { type: T }>;

/** The record types whose text an erasure can name, as the export filters them. Uploads are judged in startUpload. */
type Erasable = Of<"fact" | "convention" | "working_note" | "brief">;
const isErasable = (record: Parsed): record is Erasable =>
  record.type === "fact" || record.type === "convention" || record.type === "working_note" || record.type === "brief";

/** An upload whose raw file is being read: what has arrived so far, and where it is going. */
interface IncomingFile {
  record: Of<"upload">;
  /**
   * The upload's id in the target org, taken when its record is read. Null when an erasure
   * covers the upload: its parts are then checked and never stored.
   */
  id: string | null;
  parts: number;
  bytes: number;
  sha256: Hash;
  /** The stream being stored, written a part at a time; null when the file is not kept. */
  sink: WritableStreamDefaultWriter<Uint8Array> | null;
  stored: Promise<StoredBlob> | null;
}

/**
 * A write to, or the close of, the stream being stored. It fails when storage stopped
 * reading, and then storage's own error is the one that says why.
 */
function storing(file: IncomingFile, step: Promise<void>): Promise<void> {
  return step.catch(async (error: unknown) => {
    await file.stored;
    throw error;
  });
}

/** Splits a byte stream into lines, holding at most one partial line at a time. */
export async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    yield* lines;
  }
  pending += decoder.decode();
  if (pending !== "") yield pending;
}

function parseLine(text: string, lineNumber: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportRefusedError(`Line ${lineNumber} is not JSON. Import the file exactly as the export wrote it.`);
  }
}

function invalid(lineNumber: number, error: z.ZodError): ImportRefusedError {
  const issue = error.issues[0]!;
  return new ImportRefusedError(
    `Line ${lineNumber} is not a valid record: ${issue.path.join(".") || "record"}: ${issue.message}.`,
  );
}

/** Org tables an import writes. The target must hold no row in any of them, and no kept upload. */
const IMPORTED_TABLES = ["memory_chunks", "conventions", "working_notes", "briefs", "fact_edges", "sources"] as const;

async function holdsMemory(orgId: string): Promise<boolean> {
  const checks = [
    ...IMPORTED_TABLES.map(
      (table) => Prisma.sql`EXISTS (SELECT 1 FROM ${Prisma.raw(`"${table}"`)} WHERE "orgId" = ${orgId})`,
    ),
    Prisma.sql`EXISTS (SELECT 1 FROM uploaded_files WHERE "orgId" = ${orgId} AND "removedAt" IS NULL)`,
  ];
  const [row] = await db.$queryRaw<{ holds: boolean }[]>(
    ...flattenSql(Prisma.sql`SELECT (${checks.reduce((all, leg) => Prisma.sql`${all} OR ${leg}`)}) AS holds`),
  );
  return row!.holds;
}

/**
 * Removes what a failed import wrote, by the ids it created. Other writers can add to the
 * org while an import runs (a connector sync, an agent's memory_add), so the org being
 * empty at the start never makes "every row in the org" the import's own.
 */
async function removeImported(writer: ImportWriter): Promise<void> {
  const { orgId, created } = writer;
  await writer.abandonFile();
  const records = [...writer.ids.values()];
  await db.$transaction([
    // Marked, then deleted with their raw files below, as every upload removal goes (uploads.ts).
    db.uploadedFile.updateMany({
      where: { orgId, id: { in: records }, removedAt: null },
      data: { removedAt: new Date() },
    }),
    db.$executeRaw`DELETE FROM fact_edges WHERE "orgId" = ${orgId} AND id = ANY(${created.edges}::text[])`,
    db.$executeRaw`DELETE FROM briefs WHERE "orgId" = ${orgId} AND id = ANY(${records}::text[])`,
    db.$executeRaw`DELETE FROM working_notes WHERE "orgId" = ${orgId} AND id = ANY(${records}::text[])`,
    db.$executeRaw`UPDATE conventions SET "supersedesId" = NULL, "supersededById" = NULL WHERE "orgId" = ${orgId} AND id = ANY(${records}::text[])`,
    db.$executeRaw`DELETE FROM conventions WHERE "orgId" = ${orgId} AND id = ANY(${records}::text[])`,
    db.$executeRaw`DELETE FROM memory_chunks WHERE "orgId" = ${orgId} AND id = ANY(${records}::text[])`,
    db.$executeRaw`DELETE FROM sources WHERE "orgId" = ${orgId} AND id = ANY(${records}::text[])`,
    db.$executeRaw`DELETE FROM scopes WHERE "orgId" = ${orgId} AND id = ANY(${created.scopes}::text[])`,
  ]);
  // A raw file whose delete fails stays marked, never served, and the next removal in the
  // org (or scripts/blob-orphans.ts) deletes it; the import's own error is the one reported.
  await deleteRemovedUploads(orgId).catch((e: unknown) =>
    console.error(`[import] ${orgId}: a raw file is still to be deleted`, e),
  );
}

/** One import's state: the target org and every export id mapped to its new id. */
class ImportWriter {
  readonly root: string;
  readonly ids = new Map<string, string>();
  /** Export ids of records left out as erased: never mapped, but still counted as seen. */
  private readonly leftOut = new Set<string>();
  readonly imported = Object.fromEntries(DATA_RECORD_TYPES.map((type) => [type, 0])) as ImportReceipt["imported"];
  readonly erased = Object.fromEntries(DATA_RECORD_TYPES.map((type) => [type, 0])) as ImportReceipt["erased"];
  skippedEdges = 0;
  auditRowsNotImported = 0;
  uploadsWithoutFile = 0;
  /** Scope records read, including those the org already had. */
  scopesRead = 0;
  /** Edges and scopes this import created. With `ids`, the only rows removed if it fails. */
  readonly created = { edges: [] as string[], scopes: [] as string[] };
  private facts: Of<"fact">[] = [];
  /** Conventions that lost a race to a later one, linked once every convention exists. */
  private lostRaces: { loser: string; winner: string }[] = [];
  /** Export ids of the passages of each upload, by its export id, linked once the upload is stored. */
  private readonly passagesOf = new Map<string, string[]>();
  /** Export ids of uploads with a passage an erasure covers: the whole file is left out, as the erasure takes it. */
  private readonly erasedUploads = new Set<string>();
  /** The upload whose raw file is being read, between its record and its `upload_end`. */
  private file: IncomingFile | null = null;

  constructor(
    readonly orgId: string,
    private readonly isErased: ErasedContentFilter,
  ) {
    this.root = orgRootPath(orgId);
  }

  /**
   * True when an erasure in the target org covers the record, by the rule the export
   * applies (export-erasure.ts). The record's export id is checked as a version or rule id
   * too: restoring into the org it came from brings back the very rows the erasure named by id.
   */
  private coveredByErasure(record: Erasable): boolean {
    return erasureCovers(this.isErased, record);
  }

  private scope(relativePath: string): string {
    const path = absoluteScope(relativePath, this.root);
    if (!isValidLtreePath(path)) throw new ImportRefusedError(`Scope "${relativePath}" is not a valid scope path.`);
    return path;
  }

  private newId(exportId: string): string {
    if (this.ids.has(exportId) || this.leftOut.has(exportId))
      throw new ImportRefusedError(`Record id ${exportId} appears twice in the export.`);
    const id = createId();
    this.ids.set(exportId, id);
    return id;
  }

  /** The new id of an exported record, or null when the export did not hold it. */
  private mapped(exportId: string | null): string | null {
    return exportId === null ? null : (this.ids.get(exportId) ?? null);
  }

  async write(record: Parsed): Promise<void> {
    if (record.type === "upload_part" || record.type === "upload_end") return this.writeFilePart(record);
    if (this.file !== null) throw this.cutShort(this.file.record.id);
    if (record.type !== "fact") await this.flushFacts();
    if (record.type === "scope") this.scopesRead++;
    if (isErasable(record) && this.coveredByErasure(record)) {
      // Its id stays unmapped, so an edge or supersedes link to it is not written either.
      this.leaveOut(record.id);
      this.erased[record.type]++;
      if (record.type === "fact" && record.uploadId !== null) this.erasedUploads.add(record.uploadId);
      return;
    }
    switch (record.type) {
      case "scope":
        if (!(await this.writeScope(record))) return;
        break;
      case "source":
        await db.source.create({
          data: {
            id: this.newId(record.id),
            orgId: this.orgId,
            type: record.sourceType,
            externalId: record.externalId,
            name: record.name,
            scopePath: this.scope(record.scope),
            // No credentials travel with an export: the source is listed, not connected.
            status: "disconnected",
            createdAt: new Date(record.createdAt),
            files: {
              create: record.files.map((f) => ({
                externalFileId: f.externalFileId,
                checksum: f.checksum,
                syncedAt: new Date(f.syncedAt),
              })),
            },
          },
        });
        break;
      case "fact":
        this.facts.push(record);
        if (record.uploadId !== null) {
          const passages = this.passagesOf.get(record.uploadId);
          if (passages) passages.push(record.id);
          else this.passagesOf.set(record.uploadId, [record.id]);
        }
        if (this.facts.length >= FACT_BATCH_SIZE) await this.flushFacts();
        return;
      case "upload":
        return await this.startUpload(record);
      case "convention":
        await this.writeConvention(record);
        break;
      case "working_note":
        await db.workingNote.create({
          data: {
            id: this.newId(record.id),
            orgId: this.orgId,
            scopePath: this.scope(record.scope),
            agentId: record.agentId,
            task: record.task,
            kind: record.kind,
            body: record.body,
            expiresAt: new Date(record.expiresAt),
            releasedAt: record.releasedAt === null ? null : new Date(record.releasedAt),
            createdAt: new Date(record.createdAt),
          },
        });
        break;
      case "brief":
        await this.writeBrief(record);
        break;
      case "edge":
        await this.writeEdge(record);
        return;
      case "audit":
        this.auditRowsNotImported++;
        return;
    }
    this.imported[record.type]++;
  }

  private leaveOut(exportId: string): void {
    if (this.ids.has(exportId) || this.leftOut.has(exportId))
      throw new ImportRefusedError(`Record id ${exportId} appears twice in the export.`);
    this.leftOut.add(exportId);
  }

  private cutShort(uploadId: string): ImportRefusedError {
    return new ImportRefusedError(`The raw file of upload ${uploadId} is cut short. Export again.`);
  }

  /**
   * Reads an upload's record. Its raw file follows in parts: a kept file is streamed into
   * storage as they arrive; one an erasure covers, by its filename or by a passage of it
   * already read, is checked and never stored.
   */
  private async startUpload(record: Of<"upload">): Promise<void> {
    const passageCovered = await this.leaveOutPassagesCoveredAsUploaded(record);
    const keep = !passageCovered && !this.erasedUploads.has(record.id) && !erasureCovers(this.isErased, record);
    if (!keep) {
      this.leaveOut(record.id);
      this.erased.upload++;
    }
    if (record.file === "missing") {
      if (keep) {
        this.leaveOut(record.id);
        this.uploadsWithoutFile++;
      }
      return;
    }
    let id: IncomingFile["id"] = null;
    let sink: IncomingFile["sink"] = null;
    let stored: IncomingFile["stored"] = null;
    if (keep) {
      id = this.newId(record.id);
      const pipe = new TransformStream<Uint8Array, Uint8Array>();
      sink = pipe.writable.getWriter();
      // A filename is a name, not a path: it never moves the file out of the org's prefix.
      stored = putPrivateBlob(`memory/${this.orgId}/${record.filename.replaceAll("/", "_")}`, pipe.readable);
      // Storage that fails stops the writes waiting on it.
      const writer = sink;
      stored.catch((error: unknown) => writer.abort(error).catch(() => {}));
    }
    this.file = { record, id, parts: 0, bytes: 0, sha256: createHash("sha256"), sink, stored };
  }

  /**
   * Removes the passages of `upload` already written that an erasure covers once each is
   * judged as written when the file was uploaded (export-erasure.ts, passageWrittenAt), and
   * says whether there were any. Every fact comes before every upload, so each passage was
   * written judged by its own time, before its upload's time was known.
   */
  private async leaveOutPassagesCoveredAsUploaded(upload: Of<"upload">): Promise<boolean> {
    const uploadedAt = new Date(upload.createdAt);
    const exportIds = this.passagesOf.get(upload.id) ?? [];
    let found = false;
    for (let at = 0; at < exportIds.length; at += FACT_BATCH_SIZE) {
      const page = exportIds.slice(at, at + FACT_BATCH_SIZE).flatMap((exportId) => {
        const id = this.ids.get(exportId);
        return id === undefined ? [] : [{ exportId, id }];
      });
      const rows = await db.memoryChunk.findMany({
        where: { orgId: this.orgId, id: { in: page.map((p) => p.id) } },
        select: { id: true, content: true, entityName: true, createdAt: true },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      const covered = page.filter(({ exportId, id }) => {
        const row = byId.get(id);
        if (row === undefined) return false;
        const writtenAt = passageWrittenAt(row.createdAt, uploadedAt).toISOString();
        return erasureCovers(this.isErased, {
          type: "fact",
          id: exportId,
          content: row.content,
          entityName: row.entityName,
          createdAt: writtenAt,
        });
      });
      if (covered.length === 0) continue;
      found = true;
      await db.memoryChunk.deleteMany({ where: { orgId: this.orgId, id: { in: covered.map((c) => c.id) } } });
      for (const { exportId } of covered) {
        this.ids.delete(exportId);
        this.leftOut.add(exportId);
      }
      this.imported.fact -= covered.length;
      this.erased.fact += covered.length;
    }
    return found;
  }

  /** One part of the open upload's raw file, or its end: checked, then stored and recorded. */
  private async writeFilePart(record: Of<"upload_part" | "upload_end">): Promise<void> {
    const file = this.file;
    if (file === null || record.uploadId !== file.record.id) {
      throw new ImportRefusedError(
        `A part of upload ${record.uploadId}'s raw file is out of place. Import the file exactly as the export wrote it.`,
      );
    }
    if (record.type === "upload_part") {
      if (record.index !== file.parts) {
        throw new ImportRefusedError(
          `The raw file of upload ${file.record.id} has part ${record.index} where part ${file.parts} belongs. Export again.`,
        );
      }
      const bytes = Buffer.from(record.data, "base64");
      file.parts++;
      file.bytes += bytes.length;
      file.sha256.update(bytes);
      if (file.sink !== null) await storing(file, file.sink.write(bytes));
      return;
    }
    if (record.parts !== file.parts || record.bytes !== file.bytes || record.sha256 !== file.sha256.digest("hex")) {
      throw new ImportRefusedError(
        `The raw file of upload ${file.record.id} does not match its checksum. Export again.`,
      );
    }
    this.file = null;
    if (file.id === null) return;
    const id = file.id;
    await storing(file, file.sink!.close());
    const blob = await file.stored!;
    try {
      await db.uploadedFile.create({
        data: {
          id,
          orgId: this.orgId,
          scopePath: this.scope(file.record.scope),
          filename: file.record.filename,
          fileType: file.record.fileType,
          blobUrl: blob.url,
          actorId: file.record.actorId,
          createdAt: new Date(file.record.createdAt),
        },
      });
    } catch (error) {
      await deletePrivateBlob(blob.url);
      throw error;
    }
    const passages = (this.passagesOf.get(file.record.id) ?? []).flatMap((exportId) => this.ids.get(exportId) ?? []);
    this.passagesOf.delete(file.record.id);
    if (passages.length > 0)
      await db.memoryChunk.updateMany({ where: { orgId: this.orgId, id: { in: passages } }, data: { uploadId: id } });
    this.imported.upload++;
  }

  /** Stops storing the raw file being read, if any, and deletes it if it was stored. For a failed import. */
  async abandonFile(): Promise<void> {
    const file = this.file;
    this.file = null;
    if (file === null || file.sink === null) return;
    await file.sink.abort(new Error("import failed")).catch(() => {});
    const blob = await file.stored!.catch(() => null);
    if (blob !== null) await deletePrivateBlob(blob.url);
  }

  /** Creates the scope unless the org has it already, as it has its root. True when it created it. */
  private async writeScope(record: Of<"scope">): Promise<boolean> {
    const path = this.scope(record.path);
    const existing = await db.scope.findUnique({
      where: { orgId_path: { orgId: this.orgId, path } },
      select: { id: true },
    });
    if (existing !== null) return false;
    const tooLong = scopeNameTooLong(record.name);
    if (tooLong) throw new ImportRefusedError(`Scope "${record.path}": ${tooLong}`);
    const created = await db.scope.create({
      data: { orgId: this.orgId, path, name: record.name, createdAt: new Date(record.createdAt) },
      select: { id: true },
    });
    this.created.scopes.push(created.id);
    return true;
  }

  private async writeConvention(record: Of<"convention">): Promise<void> {
    const id = this.newId(record.id);
    await db.convention.create({
      data: {
        id,
        orgId: this.orgId,
        scopePath: this.scope(record.scope),
        kind: record.kind,
        subject: record.subject,
        text: record.text,
        actorId: record.actorId,
        supersedesId: this.mapped(record.supersedesId),
        retiredAt: record.retiredAt === null ? null : new Date(record.retiredAt),
        retiredBy: record.retiredBy,
        createdAt: new Date(record.createdAt),
      },
    });
    if (record.supersededById !== null) this.lostRaces.push({ loser: id, winner: record.supersededById });
  }

  private async writeBrief(record: Of<"brief">): Promise<void> {
    await db.brief.create({
      data: {
        id: this.newId(record.id),
        orgId: this.orgId,
        type: record.briefType,
        scopePath: this.scope(record.scope),
        title: record.title,
        summary: record.summary,
        sections: (record.body.sections ?? []) as Prisma.InputJsonValue,
        milestones: (record.body.milestones ?? undefined) as Prisma.InputJsonValue | undefined,
        charts: (record.body.charts ?? undefined) as Prisma.InputJsonValue | undefined,
        decisions: (record.body.decisions ?? undefined) as Prisma.InputJsonValue | undefined,
        diagram: record.body.diagram,
        granteeName: record.body.granteeName,
        granteeRole: record.body.granteeRole,
        scopeLabel: record.body.scopeLabel,
        createdAt: new Date(record.createdAt),
        citations: {
          // A cited fact the export did not hold (a graph fact, or one outside a scoped
          // export) keeps its id and text: the citation still says what the brief rested on.
          create: record.citations.map((c) => ({
            sectionIndex: c.sectionIndex,
            factId: this.mapped(c.factId) ?? c.factId,
            factText: c.factText,
          })),
        },
        retirements: {
          create: record.retirements.map((r) => ({
            sourceId: this.mapped(r.sourceId) ?? r.sourceId,
            reason: r.reason,
            legacy: r.legacy,
            createdAt: new Date(r.createdAt),
          })),
        },
        ...(record.sourceIds.length === 0
          ? {}
          : { provenance: { create: { sourceIds: record.sourceIds.map((s) => this.mapped(s) ?? s) } } }),
      },
    });
  }

  private async writeEdge(record: Of<"edge">): Promise<void> {
    const fromId = this.mapped(record.fromId);
    const toId = this.mapped(record.toId);
    if (fromId === null || toId === null) {
      this.skippedEdges++;
      return;
    }
    const edge = await db.factEdge.create({
      select: { id: true },
      data: {
        orgId: this.orgId,
        fromId,
        toId,
        kind: record.kind,
        scopePath: this.scope(record.scope),
        actorType: record.actorType,
        actorId: record.actorId,
        createdAt: new Date(record.createdAt),
      },
    });
    this.created.edges.push(edge.id);
    this.imported.edge++;
  }

  /** Embeds and stores the facts read since the last flush, keeping their stored times. */
  async flushFacts(): Promise<void> {
    const facts = this.facts;
    if (facts.length === 0) return;
    this.facts = [];
    const [embeddings, passages] = await Promise.all([
      embedTexts(facts.map((f) => f.content)),
      Promise.all(facts.map((f) => embedPassages(f.content))),
    ]);
    const rows = facts.map((fact, i) => {
      const id = this.newId(fact.id);
      return {
        id,
        passages: passages[i]!,
        values: Prisma.sql`(
          ${id}, ${this.orgId}, ${fact.content}, ${fact.source}, ${fact.actorType}, ${fact.actorId}, ${fact.actorName},
          ${fact.entityName}, ${fact.scope === null ? null : this.scope(fact.scope)}, ${this.mapped(fact.sourceId)},
          ${fact.factVersion}, ${fact.role}::"FactRole", ${pgVec(embeddings[i]!)}::vector,
          ${fact.occurredAt === null ? null : new Date(fact.occurredAt)}, ${new Date(fact.createdAt)}
        )`,
      };
    });
    await db.$transaction([
      db.$executeRaw(
        ...flattenSql(Prisma.sql`
          INSERT INTO memory_chunks (id, "orgId", content, source, "actorType", "actorId", "actorName", "entityName",
            "scopePath", "sourceId", "factVersion", role, embedding, "occurredAt", "createdAt")
          VALUES ${Prisma.join(rows.map((r) => r.values))}`),
      ),
      ...rows.flatMap((r) => {
        const sql = insertPassagesSql(r.id, r.passages);
        return sql === null ? [] : [db.$executeRaw(...flattenSql(sql))];
      }),
    ]);
    this.imported.fact += facts.length;
  }

  /** Links each convention that lost a race to the one that won it. */
  async finish(): Promise<void> {
    if (this.file !== null) throw this.cutShort(this.file.record.id);
    await this.flushFacts();
    for (const { loser, winner } of this.lostRaces) {
      await db.convention.update({ where: { id: loser }, data: { supersededById: this.mapped(winner) } });
    }
  }
}

/**
 * Loads an export into `ctx`'s org, which must hold no memory yet. `ctx` must be a
 * person whose grant gives admin on the org root. Throws AccessDeniedError for anyone
 * else and ImportRefusedError for an org that is not empty or a file that is not a
 * complete export; in either case the org is left as it was.
 */
export async function importMemory(ctx: AccessContext, lines: AsyncIterable<string>): Promise<ImportReceipt> {
  const root = orgRootPath(ctx.orgId);
  if (ctx.actor.type !== "human") {
    const reason = "Agent tokens cannot import memory. An org admin imports it from Settings.";
    await recordRefusal(ctx, { action: "access.manage", target: `${root}:import`, auditReason: reason });
    throw new AccessDeniedError({ allowed: false, reason });
  }
  const decision = await check(ctx, { action: "access.manage", scope: root, target: `${root}:import` });
  if (!decision.allowed) throw new AccessDeniedError(decision);
  if (await holdsMemory(ctx.orgId)) {
    throw new ImportRefusedError("This org already holds memory. Import into a new, empty org.");
  }

  const writer = new ImportWriter(ctx.orgId, await loadErasedContentFilter(ctx.orgId));
  try {
    let lineNumber = 0;
    let end: EndRecord | null = null;
    let schemaVersion = 0;
    // Data records arrive in DATA_RECORD_TYPES order: an upload is judged by the passages
    // before it, so a file that puts a type back is refused rather than read out of order.
    let typeAt = 0;
    for await (const text of lines) {
      lineNumber++;
      if (text.trim() === "") continue;
      if (end !== null) throw new ImportRefusedError(`Line ${lineNumber} follows the end record.`);
      const value = parseLine(text, lineNumber);
      if (lineNumber === 1) {
        const manifest = manifestSchema.safeParse(value);
        if (!manifest.success) {
          throw new ImportRefusedError(
            `Line 1 is not a manifest of ${EXPORT_FORMAT} schema version ${EXPORT_SCHEMA_VERSION} or earlier. This is not a Willder export.`,
          );
        }
        schemaVersion = manifest.data.schemaVersion;
        continue;
      }
      if ((value as { type?: unknown })?.type === "end") {
        const parsed = endSchema.safeParse(value);
        if (!parsed.success) throw invalid(lineNumber, parsed.error);
        end = parsed.data as EndRecord;
        continue;
      }
      const record = recordSchema.safeParse(value);
      if (!record.success) throw invalid(lineNumber, record.error);
      const data = record.data;
      if (schemaVersion < 2 && (data.type.startsWith("upload") || (data.type === "fact" && data.uploadId !== null))) {
        throw new ImportRefusedError(
          `Line ${lineNumber} holds an upload, which schema version ${schemaVersion} does not have. Export again.`,
        );
      }
      if (data.type !== "upload_part" && data.type !== "upload_end") {
        const at = DATA_RECORD_TYPES.indexOf(data.type);
        if (at < typeAt) {
          throw new ImportRefusedError(
            `Line ${lineNumber} is a ${data.type} record after the ${DATA_RECORD_TYPES[typeAt]} records. Import the file exactly as the export wrote it.`,
          );
        }
        typeAt = at;
      }
      await writer.write(data);
    }
    if (lineNumber === 0) throw new ImportRefusedError("The file is empty.");
    if (end === null) throw new ImportRefusedError("The export has no end record, so it was cut short. Export again.");
    await writer.finish();

    const read: Record<string, number> = {
      ...Object.fromEntries(DATA_RECORD_TYPES.map((type) => [type, writer.imported[type] + writer.erased[type]])),
      scope: writer.scopesRead,
      upload: writer.imported.upload + writer.erased.upload + writer.uploadsWithoutFile,
      edge: writer.imported.edge + writer.skippedEdges,
      audit: writer.auditRowsNotImported,
    };
    for (const type of DATA_RECORD_TYPES) {
      if ((end.counts[type] ?? 0) !== read[type]) {
        throw new ImportRefusedError(
          `The export says it holds ${end.counts[type] ?? 0} ${type} records but held ${read[type]}. Export again.`,
        );
      }
    }
    const erasuresReapplied = await reapplyErasures(ctx).catch((cause: unknown) => {
      throw new ImportIncompleteError(cause);
    });
    return {
      imported: writer.imported,
      erased: writer.erased,
      skippedEdges: writer.skippedEdges,
      auditRowsNotImported: writer.auditRowsNotImported,
      uploadsWithoutFile: writer.uploadsWithoutFile,
      erasuresReapplied,
    };
  } catch (error) {
    await removeImported(writer);
    throw error;
  }
}
