// POST /api/memory/import: how each refusal from services/memory/org-import.ts reaches the
// caller. The import itself is covered against real Postgres in services/memory/org-*.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/org-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory/org-import")>();
  return { ...actual, importMemory: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { ImportIncompleteError, importMemory, ImportRefusedError } from "@/services/memory/org-import";
import { POST } from "./route";

const ctx = {
  orgId: "org1",
  actor: { type: "human" as const, id: "u1", role: "admin" as const },
  origin: "app" as const,
};
const post = () =>
  POST(new Request("http://localhost/api/memory/import", { method: "POST", body: '{"type":"manifest"}\n' }));

describe("POST /api/memory/import", () => {
  beforeEach(() => {
    vi.mocked(requireAccessContext).mockResolvedValue({ ctx } as Awaited<ReturnType<typeof requireAccessContext>>);
  });

  it("answers 422 with the reason when the file or the org is refused", async () => {
    vi.mocked(importMemory).mockRejectedValueOnce(
      new ImportRefusedError("This org already holds memory. Import into a new, empty org."),
    );
    const res = await post();
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "This org already holds memory. Import into a new, empty org." });
  });

  it("answers 503, saying the file is fine, when re-applying the org's erasures failed and the import was undone", async () => {
    vi.mocked(importMemory).mockRejectedValueOnce(new ImportIncompleteError(new Error("graph down")));
    const res = await post();
    expect(res.status).toBe(503);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/undone/);
    expect(error).toMatch(/import it again/);
    expect(error).not.toContain("graph down");
  });
});
