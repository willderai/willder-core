// POST /api/memory/ingest refuses a NUL in content, name or source with a 400 that names
// the field, before sanitizing (which would silently strip it from content) and before
// anything is queued. Each field is sent on its own, so dropping any one of them from the
// route's guard fails exactly that case; a clean body in the same harness is accepted.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/inngest", () => ({ ingestMemory: vi.fn().mockResolvedValue({}) }));
vi.mock("@/services/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/access")>()),
  check: vi.fn(),
}));

import { requireAccessContext } from "@/lib/access-context";
import { ingestMemory } from "@/lib/inngest";
import { check } from "@/services/access";
import { POST } from "./route";

const NUL = "\u0000";
const clean = { content: "Refunds are owned by payments.", name: "Refund owner", source: "api" };
const rc = {
  org: { id: "org_nul" },
  user: { id: "user_nul", name: "QA" },
  ctx: { orgId: "org_nul", origin: "app", actor: { type: "human", id: "user_nul", role: "admin" } },
};
const post = (body: unknown) =>
  new Request("http://t/api/memory/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok", auditLogId: "audit_1" } as never);
});

describe("POST /api/memory/ingest with a NUL", () => {
  it.each(["content", "name", "source"] as const)(
    "400 naming %s when only %s holds a NUL; nothing queued",
    async (field) => {
      const res = await POST(post({ ...clean, [field]: `${clean[field]}${NUL}tail` }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(
        `${field} contains a NUL (\\u0000) character, which cannot be stored. Remove it and retry.`,
      );
      expect(ingestMemory).not.toHaveBeenCalled();
    },
  );

  it("control: the same body without a NUL is accepted and queued", async () => {
    const res = await POST(post(clean));
    expect(res.status).toBe(202);
    expect(ingestMemory).toHaveBeenCalledTimes(1);
  });
});
