import { describe, expect, it } from "vitest";
import { InvalidOccurredAtError, MAX_CLOCK_SKEW_MS, parseOccurredAt } from "./occurred-at";

const NOW = new Date("2026-10-11T12:00:00.000Z");

describe("parseOccurredAt", () => {
  it.each([
    ["2026-03-11T15:10:00Z", "2026-03-11T15:10:00.000Z"],
    ["2026-03-11T15:10:00.250Z", "2026-03-11T15:10:00.250Z"],
    ["2026-03-11T15:10Z", "2026-03-11T15:10:00.000Z"],
    ["2026-03-11T08:10:00-07:00", "2026-03-11T15:10:00.000Z"],
    ["2026-03-11T15:10:00+00:00", "2026-03-11T15:10:00.000Z"],
    ["2026-03-11", "2026-03-11T00:00:00.000Z"],
    ["2024-02-29", "2024-02-29T00:00:00.000Z"],
  ])("accepts %s as %s", (input, expected) => {
    expect(parseOccurredAt(input, NOW)).toBe(expected);
  });

  it.each([
    ["no offset, so the instant is ambiguous", "2026-03-11T15:10:00"],
    ["not ISO-8601", "March 11, 2026"],
    ["a slash date", "2026/03/11"],
    ["a day the month does not have", "2026-02-30"],
    ["a day the month does not have, with a time", "2026-04-31T10:00:00Z"],
    ["the 29th of February in a common year", "2026-02-29"],
    ["an hour past 23", "2026-03-11T24:00:00Z"],
    ["a minute past 59", "2026-03-11T15:60:00Z"],
    ["a month past 12", "2026-13-01"],
    ["an empty string", ""],
    ["surrounding text", " 2026-03-11 "],
  ])("refuses %s", (_why, input) => {
    expect(() => parseOccurredAt(input, NOW)).toThrow(InvalidOccurredAtError);
  });

  it("names the accepted forms in its refusal", () => {
    expect(() => parseOccurredAt("yesterday", NOW)).toThrow(/2026-03-11T15:10:00Z/);
  });

  it("accepts a time up to the clock-skew allowance ahead of the server clock", () => {
    const edge = new Date(NOW.getTime() + MAX_CLOCK_SKEW_MS).toISOString();
    expect(parseOccurredAt(edge, NOW)).toBe(edge);
  });

  it("refuses a time further ahead than the clock-skew allowance", () => {
    const ahead = new Date(NOW.getTime() + MAX_CLOCK_SKEW_MS + 1_000).toISOString();
    expect(() => parseOccurredAt(ahead, NOW)).toThrow(/future/);
  });

  it("refuses a calendar date after today's", () => {
    expect(() => parseOccurredAt("2026-10-12", NOW)).toThrow(/future/);
  });

  it("allows five minutes of skew, no more", () => {
    expect(MAX_CLOCK_SKEW_MS).toBe(5 * 60 * 1000);
  });
});
