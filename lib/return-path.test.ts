// safeReturnPath() decides where sign-in sends a person who arrived with a
// `redirect_url`: back to a page on this site, or to the dashboard. Every row below
// that is not a same-origin path must fall back, or the parameter becomes an open
// redirect off willder.ai.
import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./return-path";

describe("safeReturnPath", () => {
  it.each([
    ["/oauth/authorize?client_id=wcl_a&state=s", "/oauth/authorize?client_id=wcl_a&state=s"],
    ["/memory", "/memory"],
    [
      "/oauth/authorize?redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb",
      "/oauth/authorize?redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb",
    ],
  ])("follows the same-origin path %s", (value, expected) => {
    expect(safeReturnPath(value)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["dashboard"],
    ["https://evil.example/oauth/authorize"],
    ["//evil.example/path"],
    ["/\\evil.example/path"],
    ["/\t/evil.example/path"],
    ["javascript:alert(1)"],
    ["http:/evil.example"],
    ["/.//evil.example/x"],
    ["/..//evil.example/x"],
    ["/%2e//evil.example/x"],
    ["/./\\evil.example/x"],
  ])("falls back to the dashboard for %j", (value) => {
    expect(safeReturnPath(value)).toBe("/dashboard");
  });
});
