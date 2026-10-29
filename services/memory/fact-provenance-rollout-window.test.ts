// The deploy window in which the Node app is newer than the memory-service, run
// through the real HTTP client rather than a mocked error.
//
// Provenance resolution reads `GET /facts/{uuid}/resolve`, which the service
// gained in the same change. A service that has not caught up answers 404 (it
// serves no such path), and answered 405 while the lookup still sat on
// `/facts/{uuid}`, which `DELETE` claims. This pins what either produces end to
// end: no row, and a MemoryServiceError rather than an unresolved fact, which
// the REST door reports as a 502 (app/api/memory/facts/
// provenance-route-scope-guard.test.ts). A service that cannot be asked has not
// established that the fact is absent, and saying so would blame the caller for
// a deployment that is one commit behind.
//
// The seam is deliberately the real GraphitiMemoryStore over a stubbed `fetch`,
// not a stubbed store: the behaviour under test is the client's reading of an
// HTTP status, and a fake store cannot get that wrong.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: vi.fn(),
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test_id" }), update: vi.fn() },
    factProvenance: { create: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock("@/services/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/memory")>();
  return {
    ...actual,
    guardedMemory: new actual.GuardedMemoryStore(new actual.GraphitiMemoryStore("http://memory.test", "key") as never),
  };
});

import { db } from "@/lib/db";
import { MemoryServiceError } from "@/services/memory";
import { type AccessContext } from "@/services/access";
import { recordFactProvenance } from "./fact-provenance";

const human = (): AccessContext => ({
  orgId: "org_1",
  actor: { type: "human", id: "user_1", role: "member" },
  origin: "app",
});

const linkInput = {
  orgId: "org_1",
  scopePath: "org_1.deal_a",
  graphitiFactUuid: "fact_real",
  sourceType: "pr" as const,
  sourceRef: "github.com/acme/app/pull/42",
  ownerId: "user_1",
};

/** Every memory-service call in the window answers this status. */
const serviceAnswers = (status: number, statusText: string) =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText,
      text: async () => statusText,
      json: async () => ({}),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test_id" } as never);
  // The caller is genuinely allowed to write here, so a refusal below can only
  // come from the unresolved fact, never from the access gate.
  vi.mocked(db.$queryRaw).mockResolvedValue([{ permission: "write" }] as never);
});

describe("recordFactProvenance against a memory-service that has not caught up", () => {
  it.each([
    [404, "Not Found", "serves no such path"],
    [405, "Method Not Allowed", "still has DELETE on the path the lookup used to use"],
  ])("refuses on %i (%s) without calling the fact absent, and writes no row", async (status, statusText) => {
    serviceAnswers(status as number, statusText as string);

    // MemoryServiceError, not UnresolvedFactError: the two are unrelated classes,
    // so this fails the moment the client starts reading an absent route as an
    // absent fact.
    await expect(recordFactProvenance(human(), linkInput)).rejects.toThrow(MemoryServiceError);
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });

  it("still surfaces a genuine service fault as one, rather than as an unresolved fact", async () => {
    serviceAnswers(500, "Internal Server Error");

    await expect(recordFactProvenance(human(), linkInput)).rejects.toThrow(MemoryServiceError);
    expect(db.factProvenance.create).not.toHaveBeenCalled();
  });
});
