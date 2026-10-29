// The rule that decides whether a candidate is a retired version: it is matched to the
// Postgres record by the chunk ids its episodes were stamped with, else by id, else — for a
// graph fact only — by normalized text within the Graphiti group it was read from, when no
// current version in that group carries that same text. Pure, so it needs no
// database — the end-to-end behaviour against persisted records is
// services/memory/conflict-read.realdb.test.ts.
import { describe, expect, it } from "vitest";
import { dropSupersededFacts, indexSupersession, supersededAt } from "./superseded-facts";

const ORG = "acme";
/** The Graphiti group a version in `org_acme.release` is stored under. */
const RELEASE = "org_acme-release";
const AT = new Date("2026-10-03T12:00:00.000Z");
const LATER = new Date("2026-10-04T09:30:00.000Z");
const fact = (uuid: string, text: string) => ({ uuid, fact: text, validAt: null });
const stamped = (uuid: string, text: string, chunkIds: string[]) => ({ ...fact(uuid, text), chunkIds });

describe("indexSupersession", () => {
  it("retires the version the record names, by id and by text", () => {
    const record = indexSupersession(ORG, [
      {
        id: "winner",
        content: "The release train leaves on Monday.",
        scopePath: "org_acme.release",
        supersededAt: null,
      },
      { id: "loser", content: "The release train leaves on Tuesday.", scopePath: "org_acme.release", supersededAt: AT },
    ]);

    expect(supersededAt(fact("loser", "unrelated text"), record)).toBe(AT.toISOString());
    expect(supersededAt(fact("graphiti-edge-1", "the release train leaves on tuesday"), record, RELEASE)).toBe(
      AT.toISOString(),
    );
    expect(supersededAt(fact("winner", "The release train leaves on Monday."), record, RELEASE)).toBeNull();
  });

  it("keeps text a current version also carries", () => {
    const record = indexSupersession(ORG, [
      { id: "winner", content: "Deploys are frozen.", scopePath: "org_acme.release", supersededAt: null },
      { id: "loser", content: "Deploys are frozen.", scopePath: "org_acme.release", supersededAt: AT },
    ]);

    expect(supersededAt(fact("graphiti-edge-1", "Deploys are frozen."), record, RELEASE)).toBeNull();
    expect(supersededAt(fact("loser", "Deploys are frozen."), record)).toBe(AT.toISOString());
  });

  it("leaves a fact the record says nothing about alone", () => {
    const record = indexSupersession(ORG, [{ id: "loser", content: "Old.", scopePath: null, supersededAt: AT }]);

    expect(dropSupersededFacts([fact("other", "Something else."), fact("x", "Old.")], record, ORG)).toEqual([
      fact("other", "Something else."),
    ]);
  });
});

describe("supersededAt, text fallback bounds", () => {
  const record = indexSupersession(ORG, [
    { id: "winner", content: "The release train leaves on Monday.", scopePath: "org_acme.release", supersededAt: null },
    { id: "loser", content: "The release train leaves on Tuesday.", scopePath: "org_acme.release", supersededAt: AT },
    { id: "ops-current", content: "Deploys are frozen.", scopePath: "org_acme.ops", supersededAt: null },
    { id: "release-loser", content: "Deploys are frozen.", scopePath: "org_acme.release", supersededAt: AT },
  ]);

  it("decides a vector-leg fact by its id alone, never by text", () => {
    // A current chunk in another scope that reads exactly like a loser.
    const current = { ...fact("chunk-in-ops", "The release train leaves on Tuesday."), store: "semantic" as const };

    expect(supersededAt(current, record, RELEASE)).toBeNull();
    expect(supersededAt({ ...current, uuid: "loser" }, record, RELEASE)).toBe(AT.toISOString());
  });

  it("matches an unstamped graph fact by text only within the group it was read from", () => {
    const graphFact = { ...fact("graphiti-edge-1", "The release train leaves on Tuesday."), store: "graph" as const };

    expect(supersededAt(graphFact, record, RELEASE)).toBe(AT.toISOString());
    expect(supersededAt(graphFact, record, "org_acme-ops")).toBeNull();
    expect(supersededAt(graphFact, record, ORG)).toBeNull();
  });

  it("does not match by text when the group is unknown", () => {
    expect(supersededAt(fact("graphiti-edge-1", "The release train leaves on Tuesday."), record)).toBeNull();
  });

  it("exempts text only from a current version in the same group", () => {
    // Current in ops, retired in release: hidden in release, kept in ops.
    expect(supersededAt(fact("graphiti-edge-2", "Deploys are frozen."), record, RELEASE)).toBe(AT.toISOString());
    expect(supersededAt(fact("graphiti-edge-2", "Deploys are frozen."), record, "org_acme-ops")).toBeNull();
  });

  it("files a version with no scope under the bare org's group", () => {
    const unscoped = indexSupersession(ORG, [{ id: "old", content: "Old.", scopePath: null, supersededAt: AT }]);

    expect(supersededAt(fact("graphiti-edge-3", "Old."), unscoped, ORG)).toBe(AT.toISOString());
    expect(supersededAt(fact("graphiti-edge-3", "Old."), unscoped, RELEASE)).toBeNull();
  });
});

describe("supersededAt, for a graph fact stamped with its chunks", () => {
  const record = indexSupersession(ORG, [
    { id: "winner", content: "The release train leaves on Monday.", scopePath: "org_acme.release", supersededAt: null },
    { id: "loser", content: "The release train leaves on Tuesday.", scopePath: "org_acme.release", supersededAt: AT },
    { id: "loser-2", content: "The train goes Wednesday.", scopePath: "org_acme.release", supersededAt: LATER },
  ]);

  it("retires a fact whose only chunk lost, whatever words the extractor chose", () => {
    // Graphiti rewrites the sentence it distils, so its text matches no stored version.
    const extracted = stamped("graphiti-edge-1", "Release train departure: Tuesday", ["loser"]);

    expect(supersededAt(extracted, record)).toBe(AT.toISOString());
  });

  it("keeps a fact while any chunk behind it is current", () => {
    expect(supersededAt(stamped("graphiti-edge-1", "Departs Tuesday", ["loser", "winner"]), record)).toBeNull();
  });

  it("dates a fact every chunk of which lost by the last of them to be retired", () => {
    expect(supersededAt(stamped("graphiti-edge-1", "Departs midweek", ["loser", "loser-2"]), record)).toBe(
      LATER.toISOString(),
    );
  });

  it("trusts the stamp over a text match: a current chunk keeps a fact that reads like a loser", () => {
    const fact = stamped("graphiti-edge-1", "The release train leaves on Tuesday.", ["winner"]);

    expect(dropSupersededFacts([fact], record, RELEASE)).toEqual([fact]);
  });
});
