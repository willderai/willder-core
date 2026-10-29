// A bare count of out-of-scope rows in the response still tells a caller "a
// provenance row for this sourceRef exists in a scope you can't see," the same
// existence leak the route's own comment forbids. services/memory/fact-provenance.test.ts
// covers the internal enforcement order (scope checked before the no-revision
// bucket); this file is the route-boundary assertion that the leak can't come
// back through the response shape even if a future change re-adds the field to
// checkFactStaleness's return value.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/fact-provenance", () => ({ checkFactStaleness: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { checkFactStaleness } from "@/services/memory/fact-provenance";
import { POST } from "./route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_1" },
  ctx: { orgId: "org_1", actor: { type: "human" as const, id: "user_1", role: "member" as const } },
};

const post = (body: unknown) =>
  new Request("http://t/api/memory/facts/staleness-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
});

describe("POST /api/memory/facts/staleness-check — out-of-scope existence oracle", () => {
  it("never surfaces skippedOutOfScope, as a count or otherwise, even when out-of-scope rows matched", async () => {
    vi.mocked(checkFactStaleness).mockResolvedValue({
      flagged: [],
      skippedOutOfScope: ["prov_hidden_1", "prov_hidden_2"],
      skippedNoRevision: [],
    });

    const res = await POST(
      post({ sourceType: "pr", sourceRef: "github.com/acme/app/pull/42", currentRevision: "sha_new" }),
    );
    const json = await res.json();

    expect(json).not.toHaveProperty("skippedOutOfScopeCount");
    expect(json).not.toHaveProperty("skippedOutOfScope");
    expect(JSON.stringify(json)).not.toContain("prov_hidden");
    expect(json).toEqual({ flagged: [], flaggedCount: 0, skippedNoRevisionCount: 0 });
  });

  it("still reports flagged rows and the no-revision count for in-scope matches", async () => {
    vi.mocked(checkFactStaleness).mockResolvedValue({
      flagged: [{ id: "prov_1", graphitiFactUuid: "fact_1", ownerId: "user_1", scopePath: "org_1.scope_a" }],
      skippedOutOfScope: [],
      skippedNoRevision: ["prov_2"],
    });

    const res = await POST(
      post({ sourceType: "pr", sourceRef: "github.com/acme/app/pull/42", currentRevision: "sha_new" }),
    );
    const json = await res.json();

    expect(json).toEqual({
      flagged: [{ id: "prov_1", graphitiFactUuid: "fact_1", ownerId: "user_1", scopePath: "org_1.scope_a" }],
      flaggedCount: 1,
      skippedNoRevisionCount: 1,
    });
  });
});

describe("POST /api/memory/facts/staleness-check — sourceType is required", () => {
  it("400s on a missing sourceType, never reaching checkFactStaleness", async () => {
    const res = await POST(post({ sourceRef: "github.com/acme/app/pull/42", currentRevision: "sha_new" }));

    expect(res.status).toBe(400);
    expect(checkFactStaleness).not.toHaveBeenCalled();
  });

  it("400s on an invalid sourceType", async () => {
    const res = await POST(
      post({ sourceType: "issue", sourceRef: "github.com/acme/app/pull/42", currentRevision: "sha_new" }),
    );

    expect(res.status).toBe(400);
    expect(checkFactStaleness).not.toHaveBeenCalled();
  });

  it("passes a valid sourceType through to checkFactStaleness", async () => {
    vi.mocked(checkFactStaleness).mockResolvedValue({ flagged: [], skippedOutOfScope: [], skippedNoRevision: [] });

    await POST(post({ sourceType: "commit", sourceRef: "abc123", currentRevision: "sha_new" }));

    expect(checkFactStaleness).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceType: "commit", sourceRef: "abc123" }),
    );
  });
});
