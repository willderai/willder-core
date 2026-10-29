import { describe, expect, it } from "vitest";

import { matchWhere } from "./db-where.testsupport";

// The fake the access-boundary suites filter through, so its rules get
// pinned here rather than only where they are used: an absent key broadens
// rather than matching nothing, an unmodelled key throws rather than being
// ignored, and neither side of the `===` -- the clause's value or the column's
// -- may be a value it cannot compare.
type Row = { orgId: string; scopePath: string; sourceId: string | null };

const ROWS: Row[] = [
  { orgId: "org_1", scopePath: "org_1.eng", sourceId: "src_a" },
  { orgId: "org_1", scopePath: "org_1.eng", sourceId: "src_b" },
  { orgId: "org_2", scopePath: "org_2.eng", sourceId: "src_a" },
];

const MODELLED = ["orgId", "scopePath", "sourceId"] as const;

describe("matchWhere", () => {
  it("applies every key the clause carries", () => {
    expect(matchWhere(ROWS, { orgId: "org_1", sourceId: "src_a" }, MODELLED)).toEqual([ROWS[0]]);
  });

  // The whole point: a handler that stops passing a predicate must match MORE
  // rows, not none, so the boundary case guarding that predicate can fail.
  it("stops constraining a key the clause omits, rather than matching nothing", () => {
    expect(matchWhere(ROWS, { sourceId: "src_a" }, MODELLED)).toEqual([ROWS[0], ROWS[2]]);
  });

  it("matches everything for an empty clause", () => {
    expect(matchWhere(ROWS, {}, MODELLED)).toEqual(ROWS);
  });

  it("models a null column value as an ordinary equality", () => {
    const withNull: Row[] = [...ROWS, { orgId: "org_1", scopePath: "org_1.eng", sourceId: null }];
    expect(matchWhere(withNull, { sourceId: null }, MODELLED)).toEqual([withNull[3]]);
  });

  it("throws on a key it does not model, naming the key", () => {
    expect(() => matchWhere(ROWS, { orgId: "org_1", actorType: "human" }, MODELLED)).toThrow(/actorType/);
  });

  it("names every unmodelled key, not just the first", () => {
    expect(() => matchWhere(ROWS, { actorType: "human", at: new Date() }, MODELLED)).toThrow(/actorType, at/);
  });

  // The same silence one level deeper: the key IS modelled, so the throw above
  // never fires, but `===` against an operator object matches no row at all --
  // the fail-closed accident again, one level down.
  // `services/memory/source-retirement.ts` already passes a neighbouring query
  // `{ not: null }`, so this is reachable here, not hypothetical.
  it("throws on a Prisma operator object on a modelled key, naming the key and the operator", () => {
    expect(() => matchWhere(ROWS, { sourceId: { in: ["src_a"] } }, MODELLED)).toThrow(
      /"sourceId": a Prisma operator object \(in\)/,
    );
  });

  it("names every operator the clause carries on that key", () => {
    expect(() => matchWhere(ROWS, { scopePath: { startsWith: "org_1", not: null } }, MODELLED)).toThrow(
      /"scopePath": a Prisma operator object \(startsWith, not\)/,
    );
  });

  // Checked before filtering, not inside it: an empty fixture must not be able
  // to skip the check and leave the clause looking like an honest zero-row miss.
  it("throws on an operator clause even when the fixture has no rows", () => {
    expect(() => matchWhere([] as Row[], { sourceId: { in: ["src_a"] } }, MODELLED)).toThrow(/"sourceId"/);
  });

  // Widened past the operator case deliberately: `===` is just as unreliable on
  // any other non-primitive, and each one misses silently in exactly the same
  // way. An array is not valid Prisma at all; a Date is, and compares by
  // reference, so an equal-but-distinct one matches nothing.
  it("throws on an array value", () => {
    expect(() => matchWhere(ROWS, { sourceId: ["src_a", "src_b"] }, MODELLED)).toThrow(/"sourceId": an array/);
  });

  it("throws on a Date rather than comparing it by reference", () => {
    const at = new Date("2026-09-23T00:00:00Z");
    expect(() => matchWhere([{ at }], { at: new Date(at) }, ["at"])).toThrow(/"at": a Date/);
  });

  // The same silence one level deeper again. The rule above reads the CLAUSE;
  // it cannot see the COLUMN. A Date column compared against a primitive the
  // clause is entitled to carry -- Prisma accepts an ISO string for a DateTime
  // field -- passes that rule and then matches no row, because `===` never
  // equates a Date with a string. Real Prisma returns the row, so the zero rows
  // are the fail-closed accident once more.
  it("throws on a Date column compared against a primitive, rather than matching nothing", () => {
    const at = new Date("2026-09-23T00:00:00Z");
    expect(() => matchWhere([{ at }], { at: at.toISOString() }, ["at"])).toThrow(/column value on "at": a Date/);
  });

  // Only for a key the clause actually carries: an uncompared column is never
  // this accident, and the real fixtures are full of them -- ALL_BRIEFS in
  // services/access/brief-scope-leak.eval.test.ts carries both a `createdAt`
  // Date and a `sections` array, and models neither.
  it("leaves a Date column alone when the clause does not carry that key", () => {
    const rows = [{ at: new Date("2026-09-23T00:00:00Z"), id: "row_1" }];
    expect(matchWhere(rows, { id: "row_1" }, ["at", "id"])).toEqual(rows);
  });

  // `null` is the one non-primitive `===` compares correctly, and it is real
  // Prisma (`{ revokedAt: null }`), so it keeps working against a Date column
  // rather than being swept up as uncomparable.
  it("still compares a Date column against a null clause value", () => {
    const rows = [{ at: new Date("2026-09-23T00:00:00Z") }, { at: null }];
    expect(matchWhere(rows, { at: null }, ["at"])).toEqual([rows[1]]);
  });

  // `undefined` still means "the clause does not carry this key", which is the
  // broadening the first rule depends on -- it must not be caught by the above.
  it("treats an explicitly undefined value as an absent key, not an uncomparable one", () => {
    expect(matchWhere(ROWS, { orgId: "org_1", sourceId: undefined }, MODELLED)).toEqual([ROWS[0], ROWS[1]]);
  });
});
