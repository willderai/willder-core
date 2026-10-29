import { beforeEach, describe, expect, it, vi } from "vitest";

// The gates on both timeline routes, without a database. What the queries return
// once through them is proven against real Postgres in route.realdb.test.ts.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(),
}));
vi.mock("@/services/access/audit-query", () => ({ queryTimelineReads: vi.fn(), queryAuditLog: vi.fn() }));
vi.mock("@/services/audit/actor-names", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/audit/actor-names")>()),
  resolveUserNames: vi.fn(async () => ({})),
  resolveActorNames: vi.fn(async () => ({})),
  fallbackAgentName: (key: string) => `${key} Agent`,
  resolveConnectorSource: vi.fn(),
}));
vi.mock("@/services/memory/versions", () => ({ readVersionLineage: vi.fn() }));
vi.mock("@/services/memory/change-history", () => ({
  listChangesInWindow: vi.fn(),
  readChangeInScope: vi.fn(),
  changesThatWroteRecords: vi.fn(async () => new Map()),
}));

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { queryAuditLog, queryTimelineReads } from "@/services/access/audit-query";
import { resolveConnectorSource, resolveUserNames } from "@/services/audit/actor-names";
import { changesThatWroteRecords, listChangesInWindow, readChangeInScope } from "@/services/memory/change-history";
import { readVersionLineage } from "@/services/memory/versions";
import { GET } from "./route";
import { GET as GET_CHANGE } from "./[changeId]/route";

const ORG = { id: "c1" };
const signedIn = {
  org: ORG,
  user: { id: "u1" },
  ctx: { orgId: "c1", actor: { type: "human", id: "u1", role: "member" } },
};
const changeParams = { params: Promise.resolve({ changeId: "ch1" }) };

