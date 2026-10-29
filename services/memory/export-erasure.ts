// Which export records an org's person erasures cover: the one rule the export and the
// import share (docs/export-format.md, "Erased content").
//
// The rule: a record the export of an org would leave out because an erasure covers it is
// never written into that org by an import either. An import is a restore, and an export
// taken before an erasure still names the person; imported again, its rows keep their
// original `createdAt`, so the org's suppression list (services/memory/erasure-suppression.ts)
// recognizes them as old copies. Each kind is judged by the fields the erasure itself
// matches (services/memory/person-erasure.ts): a fact by its text, the name it is filed
// under, or its id being a version the erasure removed; a rule by its subject and text, or
// its id being one the erasure redacted; a brief by its text columns (plus its scope label,
// which the erasure does not read), or by any fact it cites, through that citation's stored
// text or the cited version's id. A working note is judged by its task and body, as the
// export's read filter judges it. An upload is judged by its filename, as text and as a
// record's own name, as the erasure marks it (services/memory/uploads.ts,
// markUploadsNamingPerson); its other half, a passage of it that names the person, is
// judged where the passages are read (org-export.ts and org-import.ts), since the record
// does not hold them. A passage of an upload is judged as written when its file was uploaded
// (`passageWrittenAt`): it holds the file's text, however long after the upload it was
// extracted. Scopes, sources and audit rows carry no content an erasure removes, so
// they are never covered. An edge is judged by its two ends, which the import does as it
// links them.
import type { ErasedContentFilter } from "./erasure-suppression";
import type {
  BriefRecord,
  ConventionRecord,
  DataRecord,
  FactRecord,
  UploadRecord,
  WorkingNoteRecord,
} from "./export-format";

/**
 * The fields of a record the rule reads: an exported record, or one an import parsed.
 */
export type JudgedRecord =
  | Pick<FactRecord, "type" | "id" | "content" | "entityName" | "createdAt">
  | Pick<ConventionRecord, "type" | "id" | "subject" | "text" | "createdAt">
  | Pick<WorkingNoteRecord, "type" | "task" | "body" | "createdAt">
  | (Pick<BriefRecord, "type" | "title" | "summary" | "citations" | "createdAt"> & {
      body: Partial<BriefRecord["body"]>;
    })
  | Pick<UploadRecord, "type" | "filename" | "createdAt">
  | { type: Exclude<DataRecord["type"], "fact" | "convention" | "working_note" | "brief" | "upload"> };

/**
 * Whether an erasure in the org `erased` was loaded for covers `record`: a copy written
 * at or before the erasure of a person it names. Exported ids are the source org's own,
 * so an id match only ever fires when the record is read in, or imported back into, the
 * org it came from.
 */
export function erasureCovers(erased: ErasedContentFilter, record: JudgedRecord): boolean {
  switch (record.type) {
    case "fact":
      return erased(record.content, new Date(record.createdAt), record.entityName, record.id);
    case "convention": {
      const writtenAt = new Date(record.createdAt);
      return (
        erased.byRuleId(record.id, writtenAt) || erased(`${record.subject}\n${record.text}`, writtenAt, record.subject)
      );
    }
    case "working_note":
      return erased(`${record.task}\n${record.body}`, new Date(record.createdAt));
    case "brief": {
      const writtenAt = new Date(record.createdAt);
      return (
        erased(briefText(record), writtenAt) ||
        record.citations.some((c) => erased(c.factText, writtenAt, null, c.factId))
      );
    }
    case "upload": {
      const writtenAt = new Date(record.createdAt);
      return erased(record.filename, writtenAt) || erased.byRecordName(record.filename, writtenAt);
    }
    case "scope":
    case "source":
    case "edge":
    case "audit":
      return false;
  }
}

/**
 * When a passage counts as written for {@link erasureCovers}: when its upload was made, if
 * that is earlier than when the passage itself was stored. A passage holds its file's text,
 * so one extracted after an erasure from a file uploaded before it is an old copy, as the
 * file is. `uploadedAt` is null for a passage of no upload, or of one whose record is gone.
 */
export function passageWrittenAt(storedAt: Date, uploadedAt: Date | null): Date {
  return uploadedAt !== null && uploadedAt < storedAt ? uploadedAt : storedAt;
}

/**
 * A brief's text as the erasure reads it (person-erasure.ts, briefNamesPerson): its text
 * columns as stored, one per line, and its JSON columns as JSON. A diagram or grantee name
 * is read as written, never JSON-escaped, so a line break before a name stays a break and
 * does not run into the name as "\\n".
 */
function briefText(record: { title: string; summary: string; body: Partial<BriefRecord["body"]> }): string {
  const { body } = record;
  const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value));
  return [
    record.title,
    record.summary,
    json(body.sections),
    body.diagram,
    body.granteeName,
    body.granteeRole,
    json(body.milestones),
    json(body.charts),
    json(body.decisions),
    body.scopeLabel,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}
