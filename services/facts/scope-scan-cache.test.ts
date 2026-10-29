import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REMOVAL_AUDIT_ACTIONS } from "@/services/access";
import type { ScopeCacheStamp } from "@/services/access";
import { getCachedScan, scanFingerprint, setCachedScan } from "./scope-scan-cache";

// Random-ish keys per test (same convention as lib/rate-limit.test.ts) so
// nothing needs to reset the module's shared in-memory store between tests.
const briefId = () => `brief_${Math.random()}`;
const STAMP_A: ScopeCacheStamp = { erasureEpoch: "0", changeCount: "1" };
const STAMP_B: ScopeCacheStamp = { ...STAMP_A, changeCount: "2" };
// Fingerprints, under the names the tests below were written against.
const CHANGES_A = STAMP_A;
const CHANGES_B = STAMP_B;
const changesFingerprint = scanFingerprint;

describe("scope-scan-cache", () => {
  it("misses on a brief that has never been scanned", () => {
    expect(getCachedScan(briefId(), changesFingerprint(CHANGES_A))).toBeUndefined();
  });

  it("hits when the same brief is queried again with the same changed-fact set", () => {
    const id = briefId();
    const found = [{ factA: "a", factB: "b", note: "n" }];
    setCachedScan(id, changesFingerprint(CHANGES_A), found);
    expect(getCachedScan(id, changesFingerprint(CHANGES_A))).toEqual(found);
  });

  it("misses once the changed-fact set differs — a new write invalidates the cache", () => {
    const id = briefId();
    setCachedScan(id, changesFingerprint(CHANGES_A), [{ factA: "a", factB: "b", note: "n" }]);
    expect(getCachedScan(id, changesFingerprint(CHANGES_B))).toBeUndefined();
  });

  it("caches a genuine zero-contradiction result too, not just a truthy find", () => {
    const id = briefId();
    setCachedScan(id, changesFingerprint(CHANGES_A), []);
    expect(getCachedScan(id, changesFingerprint(CHANGES_A))).toEqual([]);
  });

  it("fingerprint differs between two different stamps and is stable for one", () => {
    expect(changesFingerprint(CHANGES_A)).not.toEqual(changesFingerprint(CHANGES_B));
    expect(changesFingerprint(CHANGES_A)).toEqual(changesFingerprint(CHANGES_A));
  });

  it("different briefs never share a cache entry, even with the same changed-fact set", () => {
    const idA = briefId();
    const idB = briefId();
    setCachedScan(idA, changesFingerprint(CHANGES_A), [{ factA: "a", factB: "b", note: "n" }]);
    expect(getCachedScan(idB, changesFingerprint(CHANGES_A))).toBeUndefined();
  });

  // Mutant check: each field of the stamp is load-bearing. Drop any one from
  // scanFingerprint() and the matching case here goes red (so does the realdb
  // scan-cache-coherence test for the epoch and the change count).
  describe("every field of the stamp moves the fingerprint on its own", () => {
    it("the org removal epoch alone: an erasure writes no applied change, so nothing else moves", () => {
      const erased = { ...STAMP_A, erasureEpoch: "3" };
      expect(scanFingerprint(erased)).not.toEqual(scanFingerprint(STAMP_A));
      const id = briefId();
      setCachedScan(id, scanFingerprint(STAMP_A), [{ factA: "Mara signs at 160k", factB: "b", note: "n" }]);
      expect(getCachedScan(id, scanFingerprint(erased))).toBeUndefined();
    });

    it("the change count alone", () => {
      expect(scanFingerprint({ ...STAMP_A, changeCount: "21" })).not.toEqual(scanFingerprint(STAMP_A));
    });
  });

  it("the migration's audit trigger moves the epoch on every action REMOVAL_AUDIT_ACTIONS names", () => {
    const sql = readFileSync("prisma/migrations/20261024120000_scope_cache_epoch/migration.sql", "utf8");
    const bump = sql.slice(
      sql.indexOf("FUNCTION public.scope_cache_audit_bump"),
      sql.indexOf("PERFORM public.bump_org_removal_epoch(NEW"),
    );
    for (const action of REMOVAL_AUDIT_ACTIONS) expect(bump).toContain(`'${action}'`);
  });
});
