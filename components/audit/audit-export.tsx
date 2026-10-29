"use client";

// The audit page's export control: an administrator picks a range of UTC days and a
// format, and the browser follows GET /api/audit/export's cursor to the end and saves one
// file. The rule it keeps: the file holds every page or nothing; a page that fails stops
// the download rather than saving a partial log that reads as complete.

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui";

export type AuditExportFormat = "json" | "csv";

/** Thrown when a page of the export fails; `status` is the HTTP status, 0 for no response. */
export class AuditExportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for a UTC day. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Fetches every page of an export and joins them into one file's text. `throughDay` is
 * inclusive in the picker, so the request's exclusive `to` is the day after it. CSV pages
 * concatenate as they come (only the first carries the header); JSON pages are merged
 * into one document whose `rows` holds every row.
 */
export async function downloadAuditExport(
  range: { fromDay: string; throughDay: string },
  format: AuditExportFormat,
  fetchPage: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<string> {
  const to = utcDay(new Date(Date.parse(`${range.throughDay}T00:00:00Z`) + DAY_MS));
  const base = `/api/audit/export?from=${range.fromDay}&to=${to}&format=${format}`;
  let cursor: string | null = null;
  let csv = "";
  let header: Record<string, unknown> = {};
  const rows: unknown[] = [];
  do {
    const res = await fetchPage(cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new AuditExportError(res.status, body?.error ?? `export failed with HTTP ${res.status}`);
    }
    if (format === "csv") {
      csv += await res.text();
      cursor = res.headers.get("X-Next-Cursor");
    } else {
      const {
        rows: pageRows,
        nextCursor,
        ...rest
      } = (await res.json()) as {
        rows: unknown[];
        nextCursor: string | null;
      };
      if (cursor === null) header = rest;
      rows.push(...pageRows);
      cursor = nextCursor;
    }
  } while (cursor);
  return format === "csv" ? csv : JSON.stringify({ ...header, rows }, null, 2);
}

function saveFile(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const FIELD =
  "min-h-11 rounded-xl border border-[var(--field-border)] bg-[var(--field-background)] px-3 py-2 text-sm font-normal text-fg hover:border-[var(--field-border-hover)] focus-visible:border-[var(--field-border-focus)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** The export form shown on the audit page. */
export function AuditExport({ now = new Date() }: { now?: Date }) {
  const [fromDay, setFromDay] = useState(utcDay(new Date(now.getTime() - 30 * DAY_MS)));
  const [throughDay, setThroughDay] = useState(utcDay(now));
  const [format, setFormat] = useState<AuditExportFormat>("csv");
  const [state, setState] = useState<{ status: "idle" | "working" } | { status: "error"; message: string }>({
    status: "idle",
  });

  async function onExport() {
    setState({ status: "working" });
    try {
      const text = await downloadAuditExport({ fromDay, throughDay }, format);
      saveFile(text, `audit-${fromDay}-to-${throughDay}.${format}`, format === "csv" ? "text/csv" : "application/json");
      setState({ status: "idle" });
    } catch (err) {
      const message =
        err instanceof AuditExportError && err.status === 403
          ? "Only organization admins can export the audit log."
          : err instanceof Error
            ? err.message
            : "The export failed.";
      setState({ status: "error", message });
    }
  }

  return (
    <form
      aria-label="Export audit log"
      className="flex flex-wrap items-end gap-3 text-sm text-fg-muted"
      onSubmit={(e) => {
        e.preventDefault();
        void onExport();
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-fg">From (UTC)</span>
        <input
          type="date"
          className={FIELD}
          value={fromDay}
          max={throughDay}
          required
          onChange={(e) => setFromDay(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-fg">Through (UTC)</span>
        <input
          type="date"
          className={FIELD}
          value={throughDay}
          min={fromDay}
          required
          onChange={(e) => setThroughDay(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-fg">Format</span>
        <select className={FIELD} value={format} onChange={(e) => setFormat(e.target.value as AuditExportFormat)}>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>
      </label>
      <Button type="submit" variant="ghost" size="sm" disabled={state.status === "working"} className="min-h-11 gap-2">
        <Download aria-hidden className="size-4" />
        {state.status === "working" ? "Exporting…" : "Export"}
      </Button>
      {state.status === "error" && (
        <p role="alert" className="basis-full text-danger">
          {state.message}
        </p>
      )}
    </form>
  );
}
