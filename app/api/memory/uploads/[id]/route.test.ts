// Mocked: needs no database. The routes are thin: the service decides access
// (services/memory/uploads.ts, tested against real Postgres in
// lib/inngest.raw-file-lifecycle.realdb.test.ts). These pin what the routes add: no
// session is 401, anything the service will not hand over is one 404, and the file goes
// back as a download, never rendered inline.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/access-context", () => ({ requireAccessContext: vi.fn() }));
vi.mock("@/services/memory/uploads", () => ({ readUploadFile: vi.fn(), removeUpload: vi.fn() }));

import { requireAccessContext } from "@/lib/access-context";
import { readUploadFile, removeUpload } from "@/services/memory/uploads";
import { DELETE, GET } from "./route";

const ctx = { orgId: "org_1", actor: { type: "human", id: "user_42", role: "member" }, origin: "app" };
const params = { params: Promise.resolve({ id: "upl_1" }) };
const req = new Request("http://t/api/memory/uploads/upl_1");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAccessContext).mockResolvedValue({ ctx } as never);
});

describe("GET /api/memory/uploads/:id", () => {
  it("is 401 without a session, and asks the service nothing", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await GET(req, params)).status).toBe(401);
    expect(readUploadFile).not.toHaveBeenCalled();
  });

  it("is 404 for an upload the service will not hand over", async () => {
    vi.mocked(readUploadFile).mockResolvedValue(null);
    const res = await GET(req, params);
    expect(res.status).toBe(404);
    expect(readUploadFile).toHaveBeenCalledExactlyOnceWith(ctx, "upl_1");
  });

  it("sends the raw file as a download under its own name", async () => {
    vi.mocked(readUploadFile).mockResolvedValue({
      filename: "Q3 plan.pdf",
      fileType: "pdf",
      body: new Blob(["%PDF"]).stream(),
    });
    const res = await GET(req, params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''Q3%20plan.pdf");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("%PDF");
  });
});

describe("DELETE /api/memory/uploads/:id", () => {
  it("is 401 without a session, and removes nothing", async () => {
    vi.mocked(requireAccessContext).mockResolvedValue(null);
    expect((await DELETE(req, params)).status).toBe(401);
    expect(removeUpload).not.toHaveBeenCalled();
  });

  it("is 404 when the service removed nothing", async () => {
    vi.mocked(removeUpload).mockResolvedValue({ removed: false, passages: 0 });
    expect((await DELETE(req, params)).status).toBe(404);
  });

  it("reports how many passages went with the upload", async () => {
    vi.mocked(removeUpload).mockResolvedValue({ removed: true, passages: 3 });
    const res = await DELETE(req, params);
    expect(await res.json()).toEqual({ removed: true, passagesRemoved: 3 });
    expect(removeUpload).toHaveBeenCalledExactlyOnceWith(ctx, "upl_1");
  });
});
