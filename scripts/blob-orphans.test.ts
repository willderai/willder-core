import { describe, expect, it } from "vitest";

import { findOrphans, parseBlobOrphanArgs, summarizeByOrg } from "./blob-orphans";

const NOW = new Date("2026-10-14T12:00:00Z");
const blob = (pathname: string, hoursOld: number, size = 10) => ({
  url: `https://blob.test/${pathname}`,
  pathname,
  size,
  uploadedAt: new Date(NOW.getTime() - hoursOld * 3_600_000),
});

describe("parseBlobOrphanArgs", () => {
  it("is a dry run with a one-day grace window unless told otherwise", () => {
    expect(parseBlobOrphanArgs([])).toEqual({ delete: false, list: false, graceHours: 24 });
  });

  it("reads --delete, --list and --older-than-hours", () => {
    expect(parseBlobOrphanArgs(["--delete", "--list", "--older-than-hours", "48"])).toEqual({
      delete: true,
      list: true,
      graceHours: 48,
    });
  });

  it("refuses an unknown flag or a bad window rather than guessing", () => {
    expect(() => parseBlobOrphanArgs(["--apply"])).toThrow("Unknown argument: --apply");
    expect(() => parseBlobOrphanArgs(["--older-than-hours", "0"])).toThrow("positive integer");
    expect(() => parseBlobOrphanArgs(["--older-than-hours"])).toThrow("positive integer");
  });
});

describe("findOrphans", () => {
  it("keeps only blobs older than the grace window, so a job still waiting for its blob is never touched", () => {
    const old = blob("memory/org_a/notes-r1.pdf", 25);
    const fresh = blob("sources/org_a/src_1/f1-spec-r2.pdf", 23);

    expect(findOrphans([old, fresh], NOW, 24, new Set())).toEqual([old]);
  });

  it("never reports a kept upload's blob, however old", () => {
    const kept = blob("memory/org_a/contract-r1.pdf", 24 * 90);
    const removed = blob("memory/org_a/notes-r2.pdf", 25);

    expect(findOrphans([kept, removed], NOW, 24, new Set([kept.url]))).toEqual([removed]);
  });
});

describe("summarizeByOrg", () => {
  it("counts orphans and bytes per prefix and org", () => {
    const summary = summarizeByOrg([
      blob("memory/org_a/notes-r1.pdf", 30, 100),
      blob("memory/org_a/notes-r2.pdf", 30, 50),
      blob("sources/org_b/src_1/f1-spec-r3.pdf", 30, 7),
    ]);

    expect(Object.fromEntries(summary)).toEqual({
      "memory/org_a": { count: 2, bytes: 150 },
      "sources/org_b": { count: 1, bytes: 7 },
    });
  });
});
