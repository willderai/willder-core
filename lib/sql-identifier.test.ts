import { describe, expect, it } from "vitest";
import { sqlIdentifier } from "./sql-identifier";

describe("sqlIdentifier", () => {
  it("quotes a lower-case name", () => {
    expect(sqlIdentifier("scopes_shown").sql).toBe('"scopes_shown"');
    expect(sqlIdentifier("_x1").sql).toBe('"_x1"');
  });

  it.each(["", "Sighted", "1st", "a-b", 'a"; DROP TABLE x; --', "a b", 'sighted"', "é"])("refuses %j", (name) => {
    expect(() => sqlIdentifier(name)).toThrow(/not a SQL identifier/);
  });
});
