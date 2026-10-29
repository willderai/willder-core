import { describe, expect, it } from "vitest";
import { scanForSecrets } from "@/services/connectors/secret-scan";
import {
  disconnectEffects,
  remainingRecords,
  removedSummary,
  WHAT_WE_STORE,
  type ScopeRecordCounts,
} from "./connector-data";
import type { SourceType } from "@/lib/source-lists";

const KINDS: SourceType[] = ["gdrive", "github", "slack", "figma", "posthog", "website"];

function row(
  overrides: Partial<ScopeRecordCounts & { orphans: number }> = {},
): ScopeRecordCounts & { orphans: number } {
  return {
    scopePath: "org.a",
    chunks: 0,
    syncRecords: 0,
    feedSummaries: 0,
    episodes: 0,
    facts: 0,
    verbatimNodes: 0,
    danglingFacts: 0,
    orphans: 0,
    ...overrides,
  };
}

describe("disconnectEffects", () => {
  it("says, for every kind that syncs content, that its facts, passages, feed text and briefs go", () => {
    for (const kind of KINDS.filter((k) => k !== "website")) {
      const { removed } = disconnectEffects(kind);
      expect(removed.join(" ")).toMatch(/fact and passage/);
      expect(removed.join(" ")).toMatch(/change feed/);
      expect(removed.join(" ")).toMatch(/Briefs/);
    }
  });

  it("never claims a provider revoke: every stored credential is said to still work upstream", () => {
    for (const kind of ["github", "slack", "figma", "posthog"] as const) {
      const { removed, kept } = disconnectEffects(kind);
      expect(removed.join(" ")).toMatch(/(token|API key) Willder stored/);
      expect(kept.join(" ")).toMatch(/still works at/);
      expect([...removed, ...kept].join(" ")).not.toMatch(/revoked/i);
    }
  });

  it("does not claim to delete a Drive token Willder never stores, and says where Google access ends", () => {
    const { removed, kept } = disconnectEffects("gdrive");
    expect(removed.join(" ")).toMatch(/holds no Google token/);
    expect(kept.join(" ")).toMatch(/Third-party apps and services/);
  });

  it("says shared entity names are kept, and claims nothing removed for a website", () => {
    expect(disconnectEffects("slack").kept.join(" ")).toMatch(/Names of people, companies and projects/);
    const website = disconnectEffects("website");
    expect(website.removed).toEqual(["The source stops being listed as connected."]);
    expect(website.kept.join(" ")).not.toMatch(/token|key|Names of people/);
  });

  it("has a what-we-store line for every kind", () => {
    for (const kind of KINDS) expect(WHAT_WE_STORE[kind].length).toBeGreaterThan(0);
  });

  it("says which secrets the GitHub line removes and what it keeps", () => {
    const line = WHAT_WE_STORE.github;
    expect(line).not.toMatch(/Secrets and email addresses are removed/);
    expect(line).toMatch(/recognisable secrets are removed, except in a doc's file path and link/);
    expect(line).toMatch(/a value of 8 or more characters after password=, api_key: or a similar name/);
    expect(line).toMatch(
      /Anything else is kept as written, such as a short or spaced value, or a password in a plain sentence/,
    );
  });
});

// Each clause of the GitHub what-we-store line, run through the scan every
// stored GitHub text goes through (services/connectors/github.ts storable()).
// Values are built from parts so no literal credential sits in the repository.
describe("WHAT_WE_STORE.github: the secret clause matches the scan", () => {
  const stored = (text: string) => scanForSecrets(text, { removeEmails: true }).text;
  const long = ["Zq9", "xLm42", "pWr7"].join("");

  it.each([
    ["an email address", `Ask ${["ana", "example.com"].join("@")} first`],
    ["a key in a known format", `token ${["ghp", "_", "a".repeat(36)].join("")}`],
    ["a value of 8 or more characters after password=", `DB_PASSWORD=${long}`],
    ["a value of 8 or more characters after api_key:", `api_key: ${long}`],
    ["a long bearer token", `Authorization: Bearer ${long.repeat(2)}`],
    ["a password inside a link", "postgres:" + `//admin:${long}@db.internal/app`],
  ])("removes %s", (_name, text) => {
    expect(stored(text)).not.toContain(long);
    expect(stored(text)).not.toMatch(/ghp_a|ana@/);
  });

  it.each([
    ["a short value", "password=" + long.slice(0, 7), long.slice(0, 7)],
    ["a spaced value", `password: "${long} ${long}"`, long],
    ["a password in a plain sentence", `The staging database password is ${long}, rotate it.`, long],
    ["a short bearer token", `Authorization: Bearer ${long}`, long],
  ])("keeps %s as written", (_name, text, value) => {
    expect(stored(text)).toContain(value);
  });
});

describe("removedSummary", () => {
  it("names the counts the DELETE reported", () => {
    expect(removedSummary({ retiredFacts: 1, retiredChunks: 1200 })).toBe(
      "Removed 1 fact and 1,200 passages from memory.",
    );
  });

  it("claims no count it was not given", () => {
    expect(removedSummary({})).toBe("Its content was removed from memory.");
    expect(removedSummary({ retiredFacts: 3 })).toBe("Its content was removed from memory.");
  });
});

describe("remainingRecords", () => {
  it("reads nothing left as not removable again", () => {
    expect(remainingRecords([])).toEqual({ text: "Nothing this source synced is left in memory.", retirable: false });
    expect(remainingRecords([row({ orphans: 7 })])).toEqual({
      text: "Nothing this source synced is left in memory.",
      retirable: false,
    });
  });

  it("sums every scope, counting dangling facts as facts", () => {
    const result = remainingRecords([
      row({ facts: 2, chunks: 1 }),
      row({ scopePath: "org.b", danglingFacts: 1, chunks: 4 }),
    ]);
    expect(result).toEqual({ text: "Still in memory: 3 facts, 5 passages.", retirable: true });
  });

  it("counts a leftover feed summary or sync record as something to remove", () => {
    expect(remainingRecords([row({ feedSummaries: 1 })])).toEqual({
      text: "Still in memory: 1 other record.",
      retirable: true,
    });
    expect(remainingRecords([row({ syncRecords: 2 })]).retirable).toBe(true);
  });
});
