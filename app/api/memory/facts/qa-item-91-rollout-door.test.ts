// The REST provenance door over the REAL resolution path, not a mocked one.
//
// The two sibling tests each stub one side of the seam. The
// store test drives the real GraphitiMemoryStore but stops at the client. The
// door's 502 test drives the real route but stubs recordFactProvenance, so it
// pins the catch block against an error handed to it rather than one the stack
// actually produced. Neither one answers the question this file asks: given a
// memory service that answers <status>, what does a caller of
// POST /api/memory/facts/:id/provenance see?
//
// So here the only stub is `fetch`. The route, recordFactProvenance,
// GuardedMemoryStore, check() and GraphitiMemoryStore are all real, and the
// status the service returns is the single input that varies.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Graph facts here are stand-ins with no stored rows behind them, so the serve-time source
// check (services/memory/graph-fact-sources.ts) supports them; it is proven against real rows
// in services/memory/graph-fact-sources.realdb.test.ts.
vi.mock("@/services/memory/graph-fact-sources", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/memory/graph-fact-sources")>()),
  loadGraphSources: async () => ({ supports: () => true }),
}));
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    orgDeletion: { findFirst: async () => null },
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn(), update: vi.fn() },
    factProvenance: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
}));
// Only the store instance is replaced, and only so it points at a test host —
// it is still a real GuardedMemoryStore wrapping a real GraphitiMemoryStore.
vi.mock("@/services/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory")>();
  return {
    ...actual,
    guardedMemory: new actual.GuardedMemoryStore(new actual.GraphitiMemoryStore("http://memory.test", "key") as never),
  };
});

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { POST } from "./[id]/provenance/route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42", name: "Alex", email: "alex@example.com" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const body = { sourceType: "pr", sourceRef: "github.com/acme/app/pull/42" };

const post = (id: string) =>
  new Request(`http://t/api/memory/facts/${id}/provenance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** Every memory-service call answers this status. */
const serviceAnswers = (status: number, statusText: string) =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText,
      text: async () => statusText,
      json: async () => ({}),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
  // The caller genuinely holds write here, so nothing below can be refused by
  // the access gate — only by the resolution.
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write" }] as never);
  vi.mocked(db.factProvenance.create).mockResolvedValue({ id: "prov_1" } as never);
});

describe("POST /api/memory/facts/:id/provenance over a real memory-service client", () => {
  // A memory service answers exactly this on GET /facts/{uuid} when DELETE
  // occupies that path, which is why the lookup lives at /facts/{uuid}/resolve.
  //
  // A 405 is a 502, not a 404: the row is still not written, but the caller is
  // not told the fact does not exist on the strength of a question nobody could
  // ask.
  it("405 (the rollout window) reaches the caller as a 502, with no row written", async () => {
    serviceAnswers(405, "Method Not Allowed");

    const res = await POST(post("fact_1"), params("fact_1"));

    expect(res.status).toBe(502);
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });

  it("a genuine service fault is a 502, not the 404 above and not an unhandled throw", async () => {
    serviceAnswers(500, "Internal Server Error");

    const res = await POST(post("fact_1"), params("fact_1"));

    expect(res.status).toBe(502);
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });

  it("an unreachable service is a 502 too, so 502 is the fault answer and not one status special-cased", async () => {
    serviceAnswers(503, "Service Unavailable");

    const res = await POST(post("fact_1"), params("fact_1"));

    expect(res.status).toBe(502);
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });

  // Without this the three refusals above would also pass against a door that
  // refuses everything, which is the failure mode the whole suite exists to rule
  // out.
  it("a resolvable fact is still written — the refusals are not a door that always fails closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ found: true, uuid: "fact_1", fact: "Jane is CTO" }),
      }),
    );

    const res = await POST(post("fact_1"), params("fact_1"));

    expect(res.status).toBe(201);
    expect(db.factProvenance.create).toHaveBeenCalledTimes(1);
  });

  // The refusal this door exists to produce, and the only one that is a
  // real answer rather than a fault: the service is reachable, current, and says
  // the uuid resolves to no fact in the scope this caller was authorized for —
  // because it belongs to another scope, another tenant, or to nothing at all.
  //
  // Every other case here varies an HTTP status; this one varies the body of a
  // 200, which is the shape the security boundary is actually carried in.
  // Dropping the `found` check in GraphitiMemoryStore.findFactById and returning
  // the payload unconditionally turns `{ found: false }` into a truthy
  // `{ uuid: undefined }` — a resolved fact — and the door writes provenance
  // against a fact the caller cannot read. This is the only test above the
  // store layer that catches that mutation.
  it("a reachable, current service that resolves the uuid to nothing is a 404, with no row written", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ found: false }),
      }),
    );

    const res = await POST(post("fact_1"), params("fact_1"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "fact not found" });
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });

  // 404 and 405 must be indistinguishable to the caller: both mean the service
  // has no such route, and a caller that could tell them apart could probe how
  // that deployment is configured. (The status must never be interpolated into
  // the error message the door returns verbatim.)
  it("404 and 405 answer identically", async () => {
    serviceAnswers(404, "Not Found");
    const notFound = await POST(post("fact_1"), params("fact_1"));
    const notFoundBody = await notFound.json();

    serviceAnswers(405, "Method Not Allowed");
    const notAllowed = await POST(post("fact_1"), params("fact_1"));
    const notAllowedBody = await notAllowed.json();

    expect(notAllowed.status).toBe(notFound.status);
    expect(notAllowedBody).toEqual(notFoundBody);
  });
});
