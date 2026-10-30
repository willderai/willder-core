import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hostedDeploymentMarker, isLocalInstallOrg, LOCAL_DEV_ORG_KEY, SELFHOST_ORG_KEYS } from "./selfhost-install";

const NO_MARKERS = {};

describe("isLocalInstallOrg", () => {
  it("is true for each local install org key in a process with no hosted marker", () => {
    for (const key of [SELFHOST_ORG_KEYS.default, SELFHOST_ORG_KEYS.smoke, LOCAL_DEV_ORG_KEY]) {
      expect(isLocalInstallOrg(key, NO_MARKERS)).toBe(true);
    }
  });

  it("is false for a Clerk org id, a missing id and a near miss", () => {
    for (const key of [
      "org_2abc",
      null,
      undefined,
      "",
      "Self-hosted",
      "self-hosted ",
      "local-dev-x",
      "org_self-hosted",
    ]) {
      expect(isLocalInstallOrg(key, NO_MARKERS)).toBe(false);
    }
  });

  it("is false on a hosted deployment, whatever the key", () => {
    const hosted = [
      { VERCEL: "1" },
      { VERCEL_ENV: "production" },
      { CLERK_SECRET_KEY: "sk_live_abc" },
      { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_abc" },
    ];
    for (const env of hosted) {
      expect(hostedDeploymentMarker(env)).not.toBeNull();
      expect(isLocalInstallOrg(SELFHOST_ORG_KEYS.default, env)).toBe(false);
      expect(isLocalInstallOrg(LOCAL_DEV_ORG_KEY, env)).toBe(false);
    }
  });

  it("ignores test-mode Clerk keys, NODE_ENV and empty markers", () => {
    const env = {
      CLERK_SECRET_KEY: "sk_test_abc",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_abc",
      NODE_ENV: "production",
      VERCEL: "",
    };
    expect(hostedDeploymentMarker(env)).toBeNull();
    expect(isLocalInstallOrg(SELFHOST_ORG_KEYS.default, env)).toBe(true);
  });

  it("names the same hosted markers the self-host scripts refuse to run under", () => {
    const guard = readFileSync(path.resolve(__dirname, "../scripts/lib/local-database-guard.ts"), "utf8");
    for (const marker of ["env.VERCEL || env.VERCEL_ENV", 'startsWith("sk_live_")', 'startsWith("pk_live_")']) {
      expect(guard).toContain(marker);
    }
  });
});
