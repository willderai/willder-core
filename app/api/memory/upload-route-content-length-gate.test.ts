import { beforeEach, describe, expect, it, vi } from "vitest";

// The MAX_UPLOAD_BYTES gate in route.ts must reject more than the honest-oversized
// case (a real Content-Length header over the cap). Number(null) is 0, which passes
// Number.isFinite, so an absent Content-Length (e.g. a chunked request) would
// otherwise slip straight past the gate and into req.formData() — a full multipart
// parse — before check() ever got a chance to deny an authenticated caller with no
// write grant; a garbage (NaN) or negative header the same. Still bounded by the
// 20/hour rate limit, but the gate's guarantee ("never more than MAX_UPLOAD_BYTES
// of multipart parsing first") has to hold on those paths too.
//
// This file pins that a missing, non-numeric, or negative Content-Length is
// rejected outright (413) before req.formData() ever runs. The honest
// oversized/undersized cases keep their behavior — this file only adds the paths
// upload-route-scope-guard.test.ts never exercises.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3600 } }));
vi.mock("@/lib/db", () => ({
  db: { auditLog: { create: vi.fn().mockResolvedValue({ id: "audit_test" }) } },
}));
vi.mock("@/lib/inngest", () => ({
  FILE_INGEST_EVENT: "memory/file.ingest.requested",
  inngest: { send: vi.fn().mockResolvedValue({ ids: ["job_1"] }) },
  ingestMemory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/memory", () => ({
  graphitiStore: { extractBytes: vi.fn().mockResolvedValue({ chunks: ["extracted chunk"] }) },
}));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});

import { requireAccessContext } from "@/lib/access-context";
import { check } from "@/services/access";
import { POST } from "./upload/route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42", name: "Alex", email: "alex@example.com" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Builds the request the same way a real multipart upload arrives, but lets the
 * Content-Length header be set (or omitted) independently of the actual body — the
 * exact gap this gate has to close, since a caller fully controls that header.
 */
function uploadReq(contentLength: string | undefined) {
  const form = new FormData();
  form.append("file", new File(["file contents"], "contract.pdf", { type: "application/pdf" }));
  const headers: Record<string, string> = {};
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  return new Request("http://t/api/memory/upload", { method: "POST", headers, body: form });
}

/** A real formData() spy on the actual Request instance, not a route-level mock. */
function spyOnFormData(req: Request) {
  return vi.spyOn(req, "formData");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

describe("POST /api/memory/upload — Content-Length gate fails closed", () => {
  it("an absent Content-Length header is rejected with 413 before formData() ever runs", async () => {
    const req = uploadReq(undefined);
    const formDataSpy = spyOnFormData(req);

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });

  it("a non-numeric (garbage) Content-Length header is rejected with 413 before formData()", async () => {
    const req = uploadReq("not-a-number");
    const formDataSpy = spyOnFormData(req);

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it("a negative Content-Length header is rejected with 413 before formData()", async () => {
    const req = uploadReq("-1");
    const formDataSpy = spyOnFormData(req);

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it("an honest, in-range Content-Length reaches formData()", async () => {
    const req = uploadReq("1024");
    const formDataSpy = spyOnFormData(req);

    const res = await POST(req);

    expect(formDataSpy).toHaveBeenCalledTimes(1);
    expect(res.status).not.toBe(413);
  });

  it("an honest, over-cap Content-Length is rejected with 413 and never calls formData()", async () => {
    const req = uploadReq(String(MAX_UPLOAD_BYTES + 1));
    const formDataSpy = spyOnFormData(req);

    const res = await POST(req);

    expect(res.status).toBe(413);
    expect(formDataSpy).not.toHaveBeenCalled();
  });
});