beforeEach(() => {
  vi.mocked(requireAccessContext).mockResolvedValue(signedIn as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" });
  vi.mocked(listChangesInWindow).mockReset();
  vi.mocked(queryTimelineReads).mockReset();
  vi.mocked(readChangeInScope).mockReset();
});

describe("GET /api/audit/timeline gates", () => {
  it("401s without a session and 403s without access.manage, before any query", async () => {
    vi.mocked(requireAccessContext).mockResolvedValueOnce(null);
    expect((await GET(new Request("http://t/api/audit/timeline"))).status).toBe(401);

    vi.mocked(check).mockResolvedValueOnce({ allowed: false, reason: "no" });
    expect((await GET(new Request("http://t/api/audit/timeline"))).status).toBe(403);
    expect(vi.mocked(check).mock.calls.at(-1)![1]).toEqual({ action: "access.manage", target: "audit:timeline" });
    expect(listChangesInWindow).not.toHaveBeenCalled();
    expect(queryTimelineReads).not.toHaveBeenCalled();
  });

  it("400s a scope outside the org, including one that only shares its prefix", async () => {
    for (const scope of ["org_c2", "org_c1x.crew", "not a path"]) {
      const res = await GET(new Request(`http://t/api/audit/timeline?scope=${encodeURIComponent(scope)}`));
      expect(res.status).toBe(400);
    }
    expect(listChangesInWindow).not.toHaveBeenCalled();
  });
});

describe("GET /api/audit/timeline/:changeId gates", () => {
  it("403s without access.manage before reading anything", async () => {
    vi.mocked(check).mockResolvedValueOnce({ allowed: false, reason: "no" });
    const res = await GET_CHANGE(new Request("http://t/api/audit/timeline/ch1?scope=org_c1"), changeParams);
    expect(res.status).toBe(403);
    expect(vi.mocked(check).mock.calls.at(-1)![1]).toEqual({
      action: "access.manage",
      target: "audit:timeline:change",
    });
    expect(readChangeInScope).not.toHaveBeenCalled();
  });

  it("checks memory.read on the scope before reading the change, and stops on a deny", async () => {
    vi.mocked(check)
      .mockResolvedValueOnce({ allowed: true, reason: "ok" })
      .mockResolvedValueOnce({ allowed: false, reason: "no grant covers org_c1.crew" });
    const res = await GET_CHANGE(new Request("http://t/api/audit/timeline/ch1?scope=org_c1.crew"), changeParams);
    expect(res.status).toBe(403);
    expect(vi.mocked(check).mock.calls.at(-1)![1]).toEqual({
      action: "memory.read",
      scope: "org_c1.crew",
      target: "change:ch1",
    });
    expect(readChangeInScope).not.toHaveBeenCalled();
  });

  it("404s when the change is not in the scope", async () => {
    vi.mocked(readChangeInScope).mockResolvedValueOnce(null);
    const res = await GET_CHANGE(new Request("http://t/api/audit/timeline/ch1?scope=org_c1.crew"), changeParams);
    expect(res.status).toBe(404);
    expect(readChangeInScope).toHaveBeenCalledWith("c1", "org_c1.crew", "ch1");
  });

  it("answers the change's source and lineage from the same resolvers memory_query and the versions route use", async () => {
    vi.mocked(readChangeInScope).mockResolvedValueOnce({
      id: "ch1",
      scopePath: "org_c1.crew",
      recordType: "convention",
      recordId: "c1",
      op: "supersede",
      actorId: "slack-sync:s1",
      actorType: "extraction",
      origin: "connector-sync",
      createdAt: new Date("2026-10-02T07:00:00Z"),
      summary: "superseded by c2: cadence",
      authorizedById: null,
    });
    vi.mocked(resolveConnectorSource).mockResolvedValueOnce({ name: "Acme #eng", type: "slack" });
    vi.mocked(readVersionLineage).mockResolvedValueOnce({ supersededById: "c2", supersedesIds: ["c0"] });

    const res = await GET_CHANGE(new Request("http://t/api/audit/timeline/ch1?scope=org_c1.crew"), changeParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      writer: "slack-sync:s1 Agent",
      source: { name: "Acme #eng", type: "slack" },
      replacedById: "c2",
      replacesIds: ["c0"],
      // A version that lost a concurrent write is superseded by the server, so there is
      // no authorization of its own to name.
      authorizedById: null,
    });
    expect(resolveConnectorSource).toHaveBeenCalledWith("c1", "slack-sync:s1");
    expect(readVersionLineage).toHaveBeenCalledWith("c1", "c1");
  });
});

