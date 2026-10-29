import { beforeEach, describe, expect, it, vi } from "vitest";

// The binary upload path (PDF/DOCX/image, POST /api/memory/upload) must honor the
// caller-selected scope. Without it, both ingest legs run with `scopePath:
// undefined`, which is the MOST PERMISSIVE value on both storage backends
// (pgvector-store.ts's `scopePath IS NULL` clause matches every scoped read;
// graphiti-store.ts partitions a null-scope ingest under the bare org id, which
// guarded-store.ts's own bare-org fallback re-query then merges in with no second
// check) — so a PDF uploaded with a scope selected in the UI would land org-wide,
// readable by every scoped caller in the tenant, while the identical content as
// .txt is confined via /api/memory/ingest's `scope ?? orgRootPath(...)`.
//
// This file pins the WRITE-side half: the route resolves the caller-supplied
// "scope" FormData field through the same shared write-direction helper
// (resolveCallerScopePath) the other write paths use — falling back to the org
// root when the field is absent (parity with the text path, not a stricter "scope
// is mandatory" rule — the ScopePicker's own default is no selection,
// memory-workbench.tsx), but refusing outright on an explicit, malformed value
// rather than silently widening it away. services/memory/binary-upload-scope-
// leak.eval.test.ts pairs this with the READ-side half: once tagged correctly
// here, a sibling-scoped capability token still can't see the content.
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
  graphitiStore: { extractBytes: vi.fn().mockResolvedValue({ chunks: ["extracted chunk"] }) },
}));
vi.mock("@/services/memory/uploads", () => ({
  recordUpload: vi.fn(),
  recordUploadDocument: vi.fn().mockResolvedValue(undefined),
  discardUnqueuedUpload: vi.fn().mockResolvedValue(undefined),
}));
// Real resolveCallerScopePath/orgRootPath/isValidLtreePath/normalizeScopePath/
// AccessDeniedError (the actual write-direction contract under test) — only check()
// itself is stubbed, same boundary plan-routes-scope-guard.test.ts draws.
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { db } from "@/lib/db";
import { inngest, storeFilePassages } from "@/lib/inngest";
import { graphitiStore } from "@/services/memory";
import { discardUnqueuedUpload, recordUpload, recordUploadDocument } from "@/services/memory/uploads";
import { check, orgRootPath } from "@/services/access";
import { POST } from "./upload/route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42", name: "Alex", email: "alex@example.com" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

/** A space is invalid ltree syntax (42601). */
const MALFORMED = "org_1.deal A";

function uploadReq(fields: Record<string, string | undefined>) {
  const form = new FormData();
  form.append("file", new File(["file contents"], fields.filename ?? "contract.pdf", { type: "application/pdf" }));
  if (fields.scope !== undefined) form.append("scope", fields.scope);
  // A real upload always carries a Content-Length (the multipart body isn't streamed, so
  // the browser knows the size upfront) — Node's Request doesn't set one automatically for
  // a FormData body, so these scope-focused tests set an explicit, honest-enough one here
  // to stay past the Content-Length gate without exercising it (that gate has its own
  // dedicated coverage in upload-route-content-length-gate.test.ts).
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
  vi.mocked(db.auditLog.create).mockResolvedValue({ id: "audit_test" } as never);
  // extractBytes isn't part of MemoryStore's public interface, it's real only on
  // GraphitiMemoryStore -- route.ts calls it on `graphitiStore`.
  vi.mocked(graphitiStore.extractBytes).mockResolvedValue({
    chunks: ["extracted chunk"],
  } as never);
  vi.mocked(inngest.send).mockResolvedValue({ ids: ["job_1"] } as never);
  vi.mocked(recordUpload).mockResolvedValue({ id: "upl_1" });
  delete process.env.BLOB_READ_WRITE_TOKEN; // exercise the dev/no-Blob leg by default
});

