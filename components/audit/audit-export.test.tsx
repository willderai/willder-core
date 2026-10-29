// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AuditExport, AuditExportError, downloadAuditExport } from "./audit-export";

const jsonPage = (rows: unknown[], nextCursor: string | null) =>
  new Response(
    JSON.stringify({ from: "f", to: "t", retention: { keep: "forever", floorDays: 184 }, rows, nextCursor }),
    {
      status: 200,
    },
  );

describe("downloadAuditExport", () => {
  it("asks for the day after the last picked day, since the API's to is exclusive", async () => {
    const fetchPage = vi.fn().mockResolvedValue(jsonPage([], null));
    await downloadAuditExport({ fromDay: "2026-09-01", throughDay: "2026-09-30" }, "json", fetchPage);
    expect(fetchPage).toHaveBeenCalledWith("/api/audit/export?from=2026-09-01&to=2026-10-01&format=json");
  });

  it("follows the JSON cursor and merges every page into one document", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(jsonPage([{ id: "a" }, { id: "b" }], "c+/1"))
      .mockResolvedValueOnce(jsonPage([{ id: "c" }], null));
    const text = await downloadAuditExport({ fromDay: "2026-09-01", throughDay: "2026-09-01" }, "json", fetchPage);
    expect(fetchPage.mock.calls[1][0]).toBe(
      "/api/audit/export?from=2026-09-01&to=2026-09-02&format=json&cursor=c%2B%2F1",
    );
    const doc = JSON.parse(text);
    expect(doc.rows).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
    expect(doc.retention).toEqual({ keep: "forever", floorDays: 184 });
    expect(doc).not.toHaveProperty("nextCursor");
  });

  it("concatenates CSV pages by the X-Next-Cursor header", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(new Response("id,at\r\na,1\r\n", { headers: { "X-Next-Cursor": "k" } }))
      .mockResolvedValueOnce(new Response("b,2\r\n"));
    const text = await downloadAuditExport({ fromDay: "2026-09-01", throughDay: "2026-09-01" }, "csv", fetchPage);
    expect(text).toBe("id,at\r\na,1\r\nb,2\r\n");
  });

  it("fails the whole download when any page fails, rather than saving part of the log", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce(jsonPage([{ id: "a" }], "k"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await expect(
      downloadAuditExport({ fromDay: "2026-09-01", throughDay: "2026-09-01" }, "json", fetchPage),
    ).rejects.toEqual(new AuditExportError(500, "boom"));
  });
});

describe("AuditExport", () => {
  it("tells a non-admin plainly that only admins can export", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    );
    render(<AuditExport now={new Date("2026-10-06T12:00:00Z")} />);
    expect((screen.getByLabelText("From (UTC)") as HTMLInputElement).value).toBe("2026-09-06");
    expect((screen.getByLabelText("Through (UTC)") as HTMLInputElement).value).toBe("2026-10-06");
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Only organization admins can export the audit log.",
    );
    vi.unstubAllGlobals();
  });
});
