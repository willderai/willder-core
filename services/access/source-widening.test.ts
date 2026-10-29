// The widening rule on its own: who counts, and when a connect may go ahead.
// The route-level behaviour, through a real database, is in
// app/api/sources/route.widening.realdb.test.ts.
import { describe, expect, it } from "vitest";
import { computeWidening, decideWidening, type ScopeReader, type SourceReaders } from "./source-widening";

const ME = { id: "me", email: "me@acme.test", emailVerified: true };
const ANA = { id: "ana", email: "Ana@Acme.test", emailVerified: true };
const BEN = { id: "ben", email: "ben@acme.test", emailVerified: true };
const PLACEHOLDER = { id: "nomail", email: "nomail@no-email.local", emailVerified: false };
const PEOPLE: ScopeReader[] = [ME, ANA, BEN, PLACEHOLDER];
const AGENTS = ["agent-research", "agent-qa"];

const known = (...readers: Extract<SourceReaders, { kind: "known" }>["readers"]): SourceReaders => ({
  kind: "known",
  readers,
});
/** The widening when only people read the scope. */
const peopleOnly = (people: ScopeReader[], source: SourceReaders) =>
  computeWidening({ people, agents: [] }, ME.id, source);

describe("computeWidening: people", () => {
  it("counts scope readers the source does not list, matching email case-insensitively", () => {
    expect(peopleOnly(PEOPLE, known({ kind: "email", email: "ana@acme.TEST" }))).toEqual({
      status: "known",
      people: 2,
      agents: 0,
    });
  });

  it("never counts the person connecting", () => {
    expect(peopleOnly([ME], known())).toEqual({ status: "known", people: 0, agents: 0 });
  });

  it("counts a reader behind an unmappable share as widening", () => {
    expect(peopleOnly([ME, BEN], known({ kind: "unmappable" }))).toEqual({ status: "known", people: 1, agents: 0 });
  });

  it("never matches a placeholder email, even one the source lists", () => {
    expect(peopleOnly([ME, PLACEHOLDER], known({ kind: "email", email: PLACEHOLDER.email }))).toEqual({
      status: "known",
      people: 1,
      agents: 0,
    });
  });

  it("never matches an unverified email, even one the source lists", () => {
    const unverifiedAna = { ...ANA, emailVerified: false };
    expect(peopleOnly([ME, unverifiedAna], known({ kind: "email", email: ANA.email }))).toEqual({
      status: "known",
      people: 1,
      agents: 0,
    });
    expect(peopleOnly([ME, unverifiedAna], known({ kind: "domain", domain: "acme.test" }))).toEqual({
      status: "known",
      people: 1,
      agents: 0,
    });
  });

  it("counts a person whose verification is not yet known as widening", () => {
    const unknownAna = { ...ANA, emailVerified: null };
    expect(peopleOnly([ME, unknownAna], known({ kind: "email", email: ANA.email }))).toEqual({
      status: "known",
      people: 1,
      agents: 0,
    });
  });

  it("matches a discoverable domain share by email domain", () => {
    expect(peopleOnly(PEOPLE, known({ kind: "domain", domain: "acme.test" }))).toEqual({
      status: "known",
      people: 1,
      agents: 0,
    });
  });

  it("a source anyone can read widens nothing", () => {
    expect(peopleOnly(PEOPLE, known({ kind: "everyone" }))).toEqual({ status: "known", people: 0, agents: 0 });
  });

  it("an unreported source is unknown, bounded by everyone else in the scope, never zero", () => {
    expect(peopleOnly(PEOPLE, { kind: "unknown", reason: "no list" })).toEqual({
      status: "unknown",
      reason: "no list",
      atMost: 3,
      agents: 0,
    });
    expect(peopleOnly([ME], { kind: "unknown", reason: "no list" }).status).toBe("unknown");
  });
});

describe("computeWidening: agents", () => {
  it("counts every agent that can read the scope, since no agent reads the source at the source", () => {
    const everyPersonListed = known(...PEOPLE.map((p) => ({ kind: "email" as const, email: p.email })));
    expect(computeWidening({ people: [ME, ANA], agents: AGENTS }, ME.id, everyPersonListed)).toEqual({
      status: "known",
      people: 0,
      agents: 2,
    });
  });

  it("counts agents beside people, and a domain share does not cover an agent", () => {
    expect(
      computeWidening({ people: PEOPLE, agents: AGENTS }, ME.id, known({ kind: "domain", domain: "acme.test" })),
    ).toEqual({
      status: "known",
      people: 1,
      agents: 2,
    });
  });

  it("a source anyone can read widens nothing for agents either", () => {
    expect(computeWidening({ people: PEOPLE, agents: AGENTS }, ME.id, known({ kind: "everyone" }))).toEqual({
      status: "known",
      people: 0,
      agents: 0,
    });
  });

  it("an unreported source still knows its agents exactly", () => {
    expect(computeWidening({ people: [ME], agents: AGENTS }, ME.id, { kind: "unknown", reason: "r" })).toEqual({
      status: "unknown",
      reason: "r",
      atMost: 0,
      agents: 2,
    });
  });
});

describe("decideWidening", () => {
  it("goes ahead unacknowledged only when no person and no agent gains access", () => {
    expect(decideWidening({ status: "known", people: 0, agents: 0 }, undefined)).toEqual({
      proceed: true,
      path: "no_widening",
    });
  });

  it("refuses a widening above zero without both exact counts", () => {
    const widening = { status: "known" as const, people: 4, agents: 2 };
    const needed = { people: 4, agents: 2 };
    for (const given of [
      undefined,
      true,
      "yes",
      4,
      6,
      "unknown",
      { people: 4 },
      { people: 4, agents: 1 },
      { people: 3, agents: 2 },
      { people: 6, agents: 0 },
    ]) {
      expect(decideWidening(widening, given), JSON.stringify(given)).toEqual({ proceed: false, acknowledge: needed });
    }
    expect(decideWidening(widening, { people: 4, agents: 2 })).toEqual({ proceed: true, path: "acknowledged" });
  });

  it("refuses a connect that only agents gain, until those agents are acknowledged", () => {
    const widening = { status: "known" as const, people: 0, agents: 3 };
    expect(decideWidening(widening, undefined)).toEqual({ proceed: false, acknowledge: { people: 0, agents: 3 } });
    expect(decideWidening(widening, { people: 0, agents: 3 })).toEqual({ proceed: true, path: "acknowledged" });
  });

  it("refuses an unknown widening unless acknowledged as unknown with the exact agents, even with nobody else in the scope", () => {
    const unknown = { status: "unknown" as const, reason: "r", atMost: 0, agents: 1 };
    const needed = { people: "unknown", agents: 1 };
    for (const given of [undefined, 0, "unknown", { people: 0, agents: 1 }, { people: "unknown", agents: 0 }]) {
      expect(decideWidening(unknown, given), JSON.stringify(given)).toEqual({ proceed: false, acknowledge: needed });
    }
    expect(decideWidening(unknown, { people: "unknown", agents: 1 })).toEqual({
      proceed: true,
      path: "acknowledged_unknown",
    });
  });
});
