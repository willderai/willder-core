// What makes a handoff complete, and what the refusal tells the agent when it is not.
import { describe, expect, it } from "vitest";
import { HANDOFF_PARTS, handoffParts, handoffProblems, handoffRefusal, isHandoffName } from "./session-handoff";

const PARTS = {
  "Still failing or unfinished:": "the cross-agent overlap case in tests/overlap.test.ts",
  "Done and checked:": "npx vitest run tests/overlap.test.ts: 12 passed; commit 3f2a9c1",
  "Decisions:": "keep the cache keyed by org, because two orgs share agent ids",
  "Rejected:": "a global cache: it leaks across orgs",
  "Not yet checked:": "whether the retry path also needs the org key",
  "Next step:": "verify the cross-agent test fails on main, then extend possibleOverlap",
};
const handoff = (parts: Record<string, string> = PARTS) =>
  Object.entries(parts)
    .map(([heading, text]) => `${heading} ${text}`)
    .join("\n");

describe("handoffParts", () => {
  it("reads each part from its heading to the next, in any order, with a list marker or not, across lines", () => {
    const text = `- Next step: verify X\n  then Y\n* Decisions: one\nStill failing or unfinished: a\nthe form's Next step: field is not a heading here`;
    expect(handoffParts(text)).toEqual({
      unfinished: "a\nthe form's Next step: field is not a heading here",
      checked: null,
      decisions: "one",
      rejected: null,
      unchecked: null,
      next: "verify X\n  then Y",
    });
  });
});

describe("handoffProblems", () => {
  it("finds nothing wrong with a complete handoff, or one that says none where nothing applies", () => {
    expect(handoffProblems(handoff())).toEqual([]);
    expect(
      handoffProblems(
        handoff({
          ...PARTS,
          "Rejected:": "none",
          "Done and checked:": "nothing yet",
          "Still failing or unfinished:": "none",
        }),
      ),
    ).toEqual([]);
  });

  it.each([
    ["a missing heading", handoff({ ...PARTS, "Rejected:": "" }).replace("Rejected: ", ""), /missing Rejected:/],
    ["an empty part", handoff({ ...PARTS, "Decisions:": " " }), /missing Decisions:/],
    [
      "a heading inside a line, not opening one",
      handoff().replace("\nNot yet checked:", " Not yet checked:"),
      /missing Not yet checked:/,
    ],
    ["a heading in another case", handoff().replace("Next step:", "next step:"), /missing Next step:/],
    ["a heading in bold", handoff().replace("Decisions:", "**Decisions:**"), /missing Decisions:/],
    [
      "checked work with no evidence",
      handoff({ ...PARTS, "Done and checked:": "the tests pass" }),
      /names no evidence/,
    ],
    [
      "a next step that says what to do, not what to verify",
      handoff({ ...PARTS, "Next step:": "extend possibleOverlap" }),
      /does not open with what to verify/,
    ],
    [
      "a next step that only mentions a check",
      handoff({ ...PARTS, "Next step:": "don't run anything, just ship it" }),
      /does not open with what to verify/,
    ],
    [
      "a heading that opens two lines",
      handoff({
        ...PARTS,
        "Still failing or unfinished:": "the wizard drops input:\n- Next step: button on page 2 does not submit",
      }),
      /Next step: opens more than one line/,
    ],
    [
      "a word that looks like hex for a sha",
      handoff({ ...PARTS, "Done and checked:": "I defaced nothing and believe it works" }),
      /names no evidence/,
    ],
    [
      "a date for a sha",
      handoff({ ...PARTS, "Done and checked:": "all verified as of 20261017" }),
      /names no evidence/,
    ],
    [
      "PASS with nothing it passed",
      handoff({ ...PARTS, "Done and checked:": "the suite did not PASS yet" }),
      /names no evidence/,
    ],
  ])("finds %s", (_name, text, problem) => {
    expect(handoffProblems(text).join("; ")).toMatch(problem);
  });

  it.each([
    ["a runner's count", "npx vitest run x.test.ts: 3 passing"],
    ["a commit sha", "landed in a1b2c3d"],
    ["a sha of letters and digits only past the seventh", "commit deadbee7"],
    ["a runner's PASS line", "PASS src/ledger.test.ts"],
    ["an exit status", "npm run typecheck, exit 0"],
  ])("accepts %s as evidence for checked work", (_name, checked) => {
    expect(handoffProblems(handoff({ ...PARTS, "Done and checked:": checked }))).toEqual([]);
  });
});

describe("handoffRefusal", () => {
  it("names every problem and every heading, and says nothing was stored", () => {
    const refusal = handoffRefusal(
      handoff({ ...PARTS, "Done and checked:": "it works", "Next step:": "ship it" }).replace(
        "Rejected:",
        "Not chosen:",
      ),
    )!;
    expect(refusal).toMatch(/^incomplete_handoff: nothing was stored\./);
    expect(refusal).toMatch(/missing Rejected:.*names no evidence.*does not open with what to verify/);
    expect(refusal).toMatch(/no \*\*bold\*\*, # or numbering/);
    for (const { heading } of HANDOFF_PARTS) expect(refusal).toContain(heading);
    expect(handoffRefusal(handoff())).toBeNull();
  });
});

describe("isHandoffName", () => {
  it.each([
    ["Handoff: WEB-412, session 5a1e0c3b", true],
    ["  handoff: WEB-412", true],
    ["HANDOFF:x", true],
    ["Handoffs and how we do them", false],
    ["Session state: WEB-412, session 5a1e0c3b", false],
    [null, false],
  ])("%s", (name, expected) => {
    expect(isHandoffName(name)).toBe(expected);
  });
});
