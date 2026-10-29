// Which deployment does a "production is clean" claim actually rest on?
//
// deploy-errors:check must not use deployments[0] from an unfiltered
// /v6/deployments list: that slot can hold a PREVIEW build of a feature
// branch, so the check would print CLEAN while saying nothing whatsoever
// about production, with the real production deployment several entries
// further down. Every routine file cites this check as the production
// evidence gate, so a verdict like that would silently generalize to claims
// it never examined.
//
// Resolution is therefore explicit and refusable: pick the newest deployment
// that is actually on the requested target, and, when the caller names the
// commit it believes is live, require the resolved deployment to carry that
// commit. Anything else is INCOMPLETE (exit 2) rather than a verdict.

export type Deployment = {
  uid: string;
  readyState: string;
  url: string;
  target?: string | null;
  created?: number;
  meta?: Record<string, string | undefined>;
};

export type Resolution = { ok: true; deployment: Deployment; sha?: string } | { ok: false; reason: string };

/** The commit a deployment was built from, whichever provider field carries it. */
export function deploymentSha(d: Deployment): string | undefined {
  return d.meta?.githubCommitSha ?? d.meta?.gitlabCommitSha ?? d.meta?.bitbucketCommitSha;
}

/** True when `sha` and `expected` name the same commit, allowing either to be
 * abbreviated (a caller usually has a short SHA, the API returns the full one). */
export function sameCommit(sha: string, expected: string): boolean {
  const a = sha.toLowerCase();
  const b = expected.toLowerCase();
  if (a.length < 7 || b.length < 7) return false;
  return a.startsWith(b) || b.startsWith(a);
}

export function resolveDeployment(deployments: Deployment[], opts: { target: string; expectSha?: string }): Resolution {
  // Filter here as well as in the API query: the query parameter is the
  // provider's promise, this is ours. If the parameter is ever dropped in a
  // refactor or ignored upstream, the check goes INCOMPLETE instead of
  // quietly grading a preview build again.
  const onTarget = deployments.filter((d) => d.target === opts.target);
  if (onTarget.length === 0) {
    return {
      ok: false,
      reason:
        `no ${opts.target} deployment in the ${deployments.length} most recent for this project ` +
        `(saw targets: ${[...new Set(deployments.map((d) => String(d.target ?? "preview")))].join(", ") || "none"}). ` +
        `Nothing here supports a claim about ${opts.target}.`,
    };
  }

  // The provider returns newest first; do not re-sort on a field that may be absent.
  const deployment = onTarget[0];
  const sha = deploymentSha(deployment);

  if (opts.expectSha) {
    if (!sha) {
      return {
        ok: false,
        reason:
          `the newest ${opts.target} deployment (${deployment.uid}) reports no source commit, ` +
          `so it cannot be confirmed to be ${opts.expectSha}.`,
      };
    }
    if (!sameCommit(sha, opts.expectSha)) {
      return {
        ok: false,
        reason:
          `the newest ${opts.target} deployment (${deployment.uid}) was built from ${sha}, ` +
          `not the expected ${opts.expectSha}. The commit under verification is not what is live, ` +
          `so a clean window here says nothing about it.`,
      };
    }
  }

  return { ok: true, deployment, sha };
}
