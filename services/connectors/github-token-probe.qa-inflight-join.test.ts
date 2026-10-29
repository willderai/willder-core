// QA tests for the token probe, written by the reviewer: the in-flight join that
// lets a refresh share GitHub with a read already running. A shared read holds one
// token's repositories, so the join must never cross the cache key (who asked and
// which token), and joining must leave that read's minute-long cache in place.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedTokenRepositories } from "./github-token-probe";
import { fakeTokenGitHub, listedRepo, tokenState } from "./fixtures/github-token";

/** Token-shaped strings assembled at runtime, so no literal token sits in the repository. */
const TOKEN_A = ["gh", "p_", "A".repeat(36)].join("");
const TOKEN_B = ["gh", "p_", "B".repeat(36)].join("");

afterEach(() => vi.unstubAllGlobals());

/** Two tokens, each answered by its own fake GitHub, every answer held until `release`. */
function serveTwoTokensHeld() {
  const a = fakeTokenGitHub(tokenState([listedRepo("alice-org/secret-a")], { scopes: "repo" }));
  const b = fakeTokenGitHub(tokenState([listedRepo("bob-org/public-b")], { scopes: "repo" }));
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      await held;
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      return (auth.endsWith(TOKEN_A) ? a : b).fetch(input, init);
    }),
  );
  const listings = (github: typeof a) => github.requests.filter((r) => r.path === "/user/repos").length;
  return { release, listingsA: () => listings(a), listingsB: () => listings(b) };
}

describe("cachedTokenRepositories in-flight join (QA)", () => {
  it("never joins a read in flight under another key, refresh or not", async () => {
    const github = serveTwoTokensHeld();
    const run = Math.random();
    const keyA = `org1:alice:${run}:a`;
    const keyB = `org1:bob:${run}:b`;
    const aliceRead = cachedTokenRepositories(keyA, TOKEN_A);
    // Bob asks while Alice's read is still running: his refresh and his plain read
    // must start their own read with his token, never share hers.
    const bobRefresh = cachedTokenRepositories(keyB, TOKEN_B, { refresh: true });
    const bobPlain = cachedTokenRepositories(keyB, TOKEN_B);
    github.release();
    const [alice, bobR, bobP] = await Promise.all([aliceRead, bobRefresh, bobPlain]);
    expect(alice.repositories.map((r) => r.fullName)).toEqual(["alice-org/secret-a"]);
    expect(bobR.repositories.map((r) => r.fullName)).toEqual(["bob-org/public-b"]);
    expect(bobP.repositories.map((r) => r.fullName)).toEqual(["bob-org/public-b"]);
    // One listing per key: Bob's two requests joined each other, not Alice's.
    expect(github.listingsA()).toBe(1);
    expect(github.listingsB()).toBe(1);
  });

  it("keeps the joined read as the minute's listing once it finishes", async () => {
    const github = serveTwoTokensHeld();
    const key = `org1:alice:${Math.random()}:a`;
    const first = cachedTokenRepositories(key, TOKEN_A);
    const joined = cachedTokenRepositories(key, TOKEN_A, { refresh: true });
    github.release();
    await Promise.all([first, joined]);
    // Paging after a joined refresh reads the finished listing, not GitHub.
    await cachedTokenRepositories(key, TOKEN_A);
    expect(github.listingsA()).toBe(1);
  });
});
