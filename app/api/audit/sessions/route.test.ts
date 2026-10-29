import { beforeEach, describe, expect, it, vi } from "vitest";

// The gates on GET /api/audit/sessions, without a database. What the query returns once
// through them is proven against real Postgres in route.realdb.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(),
}));
vi.mock("@/services/memory/task-start-sessions", () => ({ readSessionStarts: vi.fn() }));
vi.mock("@/services/audit/actor-names", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/audit/actor-names")>()),
  resolveActorNames: vi.fn(async () => ({ "agent-1": "Builder" })),
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { readSessionStarts } from "@/services/memory/task-start-sessions";
import { GET } from "./route";

const signedIn = {
  org: { id: "c1" },
  user: { id: "u1" },
  ctx: { orgId: "c1", actor: { type: "human", id: "u1", role: "admin" } },
};

beforeEach(() => {
  vi.mocked(requireAccessContext).mockResolvedValue(signedIn as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" });
  vi.mocked(readSessionStarts).mockReset().mockResolvedValue({ sessions: [], total: 0 });
});

describe("GET /api/audit/sessions gates", () => {
  it("401s without a session and 403s without access.manage, before any query", async () => {
    vi.mocked(requireAccessContext).mockResolvedValueOnce(null);
    expect((await GET(new Request("http://t/api/audit/sessions"))).status).toBe(401);

    vi.mocked(check).mockResolvedValueOnce({ allowed: false, reason: "no" });
    expect((await GET(new Request("http://t/api/audit/sessions"))).status).toBe(403);
    expect(vi.mocked(check).mock.calls.at(-1)![1]).toEqual({ action: "access.manage", target: "audit:sessions" });
    expect(readSessionStarts).not.toHaveBeenCalled();
  });

  it("refuses a scope outside the org, a bad page and a bad range, before any query", async () => {
    for (const query of [
      "scope=org_c2.b",
      "scope=org_c1x",
      "scope=not%20a%20path",
      "page=0",
      "page=1.5",
      "page=abc",
      "from=2026-10-01T00:00",
      "from=2026-10-02&to=2026-10-01",
    ]) {
      expect((await GET(new Request(`http://t/api/audit/sessions?${query}`))).status, query).toBe(400);
    }
    expect(readSessionStarts).not.toHaveBeenCalled();
  });

  it("reads the org root by default and names each session's agent", async () => {
    vi.mocked(readSessionStarts).mockResolvedValueOnce({
      sessions: [
        {
          servingId: "s",
          agentId: "agent-1",
          sessionKey: "k",
          scopePath: "org_c1",
          taskKey: "",
          servedAt: "2026-10-14T10:00:00.000Z",
          lineCount: 0,
          lines: [],
        },
      ],
      total: 21,
    });
    const res = await GET(new Request("http://t/api/audit/sessions?page=2"));
    expect(readSessionStarts).toHaveBeenCalledWith({
      orgId: "c1",
      scope: "org_c1",
      page: 2,
      pageSize: 20,
      range: { from: null, to: null },
    });
    const body = await res.json();
    expect(body.sessions[0].agentName).toBe("Builder");
    expect(body).toMatchObject({ total: 21, page: 2, pageSize: 20, totalPages: 2 });
  });
});
