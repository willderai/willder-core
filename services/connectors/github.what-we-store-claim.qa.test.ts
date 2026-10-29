// The GitHub what-we-store line, shown on the
// connect form and on every GitHub source card, promises only what the sync
// does. The secret scan removes credentials by their published shapes and in
// recognisable places (secret-scan.ts says so itself); a credential written in
// plain prose has no shape and is stored as written, so the line must not say
// that secrets, without qualification, are removed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { WHAT_WE_STORE } from "@/components/settings/connector-data";
import { listRepositoryItems } from "./github";
import { fakeGitHub, messyRepository } from "./fixtures/github";

const REPO = "example-org/lantern";
afterEach(() => vi.unstubAllGlobals());

// Built from parts so no literal credential sits in the repository.
const PROSE_PASSWORD = ["Zq9", "xLm42", "pWr7"].join("");

describe("GitHub what-we-store line: the secret claim matches the scan", () => {
  it("a password written in prose in an issue is stored as written", async () => {
    const state = messyRepository(REPO);
    state.issues[0].body = `The staging database password is ${PROSE_PASSWORD}, rotate it after the demo.`;
    vi.stubGlobal("fetch", vi.fn(fakeGitHub(state).fetch));

    const listing = await listRepositoryItems(REPO, "test-token", {
      cursor: null,
      stored: [],
      now: Date.parse("2026-10-14T20:00:00Z"),
    });
    const issue = listing.items.find((i) => i.id === `issue-${state.issues[0].number}`);
    expect(issue).toBeDefined();
    // The scan's documented limit: no shape, no removal.
    expect(issue!.text).toContain(PROSE_PASSWORD);
  });

  it("so the line names what the scan removes instead of promising every secret", () => {
    const sentence = WHAT_WE_STORE.github.split(/(?<=\.)\s+/).find((s) => /secret|credential|key|token/i.test(s));
    expect(sentence, "the line says something about secrets").toBeDefined();
    // A qualified claim names the limit: known formats or shapes, recognisable places.
    expect(sentence).toMatch(/format|shape|known|recogni|pattern/i);
  });
});
