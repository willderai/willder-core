import { describe, expect, it } from "vitest";
import { missingEnv, parseFileEpisodeStampArgs } from "./backfill-file-episode-stamps";

describe("backfill-file-episode-stamps arguments", () => {
  it("is a dry run by default", () => {
    expect(parseFileEpisodeStampArgs([])).toEqual({ apply: false });
  });

  it("applies only with a board decision id", () => {
    expect(parseFileEpisodeStampArgs(["--apply", "--decision", "approval-w3c-backfill-20261024"])).toEqual({
      apply: true,
      decisionId: "approval-w3c-backfill-20261024",
    });
    expect(() => parseFileEpisodeStampArgs(["--apply"])).toThrow(/--decision/);
    for (const id of ["yes", "approval-", "approval-w3c", "decision-w3c-20261024", "approval-W3C-20261024"]) {
      expect(() => parseFileEpisodeStampArgs(["--apply", "--decision", id])).toThrow(/--decision/);
    }
  });

  it("refuses a decision without --apply, so a run never looks approved that wrote nothing", () => {
    expect(() => parseFileEpisodeStampArgs(["--decision", "approval-w3c-backfill-20261024"])).toThrow(/--apply/);
  });

  it("takes --org and --page-size, and refuses anything else", () => {
    expect(parseFileEpisodeStampArgs(["--org", "org1", "--page-size", "50"])).toEqual({
      apply: false,
      orgId: "org1",
      pageSize: 50,
    });
    expect(() => parseFileEpisodeStampArgs(["--page-size", "501"])).toThrow(/1 to 500/);
    expect(() => parseFileEpisodeStampArgs(["--org"])).toThrow(/Org.id/);
    expect(() => parseFileEpisodeStampArgs(["--force"])).toThrow(/unknown argument/);
  });

  it("needs the database and the memory service even for a dry run, which reads both", () => {
    expect(missingEnv({})).toBe("DATABASE_URL and GRAPHITI_SERVICE_URL and GRAPHITI_SERVICE_API_KEY are not set");
    expect(missingEnv({ DATABASE_URL: "x", GRAPHITI_SERVICE_URL: "y", GRAPHITI_SERVICE_API_KEY: "z" })).toBeNull();
  });
});
