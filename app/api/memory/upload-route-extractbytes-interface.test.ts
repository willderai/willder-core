import { beforeEach, describe, expect, it, vi } from "vitest";

// Uploading a real PDF into a memory write must not throw
// "memory.extractBytes is not a function".
//
// This route's dev/no-Blob fallback (and app/api/agents/attachments/
// extract/route.ts, the twin call site) must call extraction on `graphitiStore`.
// `memory` is the HybridMemoryStore facade (services/memory/store.ts) -- extractBytes
// exists only on GraphitiMemoryStore (graphiti-store.ts), never on HybridMemoryStore
// or the MemoryStore interface it implements, and an `(memory as any).extractBytes(...)`
// cast silences the compiler but does nothing about the missing method at runtime.
// lib/inngest.ts's fileIngest job (the production Blob-upload leg's extraction path)
// calls extraction the same way, through `graphitiStore` -- the raw Graphiti
// singleton also exported from services/memory.
//
// This file pins that both routes call `graphitiStore.extractBytes`, no cast needed
// since graphitiStore is properly typed with a real extractBytes method. The mock
// below deliberately gives `memory` no extractBytes at all (mirroring the real
// HybridMemoryStore): with route.ts's import pointed back at `memory`, this test's
// first assertion fails with exactly "memory.extractBytes is not a function" via
// the route's own 502 catch.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3600 } }));
vi.mock("@/lib/db", () => ({
  db: { auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }) } },
}));
vi.mock("@/lib/inngest", () => ({
  FILE_INGEST_EVENT: "memory/file.ingest.requested",
  inngest: { send: vi.fn().mockResolvedValue({ ids: ["job_1"] }) },
  storeFilePassages: vi.fn().mockResolvedValue({ outcome: "stored", stored: 1, chunkIds: ["chunk-1"] }),
  extractFileGraph: vi.fn().mockResolvedValue(undefined),
}));
// Outside a request scope the real after() throws; the route only hands it the graph work.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("@/services/memory", () => ({
  // No extractBytes here on purpose -- the real HybridMemoryStore has none.
  memory: {},
  graphitiStore: {
    extractBytes: vi.fn().mockResolvedValue({ chunks: ["Appointment confirmed for 3pm Tuesday."] }),
  },
}));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { storeFilePassages } from "@/lib/inngest";
import { graphitiStore } from "@/services/memory";
import { check } from "@/services/access";
import { POST } from "./upload/route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42", name: "Alex", email: "alex@example.com" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

/** The exact real-world repro: a PDF upload through the dev/no-Blob extraction leg. */
function uploadPdfReq(filename = "Appointment Scheduled (2).pdf") {
  const form = new FormData();
  form.append("file", new File(["%PDF-1.4 fake bytes"], filename, { type: "application/pdf" }));
  return new Request("http://t/api/memory/upload", {
    method: "POST",
    headers: { "content-length": "1024" },
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  delete process.env.BLOB_READ_WRITE_TOKEN; // exercise the dev/no-Blob leg
});

describe("POST /api/memory/upload — PDF extraction calls the store that actually has extractBytes", () => {
  it("uploading a PDF succeeds (202) instead of 502ing on a missing extractBytes method", async () => {
    const res = await POST(uploadPdfReq());
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({ jobId: expect.any(String), chunks: 1 });
  });

  it("extraction is called on graphitiStore, not on the memory facade", async () => {
    await POST(uploadPdfReq());

    expect(graphitiStore.extractBytes).toHaveBeenCalledWith(
      expect.objectContaining({ fileType: "pdf", filename: "Appointment Scheduled (2).pdf" }),
    );
  });

  it("the extracted chunk actually reaches the file's stored passages", async () => {
    await POST(uploadPdfReq());

    expect(storeFilePassages).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "Appointment Scheduled (2).pdf" }),
      ["Appointment confirmed for 3pm Tuesday."],
      expect.any(String),
    );
  });
});
