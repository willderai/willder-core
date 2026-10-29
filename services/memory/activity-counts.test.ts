import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: { $queryRaw: vi.fn() } }));

import { db } from "@/lib/db";
import { countNewChunksInScopes } from "./activity-counts";

describe("countNewChunksInScopes", () => {
  // The caller decides what a failed count means; a 0 here would be reported as
  // "nothing new" (app/api/nav/badges/route.ts).
  it("rejects when the count query fails instead of answering 0", async () => {
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error("connection terminated"));
    await expect(countNewChunksInScopes("org_1", ["org_1"], new Date(0))).rejects.toThrow("connection terminated");
  });

  it("answers 0 without querying for a caller with no readable scope", async () => {
    vi.mocked(db.$queryRaw).mockClear();
    await expect(countNewChunksInScopes("org_1", [], new Date(0))).resolves.toBe(0);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
