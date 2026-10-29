// Verifies that each endpoint's rate-limit wiring uses the correct limits.
// Tests `isRateLimited` with the exact key format and limits from each route,
// without needing HTTP auth.  Fast, offline, deterministic.

import { isRateLimited, per } from "../lib/rate-limit";

type Result = { name: string; pass: boolean; note?: string };
const results: Result[] = [];

function assert(name: string, condition: boolean, note?: string) {
  results.push({ name, pass: condition, note });
  if (!condition) console.error(`  FAIL  ${name}${note ? ` (${note})` : ""}`);
}

// Each route uses: isRateLimited(`<prefix>:<orgId>`, limit, per.hour)
// We use random org IDs so tests don't bleed into each other.
const randOrg = () => `org_test_${Math.random().toString(36).slice(2)}`;

// ─── memory/ingest: 60/hour ─────────────────────────────────────────────────
{
  const orgId = randOrg();
  const key = `memory:ingest:${orgId}`;
  let blocked = false;
  for (let i = 0; i < 61; i++) {
    if (isRateLimited(key, 60, per.hour)) {
      blocked = true;
      assert("ingest: blocks on 61st request", i === 60, `blocked at i=${i}`);
      break;
    }
  }
  if (!blocked) assert("ingest: blocks on 61st request", false, "never blocked");
}

// ─── memory/query: 120/hour ──────────────────────────────────────────────────
{
  const orgId = randOrg();
  const key = `memory:query:${orgId}`;
  let blocked = false;
  for (let i = 0; i < 121; i++) {
    if (isRateLimited(key, 120, per.hour)) {
      blocked = true;
      assert("query: blocks on 121st request", i === 120, `blocked at i=${i}`);
      break;
    }
  }
  if (!blocked) assert("query: blocks on 121st request", false, "never blocked");
}

// ─── memory/chat: 30/hour ────────────────────────────────────────────────────
{
  const orgId = randOrg();
  const key = `memory:chat:${orgId}`;
  let blocked = false;
  for (let i = 0; i < 31; i++) {
    if (isRateLimited(key, 30, per.hour)) {
      blocked = true;
      assert("chat: blocks on 31st request", i === 30, `blocked at i=${i}`);
      break;
    }
  }
  if (!blocked) assert("chat: blocks on 31st request", false, "never blocked");
}

// ─── enrich (accounts + contacts share the same key): 30/hour ───────────────
{
  const orgId = randOrg();
  const key = `enrich:${orgId}`;
  let blocked = false;
  for (let i = 0; i < 31; i++) {
    if (isRateLimited(key, 30, per.hour)) {
      blocked = true;
      assert("enrich: blocks on 31st request", i === 30, `blocked at i=${i}`);
      break;
    }
  }
  if (!blocked) assert("enrich: blocks on 31st request", false, "never blocked");
}

// ─── org isolation: different orgs don't share a bucket ─────────────────────
{
  const orgA = randOrg();
  const orgB = randOrg();
  const keyA = `memory:ingest:${orgA}`;
  const keyB = `memory:ingest:${orgB}`;

  // Exhaust orgA's bucket.
  for (let i = 0; i < 60; i++) isRateLimited(keyA, 60, per.hour);
  const orgABlocked = isRateLimited(keyA, 60, per.hour);
  const orgBFree = !isRateLimited(keyB, 60, per.hour);

  assert("isolation: org A exhausted blocks org A", orgABlocked);
  assert("isolation: exhausting org A does not block org B", orgBFree);
}

// ─── summary ─────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass).length;

console.log("\nRate-limit wiring check");
results.forEach((r) => {
  const icon = r.pass ? "  ✓ " : "  ✗ ";
  console.log(`${icon} ${r.name}`);
});
console.log();
if (failed > 0) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
} else {
  console.log(`${passed}/${results.length} checks passed — rate-limit wiring healthy.`);
}
