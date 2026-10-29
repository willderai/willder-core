import { describe, expect, it } from "vitest";
import {
  MAX_TOUCHES,
  checkTouches,
  claimOverlapFromSettings,
  lowestCommonScope,
  overlapTitle,
  sharedList,
} from "./claim-overlap";

const A = "file:acme/app/lib/a.ts";
const B = "file:acme/app/lib/b.ts";

describe("checkTouches", () => {
  it("stores a set: duplicates once, sorted", () => {
    expect(checkTouches([B, A, B])).toEqual({ touches: [A, B], withheld: 0, refused: 0 });
  });

  it("stores a name written decomposed and composed as one node, in NFC", () => {
    const composed = "file:acme/app/docs/café.md";
    expect(checkTouches([composed.normalize("NFD"), composed])).toEqual({
      touches: [composed],
      withheld: 0,
      refused: 0,
    });
  });

  it.each([
    ["no file: prefix", "acme/app/lib/a.ts"],
    ["another node kind", "rec:fact:abc"],
    ["a repository and no path", "file:acme"],
    ["an empty segment", "file:acme/app//a.ts"],
    ["a leading slash", "file:/etc/passwd"],
    ["a . segment", "file:acme/./a.ts"],
    ["a .. segment", "file:acme/app/../a.ts"],
    ["a trailing slash", "file:acme/app/"],
    ["a backslash", "file:acme\\app\\a.ts"],
    ["a newline", "file:acme/app/a.ts\nfile:acme/app/b.ts"],
    ["a NUL", "file:acme/app/a\u0000.ts"],
    ["a lone surrogate", "file:acme/app/a\uD800.ts"],
    ["more than 512 characters", `file:acme/${"x".repeat(510)}`],
  ])("leaves out an id with %s, keeping the rest", (_case, id) => {
    expect(checkTouches([A, id])).toEqual({ touches: [A], withheld: 0, refused: 1 });
  });

  it(`refuses more than ${MAX_TOUCHES} distinct files, counting duplicates once`, () => {
    const files = Array.from({ length: MAX_TOUCHES }, (_, i) => `file:acme/app/f${i}.ts`);
    expect(checkTouches([...files, files[0]!])).toHaveProperty("touches");
    expect(checkTouches([...files, "file:acme/app/one-more.ts"])).toEqual({
      problem: expect.stringContaining(`at most ${MAX_TOUCHES}`),
    });
  });

  it.each([
    ["an email address", "file:acme/app/notes/ana@example.com.md"],
    ["a percent-encoded address", "file:acme/app/ana%40example.com"],
    ["a vendor token", "file:acme/app/ghp_" + "abcdefghijklmnopqrstuvwxyz0123.txt"],
  ])("withholds an id holding %s, and never returns it", (_case, id) => {
    expect(checkTouches([A, id])).toEqual({ touches: [A], withheld: 1, refused: 0 });
  });

  it("keeps ordinary paths, spaces and non-ASCII names included", () => {
    const ids = [
      "file:acme/app/docs/Release Notes.md",
      "file:acme/app/locales/日本語.json",
      "file:acme/app/a-b_c.d.ts",
    ];
    expect(checkTouches(ids)).toEqual({ touches: [...ids].sort(), withheld: 0, refused: 0 });
  });
});

describe("lowestCommonScope", () => {
  it.each([
    ["org_1.crew", "org_1.crew", "org_1.crew"],
    ["org_1.crew", "org_1.crew.web", "org_1.crew"],
    ["org_1.crew.web", "org_1.crew.api", "org_1.crew"],
    ["org_1.crew", "org_1.crewx", "org_1"],
    ["org_1.crew", "org_2.crew", null],
    ["org_1.crew", "not a path", null],
  ])("%s and %s meet at %s", (a, b, expected) => {
    expect(lowestCommonScope(a, b)).toBe(expected);
    expect(lowestCommonScope(b, a)).toBe(expected);
  });
});

describe("claimOverlapFromSettings", () => {
  it.each([
    [{ claimOverlap: true }, true],
    [{ claimOverlap: "true" }, false],
    [{ claimOverlap: 1 }, false],
    [{}, false],
    [null, false],
    [[true], false],
  ])("%j turns it on: %s", (settings, on) => {
    expect(claimOverlapFromSettings(settings)).toBe(on);
  });
});

describe("overlap wording", () => {
  it("names the other claim, the shared files and when it was claimed, and says it was not resolved", () => {
    const title = overlapTitle({
      task: "add the audit",
      other: { id: "note1", agentId: "north", createdAt: new Date("2026-10-17T22:10:30Z") },
      shared: [A, B, "file:acme/app/c.ts", "file:acme/app/d.ts"],
    });
    expect(title).toBe(
      `overlap detected, not resolved: claim note1 by north, claimed 22:10Z, shares 4 files: ${A}, ${B}, file:acme/app/c.ts and 1 more; this claim is on "add the audit"`,
    );
    expect(sharedList([A])).toBe(A);
  });
});
