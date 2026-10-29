// The connect form's reach line names every part of
// the repository a sync now reads. The sync reads docs, the file tree, issue
// comments and pull request reviews as well as the README, issues, pull
// requests and commits (services/connectors/github.ts), and a token missing a
// permission loses those parts too, so a line naming only the old four
// understates both what the token can reach and what a missing permission skips.

import { describe, expect, it } from "vitest";
import { reachLine } from "./github-connect-form";

const REPO = "example-org/lantern";

describe("GitHub connect form: the reach line names what a sync reads", () => {
  it("with full access, names the docs, file tree, comments and reviews", () => {
    const { text } = reachLine(REPO, []);
    expect(text).toMatch(/docs/i);
    expect(text).toMatch(/file tree|file paths/i);
    expect(text).toMatch(/comment/i);
    expect(text).toMatch(/review|approval/i);
  });

  it("without Contents, says the docs and file tree are skipped with the README and commits", () => {
    expect(reachLine(REPO, ["readme", "commits"]).text).toMatch(/docs|file tree/i);
  });

  it("without Issues, says issue comments are skipped with the issues", () => {
    expect(reachLine(REPO, ["issues"]).text).toMatch(/comment/i);
  });

  it("without Pull requests, says reviews are skipped with the pull requests", () => {
    expect(reachLine(REPO, ["pulls"]).text).toMatch(/review|approval/i);
  });
});
