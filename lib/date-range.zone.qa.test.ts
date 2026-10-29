// The screen sends the start of the viewer's own day, not UTC midnight. CI runs in UTC, where
// the two are the same instant, so this file pins a zone with a real offset for its own run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setDayRangeParams } from "@/lib/date-range";

describe("setDayRangeParams in a zone that is not UTC", () => {
  let savedZone: string | undefined;
  beforeAll(() => {
    savedZone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
  });
  afterAll(() => {
    if (savedZone === undefined) delete process.env.TZ;
    else process.env.TZ = savedZone;
  });

  it("sends local midnight of the first day and of the day after the last", () => {
    const params = new URLSearchParams();
    setDayRangeParams(params, { fromDay: "2026-10-01", throughDay: "2026-10-14" });
    expect(params.get("from")).toBe("2026-10-01T07:00:00.000Z");
    expect(params.get("to")).toBe("2026-10-15T07:00:00.000Z");
  });

  it("follows the clock change inside the range: the day after November 1 starts at UTC-8", () => {
    const params = new URLSearchParams();
    setDayRangeParams(params, { fromDay: "2026-11-01", throughDay: "2026-11-01" });
    expect(params.get("from")).toBe("2026-11-01T07:00:00.000Z");
    expect(params.get("to")).toBe("2026-11-02T08:00:00.000Z");
  });
});
