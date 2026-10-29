// The audit log export: an administrator's copy of every audit row an org recorded in a
// date range, as JSON or CSV, one bounded page at a time.
//
// The one rule this file enforces: a page never grows past a byte budget well under the
// 4.5 MB a Vercel function may return, so any range exports in full by following the
// cursor, and nothing in a CSV cell is ever read by a spreadsheet as a formula.
//
// This module is pure: the route (app/api/audit/export/route.ts) authorizes and queries,
// and this file parses the range, shapes rows, encodes the cursor and writes CSV.

/** One exported audit row. `at` is an ISO 8601 UTC timestamp. */
export interface AuditExportRow {
  id: string;
  at: string;
  actorType: string;
  actorId: string;
  action: string;
  target: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  metadata: unknown;
  runId: string | null;
  /** The row's position in its org's hash chain; null on rows written before the chain. */
  chainSeq: number | null;
  prevHash: string | null;
  rowHash: string | null;
}

/** CSV column order. `metadata` is last and holds the row's metadata as JSON. */
export const AUDIT_EXPORT_CSV_COLUMNS = [
  "id",
  "at",
  "actorType",
  "actorId",
  "action",
  "target",
  "decision",
  "reason",
  "runId",
  "chainSeq",
  "prevHash",
  "rowHash",
  "metadata",
] as const satisfies readonly (keyof AuditExportRow)[];

/** Where the next page starts: strictly after this row in (at, id) order. */
export interface AuditExportCursor {
  at: Date;
  id: string;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,3})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** A calendar date that exists: rejects 2026-02-30, which `Date` would roll into March. */
function isRealDate(year: string, month: string, day: string): boolean {
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return d.getUTCFullYear() === Number(year) && d.getUTCMonth() === Number(month) - 1 && d.getUTCDate() === Number(day);
}

/** An ISO date (midnight UTC) or an ISO timestamp with an explicit zone; null otherwise. */
export function parseInstant(value: string): Date | null {
  const match = DATE_ONLY.exec(value) ?? DATE_TIME.exec(value);
  if (!match || !isRealDate(match[1], match[2], match[3])) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Parses the export's range: `from` inclusive, `to` exclusive, so consecutive ranges
 * never export a row twice. Each end is an ISO date (taken as midnight UTC) or an ISO
 * timestamp with a zone; a timestamp without one is refused rather than read in the
 * server's local time.
 */
export function parseExportRange(
  fromParam: string | null,
  toParam: string | null,
): { from: Date; to: Date } | { error: string } {
  if (!fromParam || !toParam) {
    return { error: "from and to are required, e.g. from=2026-09-01&to=2026-10-01" };
  }
  const from = parseInstant(fromParam);
  const to = parseInstant(toParam);
  if (!from || !to) {
    return {
      error: "from and to must be ISO 8601 dates or timestamps with a zone, e.g. 2026-09-01 or 2026-09-01T12:00:00Z",
    };
  }
  if (from >= to) return { error: "from must be earlier than to" };
  return { from, to };
}

/** The opaque cursor a page hands back for the next one. */
export function encodeExportCursor(cursor: AuditExportCursor): string {
  return Buffer.from(JSON.stringify([cursor.at.toISOString(), cursor.id])).toString("base64url");
}

/** Decodes a cursor from {@link encodeExportCursor}; null when it is not one. */
export function decodeExportCursor(value: string): AuditExportCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2) return null;
    const [at, id] = decoded;
    if (typeof at !== "string" || typeof id !== "string" || id === "") return null;
    const date = new Date(at);
    if (Number.isNaN(date.getTime()) || date.toISOString() !== at) return null;
    return { at: date, id };
  } catch {
    return null;
  }
}

/**
 * Keeps rows, in order, until `maxRows` or `maxBytes` of serialized JSON would be
 * exceeded, always keeping at least one. The caller queries `maxRows + 1` rows, so a
 * row left over means the range continues and `next` points after the last row kept.
 */
export function takeExportPage(
  rows: readonly AuditExportRow[],
  limits: { maxRows: number; maxBytes: number },
): { rows: AuditExportRow[]; next: AuditExportCursor | null } {
  const kept: AuditExportRow[] = [];
  let bytes = 0;
  for (const r of rows) {
    if (kept.length === limits.maxRows) break;
    const size = Buffer.byteLength(JSON.stringify(r));
    if (kept.length > 0 && bytes + size > limits.maxBytes) break;
    kept.push(r);
    bytes += size;
  }
  const last = kept[kept.length - 1];
  const next = kept.length < rows.length && last ? { at: new Date(last.at), id: last.id } : null;
  return { rows: kept, next };
}

/**
 * A cell a spreadsheet may read as a formula (OWASP CSV injection): one starting with a
 * tab or line break, or with `=`, `+`, `-` or `@` (plain or full-width) after any leading
 * whitespace, since spreadsheets that trim cells on import evaluate " =1+1".
 */
const FORMULA_START = /^[\t\r\n]|^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/;

/**
 * One RFC 4180 cell. A value a spreadsheet would evaluate as a formula is prefixed with
 * `'` so it is shown as text; any value holding a comma, quote, line break or that prefix
 * is quoted, with quotes doubled.
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  const defused = typeof value === "string" && FORMULA_START.test(text);
  if (defused) text = `'${text}`;
  if (defused || /[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Rows as CSV lines ending in CRLF, with the header line first when `header` is set. */
export function exportRowsToCsv(rows: readonly AuditExportRow[], options: { header: boolean }): string {
  const lines = rows.map((r) =>
    AUDIT_EXPORT_CSV_COLUMNS.map((column) =>
      csvCell(column === "metadata" ? JSON.stringify(r.metadata ?? {}) : r[column]),
    ).join(","),
  );
  if (options.header) lines.unshift(AUDIT_EXPORT_CSV_COLUMNS.join(","));
  return lines.map((line) => `${line}\r\n`).join("");
}
