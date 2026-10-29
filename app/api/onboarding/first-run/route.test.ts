import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    capability: { findFirst: vi.fn() },
    scope: { findMany: vi.fn() },
  },
}));
vi.mock("@/services/access", () => ({
  AUDIT_ORIGINS: { app: "Web app", mcp: "MCP" },
  check: vi.fn(),
  orgRootPath: (orgId: string) => `org_${orgId}`,
}));
vi.mock("@/services/access/audit-query", () => ({ queryAuditLog: vi.fn() }));
vi.mock("@/services/audit/actor-names", () => ({
  changeWriterType: (c: { actorType: string | null }) => c.actorType ?? "agent",
  resolveActorNames: vi.fn(async (_org: string, ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, `${id} Agent`])),
  ),
  resolveConnectorSource: vi.fn(),
  resolveUserNames: vi.fn(),
}));
vi.mock("@/services/memory/change-history", () => ({ latestFactWrite: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { check } from "@/services/access";
import { queryAuditLog } from "@/services/access/audit-query";
import { resolveConnectorSource, resolveUserNames } from "@/services/audit/actor-names";
import { latestFactWrite } from "@/services/memory/change-history";
import { GET, type FirstRunStatus } from "./route";

const rc = {
  org: { id: "o1", name: "Acme" },
  user: { id: "user_1", name: "Jane", email: "jane@acme.com" },
  ctx: { orgId: "o1", actor: { type: "human", id: "user_1", role: "owner" } },
};

const TOKEN_MINTED = new Date("2026-10-14T10:00:00Z");

const factWrite = {
  id: "chg_1",
  scopePath: "org_o1.eng",
  recordType: "fact",
  recordId: "v1",
  op: "create",
  actorId: "claude-code",
  actorType: "agent",
  origin: "mcp",
  createdAt: new Date("2026-10-14T09:00:00Z"),
};

function auditPage(entries: object[]) {
  return { total: entries.length, counts: { allowed: 0, denied: 0 }, entries };
}

/** Audit rows by who they are about: the person's own reads, or the token's agent's denials. */
function auditRows({ reads = [], denials = [] }: { reads?: object[]; denials?: object[] }) {
  vi.mocked(queryAuditLog).mockImplementation(
    async (q) => auditPage(q.actorType === "human" ? reads : denials) as never,
  );
}

async function status(): Promise<FirstRunStatus> {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as FirstRunStatus;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "granted" } as never);
  vi.mocked(latestFactWrite).mockResolvedValue(null);
  vi.mocked(db.capability.findFirst).mockResolvedValue(null);
  vi.mocked(db.scope.findMany).mockResolvedValue([
    { path: "org_o1.eng", name: "Engineering" },
    { path: "org_o1.eng.docs", name: "Docs" },
  ] as never);
  vi.mocked(resolveUserNames).mockResolvedValue({});
  vi.mocked(resolveConnectorSource).mockResolvedValue(null);
  auditRows({});
});

describe("GET /api/onboarding/first-run", () => {
  it("401 without a session", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("403, reading nothing, for a person who may not manage access", async () => {
    vi.mocked(check).mockResolvedValue({ allowed: false, reason: "no" } as never);
    const res = await GET();
    expect(res.status).toBe(403);
    expect(check).toHaveBeenCalledWith(rc.ctx, { action: "access.manage", target: "onboarding:first-run" });
    expect(latestFactWrite).not.toHaveBeenCalled();
    expect(db.capability.findFirst).not.toHaveBeenCalled();
    expect(queryAuditLog).not.toHaveBeenCalled();
  });

  it("an empty workspace has every step undone", async () => {
    expect(await status()).toEqual({ fact: null, openedFact: false, subScopeToken: null, denied: false });
  });

  it("names the first fact's writer, scope and entry point, and never its text", async () => {
    vi.mocked(latestFactWrite).mockResolvedValue(factWrite as never);
    const { fact } = await status();
    expect(fact).toEqual({
      changeId: "chg_1",
      writer: "claude-code Agent",
      writerType: "agent",
      source: "MCP",
      scopeName: "Engineering",
    });
    expect(JSON.stringify(fact)).not.toContain("summary");
  });

  it("names a connector's source over its entry point, and a person by name", async () => {
    vi.mocked(latestFactWrite).mockResolvedValue({
      ...factWrite,
      actorId: "github-sync:s1",
      actorType: "extraction",
      origin: "connector-sync",
    } as never);
    vi.mocked(resolveConnectorSource).mockResolvedValue({ name: "acme/api", type: "github" } as never);
    expect((await status()).fact).toMatchObject({ source: "acme/api", writerType: "extraction" });

    vi.mocked(latestFactWrite).mockResolvedValue({
      ...factWrite,
      actorId: "user_1",
      actorType: "human",
      origin: "app",
    } as never);
    vi.mocked(resolveConnectorSource).mockResolvedValue(null);
    vi.mocked(resolveUserNames).mockResolvedValue({ user_1: "Jane" });
    expect((await status()).fact).toMatchObject({ writer: "Jane", writerType: "human", source: "Web app" });
  });

  it("counts a fact as seen only after the person opened a change's detail", async () => {
    vi.mocked(latestFactWrite).mockResolvedValue(factWrite as never);
    auditRows({ reads: [{ action: "access.manage", target: "org_o1/audit:timeline:change", at: new Date() }] });
    expect((await status()).openedFact).toBe(false);

    // A search whose text happens to contain "/change:" is not opening a change.
    auditRows({ reads: [{ action: "memory.search", target: "org_o1/change:chg_1", at: new Date() }] });
    expect((await status()).openedFact).toBe(false);

    auditRows({ reads: [{ action: "memory.read", target: "org_o1/change:chg_1", at: new Date() }] });
    expect((await status()).openedFact).toBe(true);
    expect(queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorId: "user_1", actorType: "human", decision: "allow" }),
    );
  });

  it("looks only for a live, person-minted token below the org root", async () => {
    await status();
    expect(db.capability.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          orgId: "o1",
          issuedByPerson: true,
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
          scopePath: { startsWith: "org_o1." },
        }),
      }),
    );
  });

  it("marks the last step done only on a denial of that token's agent after it was minted", async () => {
    vi.mocked(db.capability.findFirst).mockResolvedValue({
      agentId: "reviewer",
      scopePath: "org_o1.eng.docs",
      createdAt: TOKEN_MINTED,
    } as never);

    const before = await status();
    expect(before.subScopeToken).toEqual({ agent: "reviewer Agent", scopeName: "Docs" });
    expect(before.denied).toBe(false);

    auditRows({
      denials: [{ action: "memory.read", target: "org_o1", decision: "deny", at: new Date("2026-10-14T09:59:00Z") }],
    });
    expect((await status()).denied).toBe(false);

    auditRows({
      denials: [{ action: "memory.read", target: "org_o1", decision: "deny", at: new Date("2026-10-14T10:01:00Z") }],
    });
    expect((await status()).denied).toBe(true);
    expect(queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "o1", actorId: "reviewer", actorType: "agent", decision: "deny" }),
    );
  });
});
