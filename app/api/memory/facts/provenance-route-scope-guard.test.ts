// POST /api/memory/facts/:id/provenance must never pass a caller-supplied scope
// straight into check(), whose `::ltree` cast throws before recordAudit() runs:
// a malformed scope would escape as an unaudited 500 instead of a clean audited
// deny, zero audit rows written. The MCP door (fact_link_source, mcp/tools.ts)
// and this REST route both reach recordFactProvenance() through
// resolveCallerScopePath(..., onInvalid: "refuse"). Same test shape as
// app/api/memory/upload-route-scope-guard.test.ts (the shared write-direction
// helper).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }) } },
}));
// UnresolvedFactError stays the real class: the route narrows on it with
// instanceof, so a stubbed fake would make the 404 case below pass against
// a route that never actually recognized the error.
vi.mock("@/services/memory/fact-provenance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory/fact-provenance")>();
  return {
    UnresolvedFactError: actual.UnresolvedFactError,
    recordFactProvenance: vi.fn().mockResolvedValue({ id: "prov_1" }),
    listReadableFactProvenance: vi.fn(),
  };
});
// Real resolveCallerScopePath/orgRootPath/isValidLtreePath/normalizeScopePath/
// AccessDeniedError (the actual write-direction contract under test) — only
// check() itself is stubbed, same boundary upload-route-scope-guard.test.ts draws.
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { recordFactProvenance, UnresolvedFactError } from "@/services/memory/fact-provenance";
import { check, orgRootPath } from "@/services/access";
import { MemoryServiceError } from "@/services/memory";
import { POST } from "./[id]/provenance/route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42", name: "Alex", email: "alex@example.com" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

/** A space is invalid ltree syntax (42601). */
const MALFORMED = "org_1.deal A";

const post = (id: string, body: Record<string, unknown>) =>
  new Request(`http://t/api/memory/facts/${id}/provenance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
});

describe("POST /api/memory/facts/:id/provenance — scope guard", () => {
  const body = { sourceType: "pr", sourceRef: "github.com/acme/app/pull/42" };

  it("a selected scope reaches recordFactProvenance and check()", async () => {
    await POST(post("fact_1", { ...body, scope: "org_1.dealA" }), params("fact_1"));

    expect(check).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: "org_1.dealA" }));
    expect(recordFactProvenance).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", actor: expect.objectContaining({ id: "user_42" }) }),
      expect.objectContaining({ scopePath: "org_1.dealA" }),
    );
  });

  it("no scope selected falls back to the org root", async () => {
    await POST(post("fact_1", body), params("fact_1"));

    expect(recordFactProvenance).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org_1", actor: expect.objectContaining({ id: "user_42" }) }),
      expect.objectContaining({ scopePath: orgRootPath("org_1") }),
    );
  });

  // The service refuses a uuid it cannot resolve in the written scope.
  // The door's job is to report that as a plain "not found" — a 201 here would
  // mean the row was written anyway, and a 403 would tell the caller the fact
  // is real but out of reach.
  it("a uuid the service cannot resolve in this scope is a 404, and writes nothing", async () => {
    vi.mocked(recordFactProvenance).mockRejectedValueOnce(new UnresolvedFactError("fact_elsewhere"));

    const res = await POST(post("fact_elsewhere", body), params("fact_elsewhere"));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "fact not found" });
  });

  // Resolving the uuid through the memory service gives this door an error path:
  // the service can fail, or be older than the route the resolution needs. A
  // catch block narrowed only on UnresolvedFactError and AccessDeniedError would
  // let either escape the handler unhandled, which Next reports as a bare 500
  // with no body. 502 is what every other memory door answers for this
  // (app/api/memory/{query,graph,entities}, facts/:id DELETE and PATCH), and it
  // says the right thing: the failure is downstream, not in the request.
  //
  // Not a 404. "We could not ask" is not "it is not there" — a caller told the
  // fact does not exist would stop retrying a link that is perfectly valid.
  it.each([
    ["a fault", "memory service find-fact failed: boom", 500],
    ["a service too old to serve the lookup", "memory service does not serve the fact-resolve route", 405],
  ])("%s is a 502, not an unhandled throw and not a 404", async (_label, message, status) => {
    vi.mocked(recordFactProvenance).mockRejectedValueOnce(new MemoryServiceError(message as string, status as number));

    const res = await POST(post("fact_1", body), params("fact_1"));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: message });
  });

  it("an explicit, malformed scope is refused (403) and audited — never an unaudited throw, never silently widened, never written", async () => {
    const res = await POST(post("fact_1", { ...body, scope: MALFORMED }), params("fact_1"));

    expect(res.status).toBe(403);
    expect(recordFactProvenance).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org_1",
          actorId: "user_42",
          decision: "deny",
          target: MALFORMED,
        }),
      }),
    );
  });
});
