import { describe, expect, it } from "vitest";
import confusables from "./confusables.json";
import { CONFUSABLES_VERSION, confusableSkeleton } from "./skeleton";

describe("confusableSkeleton", () => {
  it("records which Unicode release its data came from", () => {
    expect(CONFUSABLES_VERSION).toBe("18.0.0");
    expect(confusables.source).toBe("https://www.unicode.org/Public/18.0.0/security/confusables.txt");
    expect(confusables.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(confusables.prototypes)).toHaveLength(6712);
  });

  it.each([
    ["systеm", "Cyrillic small ie"],
    ["ѕуѕtеm", "several Cyrillic letters"],
    ["ｓｙｓｔｅｍ", "fullwidth letters"],
    ["sys​tem", "a zero-width space"],
    ["sys‮tem", "a bidi override"],
    ["sys­tem", "a soft hyphen"],
    ["ꜱystem", "Latin small capital s"],
  ])('%j (%s) has the skeleton of plain "system"', (lookalike) => {
    expect(confusableSkeleton(lookalike)).toBe(confusableSkeleton("system"));
  });

  it("folds a capital lookalike to the capital it imitates", () => {
    expect(confusableSkeleton("Ѕystem")).toBe(confusableSkeleton("System"));
  });

  it("keeps case, since some lookalikes exist only as capitals", () => {
    expect(confusableSkeleton("Н")).toBe("H");
    expect(confusableSkeleton("QА")).toBe(confusableSkeleton("QA"));
  });

  it("leaves names that only share letters apart", () => {
    expect(confusableSkeleton("research")).not.toBe(confusableSkeleton("reseach"));
    expect(confusableSkeleton("QA agent")).not.toBe(confusableSkeleton("QB agent"));
  });
});
