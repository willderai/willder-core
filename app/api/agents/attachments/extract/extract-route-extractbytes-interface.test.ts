import { beforeEach, describe, expect, it, vi } from "vitest";

// Twin of upload-route-extractbytes-interface.test.ts for the attachment
// extraction route: extraction must call the store that actually has
// extractBytes.
//
// `memory` is the HybridMemoryStore facade (services/memory/store.ts); extractBytes
// exists only on GraphitiMemoryStore (graphiti-store.ts). The mock below gives
// `memory` no extractBytes at all, mirroring the real facade, so calling it there is
// a real TypeError caught by the route's own 502 handler ("memory.extractBytes is
// not a function"). With the route pointed at `memory`, the first two tests fail
// with that 502; pointed at `graphitiStore`, all four pass.
vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false), per: { hour: 3600 } }));
vi.mock("@/services/memory", () => ({
  // No extractBytes here on purpose — the real HybridMemoryStore never had one.
  memory: {},
  graphitiStore: {
    extractBytes: vi.fn().mockResolvedValue({
      chunks: ["Appointment confirmed for 3pm Tuesday.", "Bring the signed form."],
    }),
  },
}));
vi.mock("@/services/access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/access")>();
  return { ...actual, check: vi.fn() };
});
// lib/sanitize is deliberately NOT mocked: the route's 422 injection/empty-text gates
// are real behavior this extraction path feeds, and a fake sanitizer would let a
// broken join() through unnoticed.

import { requireAccessContext } from "@/lib/access-context";
import { graphitiStore } from "@/services/memory";
import { check } from "@/services/access";
import { POST } from "./route";

const rc = {
  org: { id: "org_1" },
  user: { id: "user_42", name: "Alex", email: "alex@example.com" },
  ctx: { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" } },
};

/** The same real-world repro as the upload route's test: a PDF attachment. */
function attachPdfReq(filename = "Appointment Scheduled (2).pdf") {
  const form = new FormData();
  form.append("file", new File(["%PDF-1.4 fake bytes"], filename, { type: "application/pdf" }));
  return new Request("http://t/api/agents/attachments/extract", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue(rc as never);
  vi.mocked(check).mockResolvedValue({ allowed: true, reason: "ok" } as never);
});

describe("POST /api/agents/attachments/extract — extraction calls the store that actually has extractBytes", () => {
  it("attaching a PDF succeeds (200) instead of 502ing on a missing extractBytes method", async () => {
    const res = await POST(attachPdfReq());

    expect(res.status).toBe(200);
  });

  it("extraction is called on graphitiStore, not on the memory facade", async () => {
    await POST(attachPdfReq());

    expect(graphitiStore.extractBytes).toHaveBeenCalledWith(
      expect.objectContaining({ fileType: "pdf", filename: "Appointment Scheduled (2).pdf" }),
    );
  });

  it("every extracted chunk reaches the returned content, joined not truncated", async () => {
    const res = await POST(attachPdfReq());
    const body = await res.json();

    expect(body.name).toBe("Appointment Scheduled (2).pdf");
    expect(body.content).toBe("Appointment confirmed for 3pm Tuesday.\n\nBring the signed form.");
  });

  it("a plain-text attachment never reaches extractBytes at all", async () => {
    const form = new FormData();
    form.append("file", new File(["just some notes"], "notes.txt", { type: "text/plain" }));
    const res = await POST(new Request("http://t/api/agents/attachments/extract", { method: "POST", body: form }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.content).toBe("just some notes");
    expect(graphitiStore.extractBytes).not.toHaveBeenCalled();
  });
});
