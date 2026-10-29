// The idempotency-key lease assumes no keyed write runs past its route's maxDuration. Each
// route declares maxDuration as a literal (Next.js reads it statically), so this test is
// what keeps those literals equal to the number the lease is derived from.
import { describe, expect, it, vi } from "vitest";
import { KEYED_ROUTE_MAX_DURATION_SECONDS } from "./ingest-key";

vi.mock("@/lib/db", () => ({ db: {} }));

describe("routes that take an idempotency key", () => {
  it("stop at the maxDuration the key lease is derived from", async () => {
    const mcp = await import("@/app/api/mcp/route");
    const restIngest = await import("@/app/api/memory/ingest/route");

    expect(mcp.maxDuration).toBe(KEYED_ROUTE_MAX_DURATION_SECONDS);
    expect(restIngest.maxDuration).toBe(KEYED_ROUTE_MAX_DURATION_SECONDS);
  });
});
