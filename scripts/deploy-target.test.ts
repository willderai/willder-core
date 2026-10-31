// Regression coverage for deploy-errors:check's deployment selection.
//
// The failure this pins down is not a crash and not a wrong answer to the
// question asked. A check that reads the newest deployment of ANY target and
// reports on it can report on a PREVIEW build of a feature branch — printing
// "Checked 5 deployments ... CLEAN" while production sits unexamined further
// down the list. Every routine file cites this gate as THE production
// evidence, so the verdict would silently generalize to a claim it never
// tested, making every "production is clean" statement resting on it alone
// unsound.
//
// The rule these cases encode: a verdict is only ever about a deployment that
// is on the requested target AND, when a commit is named, built from it.
// Everything else is INCOMPLETE, which is not a pass.
import { describe, expect, it } from "vitest";
import { resolveDeployment, deploymentSha, sameCommit, type Deployment } from "./lib/deploy-target";

const prodSha = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c";

function deployment(over: Partial<Deployment> = {}): Deployment {
  return {
    uid: "dpl_prod",
    readyState: "READY",
    url: "your-app.vercel.app",
    target: "production",
    meta: { githubCommitSha: prodSha },
    ...over,
  };
}

// A list shape where a preview deployment sits in front of the real
// production deployment.
const listFromTheIncident: Deployment[] = [
  deployment({
    uid: "dpl_preview_connectors",
    target: null,
    url: "your-app-git-feature-branch.vercel.app",
    meta: { githubCommitSha: "11111110000000000000000000000000000000aa" },
  }),
  deployment({
    uid: "dpl_preview_2",
    target: null,
    meta: { githubCommitSha: "aaaaaaa0000000000000000000000000000000bb" },
  }),
  deployment({
    uid: "dpl_preview_3",
    target: null,
    meta: { githubCommitSha: "bbbbbbb0000000000000000000000000000000cc" },
  }),
  deployment({
    uid: "dpl_preview_4",
    target: null,
    meta: { githubCommitSha: "ccccccc0000000000000000000000000000000dd" },
  }),
  deployment({ uid: "dpl_production_real" }),
];

describe("deploy-errors:check — a verdict only covers the target it resolved", () => {
  it("skips preview builds in front of production and resolves the real one", () => {
    const r = resolveDeployment(listFromTheIncident, { target: "production" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.deployment.uid).toBe("dpl_production_real");
  });

  // A list whose newest entry is a preview must never yield a verdict about
  // that preview.
  it("never resolves a non-production deployment for a production check", () => {
    const r = resolveDeployment(listFromTheIncident, { target: "production" });
    expect(r.ok && r.deployment.target).toBe("production");
    expect(r.ok && r.deployment.uid).not.toBe("dpl_preview_connectors");
  });

  it("a preview-only list cannot produce a production verdict at all", () => {
    const previewsOnly = listFromTheIncident.filter((d) => d.target !== "production");
    const r = resolveDeployment(previewsOnly, { target: "production" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/no production deployment/i);
  });

  it("an empty list is incomplete, not clean", () => {
    const r = resolveDeployment([], { target: "production" });
    expect(r.ok).toBe(false);
  });
});

describe("deploy-errors:check — the resolved deployment must be the commit under verification", () => {
  it("accepts the deployment when the commit matches", () => {
    const r = resolveDeployment(listFromTheIncident, { target: "production", expectSha: prodSha });
    expect(r.ok).toBe(true);
  });

  it("accepts an abbreviated SHA from the caller", () => {
    const r = resolveDeployment(listFromTheIncident, { target: "production", expectSha: prodSha.slice(0, 8) });
    expect(r.ok).toBe(true);
  });

  // Production being healthy is not evidence that YOUR change is healthy, if
  // your change is not what is deployed. This is the "merged, so it must be
  // live" assumption that must never be trusted.
  it("refuses when production is live on a different commit than the one being verified", () => {
    const r = resolveDeployment(listFromTheIncident, { target: "production", expectSha: "1234567890abcdef" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not the expected/i);
  });

  it("refuses when the deployment reports no source commit", () => {
    const r = resolveDeployment([deployment({ meta: {} })], { target: "production", expectSha: prodSha });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/no source commit/i);
  });

  it("without an expected commit, resolution still succeeds and reports the SHA it saw", () => {
    const r = resolveDeployment(listFromTheIncident, { target: "production" });
    expect(r.ok && r.sha).toBe(prodSha);
  });
});

describe("commit comparison", () => {
  it("matches full against abbreviated in either direction", () => {
    expect(sameCommit(prodSha, prodSha.slice(0, 7))).toBe(true);
    expect(sameCommit(prodSha.slice(0, 7), prodSha)).toBe(true);
  });

  // A 1-2 character "prefix" would match a large share of all commits; that is
  // not a confirmation, so it is refused rather than treated as a loose match.
  it("refuses a too-short prefix instead of matching loosely", () => {
    expect(sameCommit(prodSha, "84")).toBe(false);
  });

  it("does not match a different commit", () => {
    expect(sameCommit(prodSha, "1234567")).toBe(false);
  });

  it("reads the commit from whichever provider field carries it", () => {
    expect(deploymentSha(deployment({ meta: { gitlabCommitSha: "abc1234def" } }))).toBe("abc1234def");
    expect(deploymentSha(deployment({ meta: {} }))).toBeUndefined();
  });
});
