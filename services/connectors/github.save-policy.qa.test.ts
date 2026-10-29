// The GitHub save policy: a secret lands in every
// kind of text a sync saves, not only the README, docs, commits and comments
// the main fixture seeds, and the scan knows the credential shapes developers
// most often paste into a repository.

import { afterEach, describe, expect, it, vi } from "vitest";
import { listRepositoryItems } from "./github";
import { scanForSecrets, SECRET_MARKER } from "./secret-scan";
import { fakeGitHub, gitHubReview, messyRepository, tokenShapedSecret } from "./fixtures/github";

const REPO = "example-org/lantern";
afterEach(() => vi.unstubAllGlobals());

describe("GitHub sync: a secret in any saved text is removed", () => {
  it("scans issue bodies, pull request descriptions, reviews and the file tree", async () => {
    const secret = tokenShapedSecret();
    const state = messyRepository(REPO);
    state.issues[0].body = `Log excerpt: ${secret}`;
    state.pulls[0].body = `Fixes #101. Tested with ${secret}`;
    const number = state.pulls[0].number;
    state.reviews[number] = [
      ...(state.reviews[number] ?? []),
      gitHubReview(REPO, 7999, {
        number,
        state: "APPROVED",
        body: `LGTM, rotate ${secret}`,
        submitted_at: "2026-10-14T12:00:00Z",
      }),
    ];
    state.files[`config/${secret}.txt`] = "x";
    const github = fakeGitHub(state);
    vi.stubGlobal("fetch", vi.fn(github.fetch));

    const listing = await listRepositoryItems(REPO, "test-token", {
      cursor: null,
      stored: [],
      now: Date.parse("2026-10-14T20:00:00Z"),
    });
    for (const id of [`issue-${state.issues[0].number}`, `pr-${number}`, "review-7999", "tree"]) {
      const item = listing.items.find((i) => i.id === id);
      expect(item, id).toBeDefined();
      expect(item!.text, id).not.toContain(secret);
      expect(item!.text, id).toContain(SECRET_MARKER);
    }
  });
});

// Built from parts so no literal credential sits in the repository.
const j = (...parts: string[]) => parts.join("");
const COMMON_SHAPES: [shape: string, line: string, secret: string][] = [
  [
    "a PGP private key block",
    j(
      "-----BEGIN PGP ",
      "PRIVATE KEY BLOCK-----\n",
      "lQOYBF",
      "x".repeat(60),
      "\n-----END PGP ",
      "PRIVATE KEY BLOCK-----",
    ),
    "lQOYBF",
  ],
  [
    "a Slack incoming webhook",
    j("Post alerts to https://hooks.slack.com/services/", "T0123ABCD/", "B0123ABCD/", "aB3dE5gH7jK9mN1pQ3sT5vX7"),
    " aB3dE5gH7jK9mN1pQ3sT5vX7".trim(),
  ],
  [
    "a bare npm token",
    j("npm config set //registry.npmjs.org/:_auth ", "npm_", "a1B2c3D4".repeat(4), "e5F6"),
    j("npm_", "a1B2c3D4".repeat(4), "e5F6"),
  ],
  ["a GitLab token", j("Clone with ", "glpat-", "Ab3De5Gh7Jk9Mn1Pq3St"), j("glpat-", "Ab3De5Gh7Jk9Mn1Pq3St")],
  [
    "a SendGrid key",
    j("Mail sends with ", "SG.", "a".repeat(22), ".", "b".repeat(43)),
    j("SG.", "a".repeat(22), ".", "b".repeat(43)),
  ],
];

describe("scanForSecrets: common shapes pasted into repositories", () => {
  it.each(COMMON_SHAPES)("removes %s", (_shape, line, secret) => {
    expect(scanForSecrets(line).text).not.toContain(secret);
  });
});
