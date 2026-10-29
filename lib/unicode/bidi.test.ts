import { describe, expect, it } from "vitest";
import { containsBidiControl, escapeBidiControls } from "./bidi";

const CONTROLS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

describe("containsBidiControl", () => {
  it.each(CONTROLS.map((cp) => [cp.toString(16)]))("finds U+%s", (hex) => {
    expect(containsBidiControl(`Sys${String.fromCodePoint(parseInt(hex, 16))}tem`)).toBe(true);
  });

  it("ignores ordinary text, right-to-left letters and other invisible characters", () => {
    expect(containsBidiControl("System")).toBe(false);
    expect(containsBidiControl("نظام")).toBe(false);
    expect(containsBidiControl("Sys​tem")).toBe(false);
  });
});

describe("escapeBidiControls", () => {
  it("shows each control as its code point, in stored order", () => {
    expect(escapeBidiControls("‮metsyS‬ Agent")).toBe("[U+202E]metsyS[U+202C] Agent");
    expect(escapeBidiControls("a؜b")).toBe("a[U+061C]b");
  });

  it("leaves text without controls unchanged", () => {
    expect(escapeBidiControls("QA agent Agent")).toBe("QA agent Agent");
  });
});
