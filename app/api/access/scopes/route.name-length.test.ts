// POST /api/access/scopes holds a scope's name to SCOPE_NAME_MAX (services/access/scope-name.ts):
// a longer name is refused with the rule's message before anything is looked up or written.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { scope: { findUnique: vi.fn() }, $transaction: vi.fn() } }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  authorizeRecord: vi.fn(),
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { authorizeRecord } from "@/services/access";
import { SCOPE_NAME_MAX, scopeNameTooLong } from "@/services/access/scope-name";
import { POST } from "./route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_1" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_1", role: "admin" }, origin: "app" },
};
const post = (name: string) =>
  POST(new Request("http://test/api/access/scopes", { method: "POST", body: JSON.stringify({ name }) }));

describe("a scope name's length", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
    vi.mocked(authorizeRecord).mockResolvedValue({ status: "allowed", record: { path: "org_org_1" } } as never);
    vi.mocked(db.$transaction).mockImplementation((async (fn: (tx: unknown) => unknown) =>
      fn({
        scope: {
          create: vi.fn(async ({ data }: { data: { path: string; name: string } }) => ({
            id: "scope_1",
            ...data,
            createdAt: new Date(0),
          })),
        },
        grant: { create: vi.fn(async () => ({ id: "grant_1" })) },
      })) as never);
  });

  it.each([
    ["at the limit", "a".repeat(SCOPE_NAME_MAX), null],
    ["one past it", "a".repeat(SCOPE_NAME_MAX + 1), "refused"],
    ["at the limit in two-unit characters", "\u{1F600}".repeat(SCOPE_NAME_MAX), null],
    ["far past it", "x".repeat(400_000), "refused"],
  ])("counts characters %s", (_case, name, expected) => {
    expect(scopeNameTooLong(name) === null ? null : "refused").toBe(expected);
  });

  it("creates a scope whose name is at the limit", async () => {
    const res = await post("a".repeat(SCOPE_NAME_MAX));
    expect(res.status).toBe(201);
  });

  it("refuses a longer name with the rule's message, and looks nothing up and writes nothing", async () => {
    const res = await post("a".repeat(SCOPE_NAME_MAX + 1));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(scopeNameTooLong("a".repeat(SCOPE_NAME_MAX + 1)));
    expect(authorizeRecord).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
