// The run-tag rule on its own: which strings are one run's tag, and which facts carry it.
import { describe, expect, it } from "vitest";
import { RUN_TAG_PATTERN, carriesRunTag } from "./run-tag";

describe("a run tag names one run of one measure", () => {
  it("accepts a lowercase prefix, a hyphen and a 12- or 14-digit start", () => {
    for (const tag of ["ltload-202610052130", "ltload-20261005213000", "ltconflict-202610052130"]) {
      expect(RUN_TAG_PATTERN.test(tag), tag).toBe(true);
    }
  });

  it("refuses a tag whose timestamp is missing, short, long or not digits, so it cannot name many runs", () => {
    for (const tag of [
      "ltload",
      "ltload-",
      "ltload-2026",
      "ltload-20261005",
      "ltload-2026100521300",
      "ltload-202610052130000",
      "ltload-2026100521300x",
    ]) {
      expect(RUN_TAG_PATTERN.test(tag), tag).toBe(false);
    }
  });

  it("refuses uppercase, a leading digit, LIKE wildcards and a nested hyphen in the prefix", () => {
    for (const tag of [
      "Ltload-202610052130",
      "2load-202610052130",
      "lt_load-202610052130",
      "lt%-202610052130",
      "lt-load-202610052130",
    ]) {
      expect(RUN_TAG_PATTERN.test(tag), tag).toBe(false);
    }
  });
});

describe("a fact is the run's only when its name and its text both carry the tag", () => {
  const tag = "ltload-202610052130";

  it("holds for the tag as the name, or the tag and a hyphen as its prefix, with the tag in the text", () => {
    expect(carriesRunTag(tag, tag, `${tag} fact`)).toBe(true);
    expect(carriesRunTag(tag, `${tag}-writer-1`, `note from ${tag}`)).toBe(true);
  });

  it("fails when either half is missing", () => {
    expect(carriesRunTag(tag, `${tag}-writer-1`, "a note without the tag")).toBe(false);
    expect(carriesRunTag(tag, "team-notes", `a note quoting ${tag}`)).toBe(false);
    expect(carriesRunTag(tag, null, `${tag}`)).toBe(false);
    expect(carriesRunTag(tag, undefined, `${tag}`)).toBe(false);
  });

  it("does not claim a 14-digit run's facts for the 12-digit tag it starts with", () => {
    const longer = `${tag}00`;
    expect(carriesRunTag(tag, `${longer}-writer-1`, `${longer} fact`)).toBe(false);
    expect(carriesRunTag(tag, `${tag}0`, `${tag}0 fact`)).toBe(false);
  });
});
