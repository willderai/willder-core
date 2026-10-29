import { describe, expect, it } from "vitest";
import {
  AUDIT_EXPORT_CSV_COLUMNS,
  csvCell,
  decodeExportCursor,
  encodeExportCursor,
  exportRowsToCsv,
  parseExportRange,
  takeExportPage,
  type AuditExportRow,
} from "./export";

const row = (over: Partial<AuditExportRow> = {}): AuditExportRow => ({
  id: "row-1",
  at: "2026-09-01T12:00:00.000Z",
  actorType: "human",
  actorId: "u-1",
  action: "memory.read",
  target: "org_a.team",
  decision: "allow",
  reason: null,
  metadata: {},
  runId: null,
  chainSeq: 1,
  prevHash: "0".repeat(64),
  rowHash: "a".repeat(64),
  ...over,
});

describe("parseExportRange", () => {
  it("takes from inclusive and to exclusive, as UTC instants", () => {
    expect(parseExportRange("2026-09-01", "2026-10-01T00:00:00Z")).toEqual({
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(parseExportRange("2026-09-01T09:30:00+02:00", "2026-09-01T10:00:00.250Z")).toEqual({
      from: new Date("2026-09-01T07:30:00.000Z"),
      to: new Date("2026-09-01T10:00:00.250Z"),
    });
  });

  it("requires both ends", () => {
    expect(parseExportRange(null, "2026-10-01")).toEqual({ error: expect.stringMatching(/from and to are required/) });
    expect(parseExportRange("2026-09-01", null)).toEqual({ error: expect.stringMatching(/from and to are required/) });
  });

  it.each([
    ["September 1, 2026", "2026-10-01"],
    ["2026-09-01", "1790000000000"],
    ["2026-02-30", "2026-10-01"],
    ["2026-09-01T25:00:00Z", "2026-10-01"],
    ["2026-09-01T10:00:00", "2026-10-01"],
  ])("refuses %j..%j, which is not an ISO date or a timestamp with a zone", (from, to) => {
    expect(parseExportRange(from, to)).toEqual({ error: expect.stringMatching(/ISO 8601/) });
  });

  it("refuses an empty or reversed range", () => {
    expect(parseExportRange("2026-09-01", "2026-09-01")).toEqual({ error: "from must be earlier than to" });
    expect(parseExportRange("2026-10-01", "2026-09-01")).toEqual({ error: "from must be earlier than to" });
  });
});

describe("export cursor", () => {
  it("round-trips the last row's time and id", () => {
    const cursor = encodeExportCursor({ at: new Date("2026-09-01T12:00:00.123Z"), id: 'c,1"x' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeExportCursor(cursor)).toEqual({ at: new Date("2026-09-01T12:00:00.123Z"), id: 'c,1"x' });
  });

  it.each([
    "",
    "not base64 at all!",
    Buffer.from("[1,2]").toString("base64url"),
    Buffer.from('["x","id"]').toString("base64url"),
    Buffer.from('{"at":"2026-09-01T00:00:00Z"}').toString("base64url"),
  ])("rejects a malformed cursor %j", (value) => {
    expect(decodeExportCursor(value)).toBeNull();
  });
});

describe("csvCell", () => {
  it("leaves a plain value alone", () => {
    expect(csvCell("memory.read")).toBe("memory.read");
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  it.each([
    ["a,b", '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ["line\nbreak", '"line\nbreak"'],
    ["cr\rhere", '"cr\rhere"'],
  ])("quotes %j", (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it.each([
    ['=HYPERLINK("http://x")', '\'=HYPERLINK(""http://x"")'],
    ["+1+1", "'+1+1"],
    ["-2+3", "'-2+3"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tcmd", "'\tcmd"],
    ["\rcmd", "'\rcmd"],
  ])("defuses a spreadsheet formula in %j", (value, inner) => {
    expect(csvCell(value)).toBe(`"${inner}"`);
  });

  // A spreadsheet that trims cells on import (LibreOffice's "Trim spaces", Google Sheets)
  // reads " =1+1" as a formula, and the full-width signs are the same characters to an
  // input method that normalizes them. Each is defused like its plain form.
  it.each([
    [" =1+1", "' =1+1"],
    ["  @SUM(A1)", "'  @SUM(A1)"],
    ["\u00a0-2+3", "'\u00a0-2+3"],
    ["\n=1+1", "'\n=1+1"],
    ["\uff1d1+1", "'\uff1d1+1"],
    ["\uff0b1", "'\uff0b1"],
    ["\uff0d1", "'\uff0d1"],
    ["\uff20SUM(A1)", "'\uff20SUM(A1)"],
  ])("defuses a formula hidden behind whitespace or a full-width sign in %j", (value, inner) => {
    expect(csvCell(value)).toBe(`"${inner}"`);
  });

  it("leaves a sign that does not start the cell alone", () => {
    expect(csvCell("a = b")).toBe("a = b");
    expect(csvCell("  plain")).toBe("  plain");
  });
});

describe("exportRowsToCsv", () => {
  it("writes the header only when asked, then one CRLF-terminated line per row", () => {
    const csv = exportRowsToCsv([row({ reason: 'no grant, see "policy"', metadata: { note: "a,b" } })], {
      header: true,
    });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(AUDIT_EXPORT_CSV_COLUMNS.join(","));
    expect(lines[1]).toContain('"no grant, see ""policy"""');
    expect(lines[1]).toContain('"{""note"":""a,b""}"');
    expect(lines[2]).toBe("");
    expect(exportRowsToCsv([row()], { header: false }).split("\r\n")[0]).toMatch(/^row-1,/);
  });

  it("parses back to the same cells with a standard CSV reader", () => {
    const nasty = row({ id: "r,1", target: "=cmd|' /C calc'!A0", reason: 'x\n"y"', metadata: { k: "-1" } });
    const csv = exportRowsToCsv([nasty], { header: true });
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual([...AUDIT_EXPORT_CSV_COLUMNS]);
    const cells = Object.fromEntries(AUDIT_EXPORT_CSV_COLUMNS.map((c, i) => [c, parsed[1][i]]));
    expect(cells.id).toBe("r,1");
    expect(cells.target).toBe("'=cmd|' /C calc'!A0");
    expect(cells.reason).toBe('x\n"y"');
    expect(JSON.parse(cells.metadata)).toEqual({ k: "-1" });
  });
});

describe("takeExportPage", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row({ id: `r${i}`, at: `2026-09-01T12:00:0${i}.000Z` }));

  it("returns everything with no cursor when the query held no extra row", () => {
    const page = takeExportPage(rows, { maxRows: 5, maxBytes: 1_000_000 });
    expect(page.rows.map((r) => r.id)).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(page.next).toBeNull();
  });

  it("cuts at maxRows and points the cursor at the last row kept", () => {
    const page = takeExportPage(rows, { maxRows: 3, maxBytes: 1_000_000 });
    expect(page.rows.map((r) => r.id)).toEqual(["r0", "r1", "r2"]);
    expect(page.next).toEqual({ at: new Date("2026-09-01T12:00:02.000Z"), id: "r2" });
  });

  it("cuts at the byte budget, always keeping at least one row", () => {
    const size = Buffer.byteLength(JSON.stringify(rows[0]));
    const page = takeExportPage(rows, { maxRows: 100, maxBytes: size * 2 + 5 });
    expect(page.rows).toHaveLength(2);
    expect(page.next?.id).toBe("r1");
    expect(takeExportPage(rows, { maxRows: 100, maxBytes: 1 }).rows).toHaveLength(1);
  });

  // The route budgets 1.5 MB of JSON per page and relies on CSV being at most about twice
  // that. The worst cases for that ratio: metadata made of quotes (\" in JSON, \"" in CSV),
  // metadata made of tiny keys (every structural quote doubled), and multibyte text.
  it.each([
    ["quote-heavy metadata", { q: '"'.repeat(4000) }],
    ["many tiny keys", Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`k${i}`, 1]))],
    ["multibyte text", { t: "\u00e9\u6f22\ud83d\ude00".repeat(800) }],
  ])("keeps a CSV page cut at 1.5 MB of JSON under 4.5 MB for %s", (_, metadata) => {
    const many = Array.from({ length: 2000 }, (_, i) => row({ id: `r${i}`, reason: '="x"'.repeat(50), metadata }));
    const page = takeExportPage(many, { maxRows: 1000, maxBytes: 1_500_000 });
    const csvBytes = Buffer.byteLength(exportRowsToCsv(page.rows, { header: true }));
    expect(csvBytes).toBeLessThan(4.5 * 1024 * 1024);
    expect(Buffer.byteLength(JSON.stringify(page.rows))).toBeLessThanOrEqual(1_500_000 + page.rows.length + 2);
  });
});

/** A minimal RFC 4180 reader, independent of the writer under test. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let rowCells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      rowCells.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      rowCells.push(cell);
      out.push(rowCells);
      rowCells = [];
      cell = "";
      i++;
    } else cell += ch;
  }
  return out;
}
