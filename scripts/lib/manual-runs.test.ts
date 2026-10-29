// Covers the ledger that records the half of the client matrix no script can
// check. These rules are the whole value of the file: an incomplete entry is
// not a run, and a run on another commit does not carry forward.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCommitId, parseManualRuns, runFor, type ManualRun } from "./manual-runs";

const COMPLETE: ManualRun = {
  client: "cursor",
  who: "A Person",
  when: "2026-10-05T18:00:00Z",
  deployedCommit: "1a2b3c4d",
  clientVersion: "1.2.3",
  saw: "10 tools; memory_query answered with a cited fact",
};

describe("parseManualRuns", () => {
  it("accepts an entry with every field filled", () => {
    const ledger = parseManualRuns(JSON.stringify({ runs: [COMPLETE] }));
    expect(ledger.runs).toHaveLength(1);
    expect(ledger.rejected).toHaveLength(0);
  });

  // Every field carries part of the claim, so each one is required on its own:
  // a run with no `who` is nobody's run, and a run with no `saw` says nothing.
  // The reason says which field, because a rejected entry is something a person
  // has to come back and fix.
  it.each(["client", "who", "when", "deployedCommit", "clientVersion", "saw"] as const)(
    "rejects an entry with no %s, as a missing field",
    (field) => {
      const { [field]: removed, ...without } = COMPLETE;
      expect(removed).toBeDefined();
      const ledger = parseManualRuns(JSON.stringify({ runs: [without] }));
      expect(ledger.runs).toHaveLength(0);
      expect(ledger.rejected[0].reason).toBe(`missing ${field}`);
    },
  );

  it.each(["client", "who", "when", "deployedCommit", "clientVersion", "saw"] as const)(
    "rejects an entry whose %s is blank, as a missing field",
    (field) => {
      const ledger = parseManualRuns(JSON.stringify({ runs: [{ ...COMPLETE, [field]: "   " }] }));
      expect(ledger.runs).toHaveLength(0);
      expect(ledger.rejected[0].reason).toBe(`missing ${field}`);
    },
  );

  it("rejects an entry whose field is not a string at all", () => {
    const ledger = parseManualRuns(JSON.stringify({ runs: [{ ...COMPLETE, clientVersion: 123 }] }));
    expect(ledger.runs).toHaveLength(0);
    expect(ledger.rejected[0].reason).toBe("missing clientVersion");
  });

  // `Date.parse` is not this check: it accepts every one of these.
  it.each(["last Tuesday", "1", "October 5", "2026", "2026-10-05", "2026-10-05 18:00:00"])(
    "rejects %o as a recorded instant",
    (when) => {
      const ledger = parseManualRuns(JSON.stringify({ runs: [{ ...COMPLETE, when }] }));
      expect(ledger.runs).toHaveLength(0);
      expect(ledger.rejected[0].reason).toContain("ISO 8601");
    },
  );

  it.each(["2026-10-05T18:00:00Z", "2026-10-05T18:00Z", "2026-10-05T18:00:00.123Z", "2026-10-05T18:00:00+02:00"])(
    "accepts %o as a recorded instant",
    (when) => {
      expect(parseManualRuns(JSON.stringify({ runs: [{ ...COMPLETE, when }] })).runs).toHaveLength(1);
    },
  );

  // A one-character commit id is a prefix of a sixteenth of the repository, so
  // accepting it would make the deployed-commit rule match anything.
  it.each(["2", "1a2b", "1a2b3c4", "not-hex-at-all", "1A2B3C4D", `${"a".repeat(41)}`])(
    "rejects %o as a deployed commit, because it does not name one commit",
    (deployedCommit) => {
      const ledger = parseManualRuns(JSON.stringify({ runs: [{ ...COMPLETE, deployedCommit }] }));
      expect(ledger.runs).toHaveLength(0);
      expect(ledger.rejected[0].reason).toContain("deployedCommit");
    },
  );

  it("reads the committed ledger", () => {
    const ledger = parseManualRuns(
      readFileSync(join(__dirname, "..", "..", "docs", "connect", "manual-runs.json"), "utf8"),
    );
    expect(ledger.rejected).toHaveLength(0);
  });
});

describe("runFor", () => {
  const ledger = parseManualRuns(JSON.stringify({ runs: [COMPLETE] }));

  it("finds the run for this client on the commit under test", () => {
    expect(runFor(ledger, "cursor", "1a2b3c4d5e6f")?.who).toBe("A Person");
  });

  it("does not carry a run forward to another commit", () => {
    expect(runFor(ledger, "cursor", "0d0c0b0a")).toBeUndefined();
  });

  it("does not lend one client's run to another", () => {
    expect(runFor(ledger, "windsurf", "1a2b3c4d")).toBeUndefined();
  });

  it("finds a run recorded against a longer form of the commit under test", () => {
    const longForm = parseManualRuns(
      JSON.stringify({ runs: [{ ...COMPLETE, deployedCommit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" }] }),
    );
    expect(runFor(longForm, "cursor", "1a2b3c4d")?.who).toBe("A Person");
  });

  it("matches nothing when the commit under test is too short to name one commit", () => {
    const longForm = parseManualRuns(
      JSON.stringify({ runs: [{ ...COMPLETE, deployedCommit: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d" }] }),
    );
    expect(runFor(longForm, "cursor", "2")).toBeUndefined();
    expect(runFor(longForm, "cursor", "1a2b3c4")).toBeUndefined();
  });

  it("returns the most recent run when a client was run more than once on the commit", () => {
    const twice = parseManualRuns(
      JSON.stringify({
        runs: [
          { ...COMPLETE, when: "2026-10-01T09:00:00Z", saw: "the earlier run" },
          { ...COMPLETE, when: "2026-10-05T18:00:00Z", saw: "the later run" },
        ],
      }),
    );
    expect(runFor(twice, "cursor", "1a2b3c4d")?.saw).toBe("the later run");
  });
});

describe("isCommitId", () => {
  it("accepts the short and full forms git itself prints", () => {
    expect(isCommitId("1a2b3c4d")).toBe(true);
    expect(isCommitId("1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d")).toBe(true);
  });
});
