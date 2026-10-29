// The two doors this feature adds: reading one version by id, and retiring a rule.
//
// Both are thin — auth gate, service call, status mapping — and that is the point:
// the version's scope decision is made in services/memory/versions.ts, not here. What
// these tests hold is that an unauthenticated caller gets 401, an unreadable version
// is indistinguishable from a missing one, and a denied retire is a 403 rather than a
// crash.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/versions", () => ({ readMemoryVersion: vi.fn() }));
vi.mock("@/services/memory/conventions", () => ({ retireConvention: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  class FakeAccessDeniedError extends Error {
    constructor(readonly decision: { allowed: boolean; reason: string }) {
      super(decision.reason);
    }
  }
  return { ...actual, AccessDeniedError: FakeAccessDeniedError };
});

import { requireAccessContext } from "@/lib/access-context";
import { AccessDeniedError } from "@/services/access";
import { readMemoryVersion } from "@/services/memory/versions";
import { retireConvention } from "@/services/memory/conventions";
import { GET as versionGET } from "./versions/[id]/route";
import { DELETE as conventionDELETE } from "./conventions/[id]/route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "admin" } },
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const request = new Request("http://t/api/memory");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
});

describe("GET /api/memory/versions/:id", () => {
  it("refuses a caller who is not signed in", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);

    expect((await versionGET(request, params("v1"))).status).toBe(401);
  });

  it("returns the version, with its timestamp as a string", async () => {
    vi.mocked(readMemoryVersion).mockResolvedValue({
      id: "v1",
      kind: "fact",
      scopePath: "org_org_1.race",
      content: "The launch date is FRIDAY.",
      subject: "Launch date",
      actorId: "agent-one",
      createdAt: new Date("2026-10-02T04:00:00.000Z"),
      status: "superseded",
      supersededById: "v0",
      supersedesIds: [],
    });

    const body = await (await versionGET(request, params("v1"))).json();

    expect(body.version).toMatchObject({
      id: "v1",
      status: "superseded",
      supersededById: "v0",
      createdAt: "2026-10-02T04:00:00.000Z",
    });
  });

  it("reports an unreadable or unknown version as missing, the same way for both", async () => {
    vi.mocked(readMemoryVersion).mockResolvedValue(null);

    expect((await versionGET(request, params("v1"))).status).toBe(404);
  });
});

describe("DELETE /api/memory/conventions/:id", () => {
  it("refuses a caller who is not signed in", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null as never);

    expect((await conventionDELETE(request, params("rule-1"))).status).toBe(401);
  });

  it("retires the rule and names it", async () => {
    vi.mocked(retireConvention).mockResolvedValue(true);

    const response = await conventionDELETE(request, params("rule-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ retired: "rule-1" });
  });

  it("reports a rule that is not there, or already retired, as missing", async () => {
    vi.mocked(retireConvention).mockResolvedValue(false);

    expect((await conventionDELETE(request, params("rule-1"))).status).toBe(404);
  });

  it("turns a denied write into 403, with the decision's own reason", async () => {
    vi.mocked(retireConvention).mockRejectedValue(
      new AccessDeniedError({ allowed: false, reason: "no grant covers org_org_1.race" }),
    );

    const response = await conventionDELETE(request, params("rule-1"));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no grant covers org_org_1.race" });
  });
});
