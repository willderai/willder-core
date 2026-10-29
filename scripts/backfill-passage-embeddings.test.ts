// The passage backfill's command line (scripts/backfill-passage-embeddings.ts). The
// backfill itself is tested against Postgres in services/memory/passage-backfill.realdb.test.ts.
import { describe, expect, it } from "vitest";
import { describeFailure, missingEnv, parsePassageBackfillArgs } from "./backfill-passage-embeddings";

describe("parsePassageBackfillArgs", () => {
  it("is a dry run unless --apply is given", () => {
    expect(parsePassageBackfillArgs([])).toEqual({ apply: false });
    expect(
      parsePassageBackfillArgs(["--apply", "--org", "org1", "--rate", "5", "--max-rows", "200", "--page-size", "50"]),
    ).toEqual({
      apply: true,
      orgId: "org1",
      maxEmbeddingsPerSecond: 5,
      maxRows: 200,
      pageSize: 50,
    });
  });

  it("refuses an unknown flag, a missing org and a rate that is not a positive integer", () => {
    expect(() => parsePassageBackfillArgs(["--yes"])).toThrow(/unknown argument "--yes"/);
    expect(() => parsePassageBackfillArgs(["--org"])).toThrow(/--org needs an Org.id/);
    expect(() => parsePassageBackfillArgs(["--rate", "0"])).toThrow(/--rate must be an integer from 1 to 1000/);
    expect(() => parsePassageBackfillArgs(["--rate", "2.5"])).toThrow(/--rate must be an integer/);
  });
});

describe("missingEnv", () => {
  it("needs only the database to count, and the memory service too to write", () => {
    expect(missingEnv({ DATABASE_URL: "postgres://x" }, false)).toBeNull();
    expect(missingEnv({ DATABASE_URL: "postgres://x" }, true)).toBe(
      "GRAPHITI_SERVICE_URL and GRAPHITI_SERVICE_API_KEY are not set",
    );
  });
});

describe("describeFailure", () => {
  it("names a database error by class and code only", () => {
    const error = Object.assign(new Error("Key (content)=(secret text) already exists"), {
      name: "PrismaClientKnownRequestError",
      code: "P2010",
    });
    expect(describeFailure(error)).toBe("database error PrismaClientKnownRequestError P2010");
  });
});
