// GET /api/audit/export: an administrator's copy of the org's audit log for a date range,
// as JSON or CSV, one bounded page per request.
//
// Same gate as the audit page (access.manage on the org root), taken through check() so
// every export request, allowed or refused, is itself an audit row naming the range. A
// refusal says only that it was refused: no scope, no reason text.
//
// Query: `from` (inclusive) and `to` (exclusive), ISO dates or timestamps with a zone;
// `format` = `json` (default) or `csv`; `cursor` from the previous page. A JSON page
// carries `nextCursor`; a CSV page carries it in the `X-Next-Cursor` header and writes
// the header line only on the first page, so pages concatenate into one file. Absent or
// null means the range is complete.
import { NextResponse } from "next/server";
import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { queryAuditExportRows } from "@/services/access/audit-query";
import {
  decodeExportCursor,
  encodeExportCursor,
  exportRowsToCsv,
  parseExportRange,
  takeExportPage,
  type AuditExportRow,
} from "@/services/audit/export";
import { AuditRetentionConfigError, auditRetentionPolicy } from "@/services/audit/retention";

export const dynamic = "force-dynamic";

/** Rows per page. */
const MAX_ROWS = 1000;
/**
 * Serialized JSON per page. CSV doubles every quote inside metadata, so a CSV page is at
 * most about twice this: still under the 4.5 MB a Vercel function may return.
 */
const MAX_BYTES = 1_500_000;

export async function GET(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });
  }
  const range = parseExportRange(url.searchParams.get("from"), url.searchParams.get("to"));
  if ("error" in range) return NextResponse.json({ error: range.error }, { status: 400 });
  const cursorParam = url.searchParams.get("cursor");
  const after = cursorParam === null ? null : decodeExportCursor(cursorParam);
  if (cursorParam !== null && !after) {
    return NextResponse.json({ error: "cursor is not one this endpoint returned" }, { status: 400 });
  }

  const { from, to } = range;
  const decision = await check(rc.ctx, {
    action: "access.manage",
    target: `audit:export:${from.toISOString()}..${to.toISOString()}`,
  });
  if (!decision.allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let retention;
  try {
    retention = auditRetentionPolicy();
  } catch (err) {
    if (err instanceof AuditRetentionConfigError) {
      return NextResponse.json({ error: err.message }, { status: 500 });
    }
    throw err;
  }

  const dbRows = await queryAuditExportRows({ orgId: rc.org.id, from, to, after, limit: MAX_ROWS + 1 });
  const rows: AuditExportRow[] = dbRows.map((r) => ({ ...r, at: r.at.toISOString() }));
  const page = takeExportPage(rows, { maxRows: MAX_ROWS, maxBytes: MAX_BYTES });
  const nextCursor = page.next ? encodeExportCursor(page.next) : null;

  if (format === "csv") {
    const headers: Record<string, string> = {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    };
    if (nextCursor) headers["X-Next-Cursor"] = nextCursor;
    return new Response(exportRowsToCsv(page.rows, { header: after === null }), { status: 200, headers });
  }

  return NextResponse.json(
    {
      from: from.toISOString(),
      to: to.toISOString(),
      retention,
      rows: page.rows,
      nextCursor,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
