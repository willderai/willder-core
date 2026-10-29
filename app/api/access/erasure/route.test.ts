// The HTTP mapping of POST /api/access/erasure and GET /api/access/erasure/:requestId. What an
// erasure removes is proven against real Postgres in services/memory/person-erasure.realdb.test.ts,
// and how a request runs in services/memory/person-erasure-requests.realdb.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError } from "@/services/access";
import { PersonErasureError } from "@/services/memory/person-erasure";
import { ErasureNotQueuedError } from "@/services/memory/person-erasure-requests";

const requireAccessContext = vi.fn();
const requestPersonErasure = vi.fn();
const personErasureStatus = vi.fn();
const queuePersonErasure = vi.fn();
vi.mock("@/lib/access-context", () => ({ requireAccessContext: () => requireAccessContext() }));
vi.mock("@/lib/inngest/person-erasure", () => ({ queuePersonErasure: (id: string) => queuePersonErasure(id) }));
vi.mock("@/services/memory/person-erasure-requests", async (actual) => ({
  ...(await actual<typeof import("@/services/memory/person-erasure-requests")>()),
  requestPersonErasure: (...args: unknown[]) => requestPersonErasure(...args),
  personErasureStatus: (...args: unknown[]) => personErasureStatus(...args),
}));

const { POST } = await import("./route");
const { GET } = await import("./[requestId]/route");

const ctx = { orgId: "org1", actor: { type: "human", id: "u1", role: "admin" } };
const REQUEST_ID = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const post = (body: string) => POST(new Request("http://test/api/access/erasure", { method: "POST", body }));
const get = (requestId: string) =>
  GET(new Request(`http://test/api/access/erasure/${requestId}`), { params: Promise.resolve({ requestId }) });

beforeEach(() => {
  requireAccessContext.mockReset().mockResolvedValue({ org: { id: "org1" }, user: { id: "u1" }, ctx });
  requestPersonErasure.mockReset();
  personErasureStatus.mockReset();
  queuePersonErasure.mockReset();
});

describe("POST /api/access/erasure", () => {
  it("accepts the request with 202, its id and where to poll, and queues its job", async () => {
    requestPersonErasure.mockImplementation(async (_ctx, _identifier, queue: (id: string) => Promise<void>) => {
      await queue(REQUEST_ID);
      return { requestId: REQUEST_ID, status: "running" };
    });

    const res = await post(JSON.stringify({ email: "a@b.example" }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      requestId: REQUEST_ID,
      status: "running",
      statusUrl: `/api/access/erasure/${REQUEST_ID}`,
    });
    expect(requestPersonErasure).toHaveBeenCalledWith(ctx, { email: "a@b.example" }, expect.any(Function));
    expect(queuePersonErasure).toHaveBeenCalledExactlyOnceWith(REQUEST_ID);
  });

  it("answers 401 without a session and never reaches the erasure", async () => {
    requireAccessContext.mockResolvedValue(null);

    expect((await post("{}")).status).toBe(401);
    expect(requestPersonErasure).not.toHaveBeenCalled();
  });

  it.each(["not json", "[]", "null"])("answers 400 for the body %s", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(requestPersonErasure).not.toHaveBeenCalled();
  });

  it.each([
    [new PersonErasureError("bad identifier"), 400],
    [new AccessDeniedError({ allowed: false, reason: "no grant" }), 403],
    [new ErasureNotQueuedError(new Error("queue down")), 503],
    [new Error("database gone"), 500],
  ])("maps %s to %i", async (error, status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    requestPersonErasure.mockRejectedValue(error);

    const res = await post(JSON.stringify({ contactId: "c1" }));

    expect(res.status).toBe(status);
    expect((await res.json()).error).toEqual(expect.any(String));
  });
});

describe("GET /api/access/erasure/:requestId", () => {
  it("answers 200 with the request's status", async () => {
    const done = { status: "done", requestId: REQUEST_ID, contactsRemoved: 1, graph: {} };
    personErasureStatus.mockResolvedValue(done);

    const res = await get(REQUEST_ID);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(done);
    expect(personErasureStatus).toHaveBeenCalledWith(ctx, REQUEST_ID);
  });

  it.each([
    ["no such request", async () => null, 404],
    ["a refusal", async () => Promise.reject(new AccessDeniedError({ allowed: false, reason: "no grant" })), 403],
  ])("answers %s with %i", async (_label, impl, status) => {
    personErasureStatus.mockImplementation(impl);
    expect((await get(REQUEST_ID)).status).toBe(status);
  });

  it("answers 401 without a session", async () => {
    requireAccessContext.mockResolvedValue(null);
    expect((await get(REQUEST_ID)).status).toBe(401);
    expect(personErasureStatus).not.toHaveBeenCalled();
  });
});
