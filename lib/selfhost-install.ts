// Which orgs belong to a self-hosted or local install rather than to the hosted
// willder.ai service, so hosted billing limits (the free plan's lifetime episode cap,
// services/guardrails.ts checkEpisodeCap) are not applied to someone running Willder on
// their own infrastructure.
//
// The one rule: it fails closed to "hosted". An org counts as a local install's only when
// both hold:
//   1. its `clerkOrgId` is one of the fixed keys the local scripts create orgs under (the
//      self-host bootstrap's ensureSelfhostOperator, and mintLocalDevToken). Clerk's org ids
//      all start with `org_`, so no org a hosted deployment synced from Clerk can hold one; and
//   2. the process shows none of the markers only a hosted deployment carries: a Vercel
//      environment, or a live Clerk key. These are the same markers the self-host scripts
//      refuse to run under (scripts/lib/local-database-guard.ts selfhostTargetRefusal).
// Anything else, including an org with no `clerkOrgId`, is treated as hosted and capped.
//
// Kept free of imports so the local scripts and the services can both read the keys.

/** The `clerkOrgId` keys of the orgs the self-host scripts create (ensureSelfhostOperator). */
export const SELFHOST_ORG_KEYS = {
  /** The org a self-hosted install works in. */
  default: "self-hosted",
  /** The org `npm run selfhost:smoke` writes its probes to. */
  smoke: "self-hosted-smoke",
} as const;

/** The `clerkOrgId` key of the org `scripts/dev-token.ts` creates on a fresh local install. */
export const LOCAL_DEV_ORG_KEY = "local-dev";

const LOCAL_INSTALL_ORG_KEYS: ReadonlySet<string> = new Set([
  SELFHOST_ORG_KEYS.default,
  SELFHOST_ORG_KEYS.smoke,
  LOCAL_DEV_ORG_KEY,
]);

/**
 * The marker that shows this process is a hosted deployment, or null when it shows none.
 * Mirrors the hosted refusals of selfhostTargetRefusal (scripts/lib/local-database-guard.ts).
 * NODE_ENV is deliberately not one: a self-hoster may run the server in production mode.
 */
export function hostedDeploymentMarker(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL || env.VERCEL_ENV) return "this is a Vercel environment";
  if (env.CLERK_SECRET_KEY?.trim().startsWith("sk_live_")) return "CLERK_SECRET_KEY is a production Clerk key";
  if (env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim().startsWith("pk_live_")) {
    return "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is a production Clerk key";
  }
  return null;
}

/**
 * True when the org keyed `clerkOrgId` is a self-hosted or local install's org and this
 * process is not a hosted deployment, so hosted plan limits do not apply to it. False in
 * every other case (see the rule at the top of this file).
 */
export function isLocalInstallOrg(
  clerkOrgId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!clerkOrgId || !LOCAL_INSTALL_ORG_KEYS.has(clerkOrgId)) return false;
  return hostedDeploymentMarker(env) === null;
}
