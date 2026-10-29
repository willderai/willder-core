// The Willder export format: the record shapes an export writes and an import reads,
// one JSON object per line (docs/export-format.md is the reader's guide to it).
//
// The one rule: a record carries what the memory IS, never how this deployment stores
// it. No embeddings (an import computes its own from the text), no capability tokens or
// connector credentials, and every scope path relative to the exporting org's root, so
// the same file imports into any org. An upload is the one record that carries bytes: its
// raw file follows it as base64 parts, because the file has no other home.

/** The `format` every export's manifest names. */
export const EXPORT_FORMAT = "willder-export";

/** Raw bytes per `upload_part`, at most: 64 KiB once base64-encoded. Bounds the file an export or import holds at once. */
export const UPLOAD_PART_BYTES = 48 * 1024;

/** Bumped when a record shape changes in a way an older reader would misread. */
export const EXPORT_SCHEMA_VERSION = 2;

/**
 * A scope as an export writes it: the exporting org's root is `""`, a child of it is
 * `"sales"`, a grandchild `"sales.eu"`. Untagged rows (no scope) are `null`. The import
 * prefixes the target org's root, so a path never names the org it came from.
 */
export type RelativeScope = string | null;

/** First line of every export. */
export interface ManifestRecord {
  type: "manifest";
  format: typeof EXPORT_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  /** "org" when the exporter could read every scope, "scopes" when only some. */
  coverage: "org" | "scopes";
  /** The scopes the export covers, relative to the root; `[""]` for a whole org. */
  scopes: string[];
}

/** Last line of every export. An export without it was cut short and must not be imported. */
export interface EndRecord {
  type: "end";
  /** Records written per type, manifest and end excluded. */
  counts: Record<DataRecord["type"], number>;
}

export interface ScopeRecord {
  type: "scope";
  path: string;
  name: string;
  createdAt: string;
}

/** One stored version of a fact. Every version is exported, superseded ones included. */
export interface FactRecord {
  type: "fact";
  id: string;
  scope: RelativeScope;
  content: string;
  /** The entity the fact is about, when its writer named one. */
  entityName: string | null;
  /** Whether this row is a version of the fact `entityName` names (services/memory/conflict.ts). */
  factVersion: boolean;
  role: string | null;
  source: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  /** The exported source this fact was synced from, by its export id. */
  sourceId: string | null;
  /**
   * The upload this passage was extracted from, by its export id, when the reader may read
   * that upload. Absent before schema version 2.
   */
  uploadId: string | null;
  occurredAt: string | null;
  createdAt: string;
}

/** A rule or decision, every version, with the one it replaced. */
export interface ConventionRecord {
  type: "convention";
  id: string;
  scope: string;
  kind: string;
  subject: string;
  text: string;
  actorId: string;
  supersedesId: string | null;
  supersededById: string | null;
  retiredAt: string | null;
  retiredBy: string | null;
  createdAt: string;
}

export interface WorkingNoteRecord {
  type: "working_note";
  id: string;
  scope: string;
  agentId: string;
  task: string;
  kind: string;
  body: string;
  expiresAt: string;
  releasedAt: string | null;
  createdAt: string;
}

export interface BriefRecord {
  type: "brief";
  id: string;
  scope: string;
  briefType: string;
  title: string;
  summary: string;
  /** The brief's content as stored: sections, milestones, charts, decisions, diagram. */
  body: {
    sections: unknown;
    milestones: unknown;
    charts: unknown;
    decisions: unknown;
    diagram: string | null;
    granteeName: string | null;
    granteeRole: string | null;
    scopeLabel: string | null;
  };
  /** Facts the brief cites, by section. `factId` is an export fact id when the fact was exported. */
  citations: { sectionIndex: number; factId: string; factText: string }[];
  /** Sources the brief was written from, by export id. */
  sourceIds: string[];
  /** Why the brief stopped being current: a source it rested on changed or was removed. */
  retirements: { sourceId: string; reason: string; legacy: boolean; createdAt: string }[];
  createdAt: string;
}

/** One edge of the dependency graph between records (services/memory/edges.ts). */
export interface EdgeRecord {
  type: "edge";
  fromId: string;
  toId: string;
  kind: string;
  scope: string;
  actorType: string;
  actorId: string;
  createdAt: string;
}

/** A connected source and the files it synced. Credentials are never exported. */
export interface SourceRecord {
  type: "source";
  id: string;
  scope: string;
  sourceType: string;
  externalId: string;
  name: string;
  files: { externalFileId: string; checksum: string; syncedAt: string }[];
  createdAt: string;
}

/**
 * A file a person uploaded. When `file` is "follows", its raw file is the `upload_part`
 * lines right after it, then one `upload_end`. "missing" means the upload is kept but its
 * raw file could not be found, so no bytes follow and an import cannot restore it.
 */
export interface UploadRecord {
  type: "upload";
  id: string;
  scope: string;
  filename: string;
  fileType: string;
  /** The person who uploaded it, by their id in the exporting deployment. */
  actorId: string;
  file: "follows" | "missing";
  createdAt: string;
}

/** One piece of an upload's raw file, in order from `index` 0, as standard base64. */
export interface UploadPartRecord {
  type: "upload_part";
  uploadId: string;
  index: number;
  data: string;
}

/** Closes an upload's raw file: how many parts and bytes it held and their SHA-256, in hex. */
export interface UploadEndRecord {
  type: "upload_end";
  uploadId: string;
  parts: number;
  bytes: number;
  sha256: string;
}

/** One audit row. Exported for the record; an import never writes another org's history. */
export interface AuditRecord {
  type: "audit";
  id: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  decision: string;
  reason: string | null;
  at: string;
}

export type DataRecord =
  | ScopeRecord
  | FactRecord
  | ConventionRecord
  | WorkingNoteRecord
  | BriefRecord
  | EdgeRecord
  | SourceRecord
  | UploadRecord
  | AuditRecord;

/** The lines that carry an upload's raw file. Not data records: an end record does not count them. */
export type UploadFileRecord = UploadPartRecord | UploadEndRecord;

export type ExportRecord = ManifestRecord | DataRecord | UploadFileRecord | EndRecord;

/**
 * Every data record type, in the order an export writes them. A record refers only to records
 * before it, with two exceptions linked once both exist: a convention's `supersededById`, and a
 * fact's `uploadId`. Uploads follow the facts because an upload is judged by its passages: one
 * an erasure covers takes the whole file out, so its raw file is never written.
 */
export const DATA_RECORD_TYPES = [
  "scope",
  "source",
  "fact",
  "upload",
  "convention",
  "working_note",
  "brief",
  "edge",
  "audit",
] as const satisfies readonly DataRecord["type"][];

/** `scopePath` relative to `root`, or null when it is not inside it. */
export function relativeScope(scopePath: string, root: string): string | null {
  if (scopePath === root) return "";
  return scopePath.startsWith(`${root}.`) ? scopePath.slice(root.length + 1) : null;
}

/** The inverse of {@link relativeScope}: `relative` placed under `root`. */
export function absoluteScope(relative: string, root: string): string {
  return relative === "" ? root : `${root}.${relative}`;
}