// What an outsider handed one change needs from the route: the person the writer acted
// for, the source to follow, and each replaced version with the change that wrote it.
describe("GET /api/audit/timeline/:changeId, the answers an outsider follows", () => {
  const change = {
    id: "ch1",
    scopePath: "org_c1.crew",
    recordType: "fact",
    recordId: "v2",
    op: "create" as const,
    actorType: "agent",
    origin: "mcp" as const,
    createdAt: new Date("2026-10-02T07:00:00Z"),
    summary: "Launch moved to Oct 11",
    authorizedById: "row1",
  };
  const auditRow = (actorType: string, actorId: string, metadata: Record<string, string> | null) => ({
    entries: [
      {
        id: "row1",
        actorType,
        actorId,
        action: "memory.write",
        target: null,
        decision: "allow",
        reason: null,
        metadata,
        at: new Date(),
      },
    ],
    total: 1,
    counts: { allowed: 1, denied: 0 },
  });

  beforeEach(() => {
    vi.mocked(readVersionLineage).mockResolvedValue({ supersededById: null, supersedesIds: [] });
    vi.mocked(resolveConnectorSource).mockResolvedValue(null);
    vi.mocked(resolveUserNames).mockImplementation(async (ids) =>
      Object.fromEntries(ids.filter((id) => id.startsWith("user_")).map((id) => [id, `Name of ${id}`])),
    );
    vi.mocked(queryAuditLog).mockReset();
  });

  const get = async () =>
    (await GET_CHANGE(new Request("http://t/api/audit/timeline/ch1?scope=org_c1.crew"), changeParams)).json();

  it("names the person an agent acted for: the one who issued its token, from the row that authorized the write", async () => {
    vi.mocked(readChangeInScope).mockResolvedValueOnce({ ...change, actorId: "research-agent" });
    vi.mocked(queryAuditLog).mockResolvedValueOnce(
      auditRow("agent", "research-agent", { triggeredBy: "user_jane" }) as never,
    );
    expect(await get()).toMatchObject({ actingFor: "Name of user_jane", authorizationKind: "direct" });
    expect(vi.mocked(queryAuditLog).mock.calls[0]![0]).toMatchObject({ orgId: "c1", ids: ["row1"] });
  });

  it("names the person who connected the source for a sync write, and the source's id to link to", async () => {
    vi.mocked(readChangeInScope).mockResolvedValueOnce({
      ...change,
      actorId: "github-sync:src9",
      actorType: "extraction",
    });
    vi.mocked(resolveConnectorSource).mockResolvedValueOnce({ name: "acme/api", type: "github" });
    vi.mocked(queryAuditLog).mockResolvedValueOnce(auditRow("human", "user_pat", null) as never);
    expect(await get()).toMatchObject({
      actingFor: "Name of user_pat",
      authorizationKind: "connect",
      source: { id: "src9", name: "acme/api", type: "github" },
    });
  });

  it("names no one else for a person's own write, or when nothing authorized it", async () => {
    vi.mocked(readChangeInScope).mockResolvedValueOnce({ ...change, actorId: "user_ann", actorType: "human" });
    vi.mocked(queryAuditLog).mockResolvedValueOnce(auditRow("human", "user_ann", null) as never);
    expect(await get()).toMatchObject({ writer: "Name of user_ann", actingFor: null });

    vi.mocked(readChangeInScope).mockResolvedValueOnce({ ...change, actorId: "research-agent", authorizedById: null });
    expect(await get()).toMatchObject({ actingFor: null });
    expect(queryAuditLog).toHaveBeenCalledTimes(1);
  });

  it("names no one else for a person's write even when its row carries a token issuer", async () => {
    vi.mocked(readChangeInScope).mockResolvedValueOnce({ ...change, actorId: "user_ann", actorType: "human" });
    vi.mocked(queryAuditLog).mockResolvedValueOnce(
      auditRow("human", "user_ann", { triggeredBy: "user_jane" }) as never,
    );
    expect(await get()).toMatchObject({ writer: "Name of user_ann", actingFor: null });
  });

  it("names no one for a sync write whose authorizing row is not a person's", async () => {
    vi.mocked(readChangeInScope).mockResolvedValueOnce({
      ...change,
      actorId: "github-sync:src9",
      actorType: "extraction",
    });
    vi.mocked(queryAuditLog).mockResolvedValueOnce(
      auditRow("agent", "user_bot", { triggeredBy: "user_jane" }) as never,
    );
    expect(await get()).toMatchObject({ authorizationKind: "connect", actingFor: null });
  });

  it("gives each replaced version the change in this scope that wrote it, and none for one it cannot read", async () => {
    vi.mocked(readChangeInScope).mockResolvedValueOnce({ ...change, actorId: "research-agent", authorizedById: null });
    vi.mocked(readVersionLineage).mockResolvedValueOnce({ supersededById: "v3", supersedesIds: ["v1", "v0"] });
    vi.mocked(changesThatWroteRecords).mockResolvedValueOnce(
      new Map([["v1", { id: "ch0", summary: "Launch is Oct 4" }]]),
    );
    expect(await get()).toMatchObject({
      replacesIds: ["v1", "v0"],
      replacedById: "v3",
      replaces: [
        { id: "v1", change: { id: "ch0", summary: "Launch is Oct 4" } },
        { id: "v0", change: null },
      ],
      replacedBy: { id: "v3", change: null },
    });
    expect(changesThatWroteRecords).toHaveBeenCalledWith("c1", "org_c1.crew", ["v1", "v0", "v3"]);
  });
});
