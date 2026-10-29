import { beforeEach, describe, expect, it, vi } from "vitest";

// PATCH /api/settings/memory-chat: the length boundary is measured on the trimmed
// name, and each 400 names its own cause and writes nothing. These kill mutants the
// route's other tests let survive (">" -> ">=",
// length taken before trimming, the JSON-parse and presence guards collapsed
// into the type check).
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { orgPreference: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";

import { PATCH } from "./route";

const owner = {
  org: { id: "org_1" },
  user: { id: "user_1", role: "owner" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_1", role: "owner" } },
};

const patch = (body: string) =>
  new Request("http://t/api/settings/memory-chat", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(owner as never);
  vi.mocked(db.orgPreference.upsert).mockImplementation((async (args: {
    update: { memoryChatName: string | null };
  }) => ({
    memoryChatName: args.update.memoryChatName,
  })) as never);
});

describe("PATCH /api/settings/memory-chat length boundary", () => {
  it("accepts a name of exactly 100 characters", async () => {
    const name = "a".repeat(100);
    const res = await PATCH(patch(JSON.stringify({ memoryChatName: name })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ memoryChatName: name });
  });

  it("measures the limit after trimming, so surrounding spaces do not count", async () => {
    const name = "b".repeat(100);
    const res = await PATCH(patch(JSON.stringify({ memoryChatName: `   ${name}   ` })));
    expect(res.status).toBe(200);
    expect(db.orgPreference.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { memoryChatName: name } }));
  });
});

describe("PATCH /api/settings/memory-chat refusals name their cause", () => {
  it("malformed JSON is reported as such and writes nothing", async () => {
    const res = await PATCH(patch("{ not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid json body" });
    expect(db.orgPreference.upsert).not.toHaveBeenCalled();
  });

  it("a body without memoryChatName says the field is required", async () => {
    const res = await PATCH(patch(JSON.stringify({ toneOverride: "warm" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "memoryChatName is required" });
    expect(db.orgPreference.upsert).not.toHaveBeenCalled();
  });

  it.each([["null"], ["[]"], ['"Jane"']])("a non-object JSON body %s writes nothing", async (body) => {
    const res = await PATCH(patch(body));
    expect(res.status).toBe(400);
    expect(db.orgPreference.upsert).not.toHaveBeenCalled();
  });
});
