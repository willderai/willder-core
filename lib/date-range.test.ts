import { describe, expect, it } from "vitest";
import { NO_DAY_RANGE, readDayRange, readTimeRangeParams, setDayRangeParams } from "./date-range";
import { withDay } from "@/components/list-controls/date-range-filter";

function rangeQuery(fromDay: string | null, throughDay: string | null): URLSearchParams {
  const params = new URLSearchParams();
  setDayRangeParams(params, { fromDay, throughDay });
  return params;
}

describe("readDayRange", () => {
  it("keeps real days and reads an impossible or malformed one as open", () => {
    expect(readDayRange("2026-10-01", "2026-10-14")).toEqual({ fromDay: "2026-10-01", throughDay: "2026-10-14" });
    expect(readDayRange("2026-02-30", "2026-10-14")).toEqual({ fromDay: null, throughDay: "2026-10-14" });
    expect(readDayRange("2026-10-01", "14/10/2026")).toEqual({ fromDay: "2026-10-01", throughDay: null });
    expect(readDayRange(null, null)).toEqual(NO_DAY_RANGE);
  });

  it("reads a first day after the last as no range, never one the route refuses", () => {
    expect(readDayRange("2026-10-15", "2026-10-14")).toEqual(NO_DAY_RANGE);
    expect(readDayRange("2026-10-14", "2026-10-14")).toEqual({ fromDay: "2026-10-14", throughDay: "2026-10-14" });
  });
});

describe("setDayRangeParams", () => {
  it("sends the local start of the first day and of the day after the last", () => {
    const params = rangeQuery("2026-10-01", "2026-10-14");
    expect(params.get("from")).toBe(new Date(2026, 9, 1).toISOString());
    expect(params.get("to")).toBe(new Date(2026, 9, 15).toISOString());
  });

  it("rolls the day after the last over a month and a year end", () => {
    expect(rangeQuery(null, "2026-12-31").get("to")).toBe(new Date(2027, 0, 1).toISOString());
    expect(rangeQuery(null, "2026-10-31").get("to")).toBe(new Date(2026, 10, 1).toISOString());
  });

  it("leaves an open end out", () => {
    expect([...rangeQuery("2026-10-01", null).keys()]).toEqual(["from"]);
    expect([...rangeQuery(null, null).keys()]).toEqual([]);
  });

  it("sends a range the route reads back as the same instants", () => {
    const sent = rangeQuery("2026-03-01", "2026-03-31");
    const read = readTimeRangeParams(sent);
    expect(read).toEqual({ from: new Date(2026, 2, 1), to: new Date(2026, 3, 1) });
  });
});

describe("readTimeRangeParams", () => {
  const read = (query: string) => readTimeRangeParams(new URLSearchParams(query));

  it("reads either end alone, or none", () => {
    expect(read("")).toEqual({ from: null, to: null });
    expect(read("from=2026-10-01")).toEqual({ from: new Date("2026-10-01T00:00:00Z"), to: null });
    expect(read("to=2026-10-01T07:00:00Z")).toEqual({ from: null, to: new Date("2026-10-01T07:00:00Z") });
    expect(read("to=2026-10-01T00:00:00-07:00")).toEqual({ from: null, to: new Date("2026-10-01T07:00:00Z") });
  });

  it("refuses a timestamp with no zone, an impossible day, and text", () => {
    expect(read("from=2026-10-01T07:00:00")).toEqual({ error: expect.stringContaining("from must be") });
    expect(read("to=2026-02-30")).toEqual({ error: expect.stringContaining("to must be") });
    expect(read("from=yesterday")).toEqual({ error: expect.stringContaining("from must be") });
  });

  it("refuses an instant past the last one the database stores, and keeps that last one", () => {
    const past = "must be no later than 9999-12-31T23:59:59.999Z";
    expect(read("to=9999-12-31T23:00:00-05:00")).toEqual({ error: `to ${past}` });
    expect(read("from=9999-12-31T23:59:59.999-00:01")).toEqual({ error: `from ${past}` });
    expect(read("to=9999-12-31T23:59:59.999Z")).toEqual({ from: null, to: new Date("9999-12-31T23:59:59.999Z") });
    expect(read("to=9999-12-31T23:59:59.999%2B05:00")).toEqual({
      from: null,
      to: new Date("9999-12-31T18:59:59.999Z"),
    });
  });

  it("refuses a from that is not before to", () => {
    expect(read("from=2026-10-02&to=2026-10-01")).toEqual({ error: "from must be earlier than to" });
    expect(read("from=2026-10-01&to=2026-10-01")).toEqual({ error: "from must be earlier than to" });
  });
});

describe("withDay", () => {
  it("sets one end and keeps the other", () => {
    expect(withDay({ fromDay: "2026-10-01", throughDay: null }, "throughDay", "2026-10-09")).toEqual({
      fromDay: "2026-10-01",
      throughDay: "2026-10-09",
    });
    expect(withDay({ fromDay: "2026-10-01", throughDay: "2026-10-09" }, "fromDay", null)).toEqual({
      fromDay: null,
      throughDay: "2026-10-09",
    });
  });

  it("clears the other end when a typed day would put the first after the last", () => {
    expect(withDay({ fromDay: null, throughDay: "2026-10-09" }, "fromDay", "2026-10-20")).toEqual({
      fromDay: "2026-10-20",
      throughDay: null,
    });
    expect(withDay({ fromDay: "2026-10-09", throughDay: null }, "throughDay", "2026-10-01")).toEqual({
      fromDay: null,
      throughDay: "2026-10-01",
    });
  });
});
