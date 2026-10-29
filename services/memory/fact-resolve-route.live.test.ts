// Live-gated: runs only with MEMORY_SERVICE_LIVE=1 plus GRAPHITI_SERVICE_URL and
// GRAPHITI_SERVICE_API_KEY; without them every test in this file is skipped, not failed.
//
// The fact-resolve route, against the memory-service that is actually deployed.
//
// A lookup shipped as `GET /facts/{uuid}` passes unit tests and a local service,
// but `DELETE /facts/{uuid}` already claims every single-segment `/facts/*`, so
// a deployed service answers that GET with 405 `allow: DELETE` and the app turns
// it into a 500. Nothing local can catch that — the collision only exists
// between two service versions.
//
// So this suite asserts the two things only the real deployment can answer, and
// both hold whether or not the service has caught up with the app:
//  1. the lookup path is not shadowed by the removal route (never 405);
//  2. a service too old to serve it refuses loudly rather than reporting the
//     fact as absent, which would silently deny every provenance write.
//
// Run: MEMORY_SERVICE_LIVE=1 npx vitest run services/memory/fact-resolve-route.live.test.ts
// (reads GRAPHITI_SERVICE_URL + GRAPHITI_SERVICE_API_KEY, both read-only here).
import { describe, expect, it } from "vitest";
import { GraphitiMemoryStore, MemoryServiceError } from "./graphiti-store";

const baseUrl = process.env.GRAPHITI_SERVICE_URL ?? "";
const apiKey = process.env.GRAPHITI_SERVICE_API_KEY ?? "";
const LIVE = process.env.MEMORY_SERVICE_LIVE === "1" && baseUrl !== "" && apiKey !== "";

/** A uuid no ingest ever minted, so the probe reads one route and writes nothing. */
const ABSENT_FACT = "00000000-0000-4000-8000-000000000000";
const PROBE_GROUP = "org_live_probe";

describe.skipIf(!LIVE)("fact-resolve route on the deployed memory-service", () => {
  /** What the deployed service answers for a uuid it holds no fact for. */
  const probe = () =>
    fetch(`${baseUrl}/facts/${ABSENT_FACT}/resolve?group_id=${PROBE_GROUP}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });

  it("is not shadowed by DELETE /facts/{uuid}", async () => {
    const res = await probe();

    expect(
      res.status,
      `405 means the removal route claims this path again; allow: ${res.headers.get("allow")}`,
    ).not.toBe(405);
    if (res.status === 200) {
      expect(typeof (await res.json()).found).toBe("boolean");
    } else {
      expect(res.status).toBe(404); // the deployed service predates this route
    }
  });

  it("answers the way the deployed service actually replied, never a null it did not say", async () => {
    // Pinned to the observed status rather than accepting either outcome: a
    // service serving the route resolves an absent fact to null, and one that
    // is not serving it yet must throw. Reporting the second as null would let
    // a stale deployment stand in as proof that no such fact exists, and every
    // provenance write would be refused as if the caller had invented the uuid.
    const status = (await probe()).status;
    const store = new GraphitiMemoryStore(baseUrl, apiKey);
    const lookup = store.findFactById({ groupId: PROBE_GROUP, factId: ABSENT_FACT });

    if (status === 200) {
      await expect(lookup).resolves.toBeNull();
    } else {
      await expect(lookup).rejects.toBeInstanceOf(MemoryServiceError);
    }
  });
});