describe("POST /api/memory/upload — dev/no-Blob leg", () => {
  it("a selected scope reaches the stored passages", async () => {
    await POST(uploadReq({ scope: "org_1.dealA" }));

    expect(storeFilePassages).toHaveBeenCalledWith(
      expect.objectContaining({ scopePath: "org_1.dealA" }),
      ["extracted chunk"],
      expect.any(String),
    );
    expect(check).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: "org_1.dealA" }));
  });

  it("no scope selected falls back to the org root — parity with the text path's `scope ?? orgRootPath(...)`, not a silently-null scope", async () => {
    await POST(uploadReq({}));

    expect(storeFilePassages).toHaveBeenCalledWith(
      expect.objectContaining({ scopePath: orgRootPath("org_1") }),
      ["extracted chunk"],
      expect.any(String),
    );
    // scopePath must never reach the ingest leg
    // as undefined, which pgvector/graphiti each treat as the most-permissive value.
    const call = vi.mocked(storeFilePassages).mock.calls[0][0];
    expect(call.scopePath).toBeDefined();
  });

  it("an explicit, malformed scope is refused (403) — never silently widened, never ingested", async () => {
    const res = await POST(uploadReq({ scope: MALFORMED }));

    expect(res.status).toBe(403);
    expect(storeFilePassages).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orgId: "org_1",
          actorId: "user_42",
          decision: "deny",
          target: MALFORMED,
        }),
      }),
    );
  });

  it("the PostHog completion event's scope claim (upload-button.tsx) is true: the exact selected value is what actually got ingested", async () => {
    await POST(uploadReq({ scope: "org_1.dealA.notes" }));
    expect(storeFilePassages).toHaveBeenCalledWith(
      expect.objectContaining({ scopePath: "org_1.dealA.notes" }),
      ["extracted chunk"],
      expect.any(String),
    );
  });
});

describe("POST /api/memory/upload — production Blob leg", () => {
  let mockPut: ReturnType<typeof vi.fn>;
  let mockDel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.BLOB_READ_WRITE_TOKEN = "test_token";
    mockPut = vi.fn().mockResolvedValue({ url: "https://blob.example/memory/org_1/contract.pdf" });
    mockDel = vi.fn().mockResolvedValue(undefined);
    vi.doMock("@vercel/blob", () => ({ put: mockPut, del: mockDel }));
  });

  it("a selected scope reaches the Inngest FILE_INGEST_EVENT payload", async () => {
    await POST(uploadReq({ scope: "org_1.dealA" }));

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scopePath: "org_1.dealA" }),
      }),
    );
  });

  it("no scope selected still falls back to the org root on the production leg too", async () => {
    await POST(uploadReq({}));

    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scopePath: orgRootPath("org_1") }),
      }),
    );
  });

  it("a malformed scope is refused before Blob/Inngest are ever touched", async () => {
    const res = await POST(uploadReq({ scope: MALFORMED }));

    expect(res.status).toBe(403);
    expect(inngest.send).not.toHaveBeenCalled();
  });

  // This call site (memory/<orgId>/<filename>, no addRandomSuffix — @vercel/blob's
  // own default) builds a fully deterministic path, and the org id is not secret
  // (returned by /api/contacts et al), so access:'public' would make every uploaded
  // source document a public, unauthenticated, permanent URL to anyone who could
  // guess or was handed it — entirely outside check(), separate from the
  // derived-fact scope rule above.
  it("uploads to Blob with access:'private', not 'public'", async () => {
    await POST(uploadReq({}));

    expect(mockPut).toHaveBeenCalledWith(
      "memory/org_1/contract.pdf",
      expect.anything(),
      expect.objectContaining({ access: "private" }),
    );
  });

  it("records the upload with its blob and scope, tells the job which upload it is, and keeps the blob", async () => {
    const res = await POST(uploadReq({ scope: "org_1.dealA" }));

    expect(recordUpload).toHaveBeenCalledExactlyOnceWith({
      orgId: "org_1",
      scopePath: "org_1.dealA",
      filename: "contract.pdf",
      fileType: "pdf",
      blobUrl: "https://blob.example/memory/org_1/contract.pdf",
      actorId: "user_42",
    });
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ uploadId: "upl_1" }) }),
    );
    expect(recordUploadDocument).toHaveBeenCalledExactlyOnceWith("org_1", "upl_1", "job_1");
    expect(await res.json()).toEqual({ jobId: "job_1", uploadId: "upl_1" });
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("discards the upload when the extraction job cannot be queued, since the person is told it failed", async () => {
    vi.mocked(inngest.send).mockRejectedValueOnce(new Error("inngest unavailable"));

    await expect(POST(uploadReq({}))).rejects.toThrow("inngest unavailable");

    expect(discardUnqueuedUpload).toHaveBeenCalledExactlyOnceWith("org_1", "upl_1");
  });

  it("deletes the stored blob when the upload cannot be recorded, since nothing could find it to remove", async () => {
    vi.mocked(recordUpload).mockRejectedValueOnce(new Error("database unavailable"));

    await expect(POST(uploadReq({}))).rejects.toThrow("database unavailable");

    expect(mockDel).toHaveBeenCalledExactlyOnceWith("https://blob.example/memory/org_1/contract.pdf");
    expect(inngest.send).not.toHaveBeenCalled();
  });
});
