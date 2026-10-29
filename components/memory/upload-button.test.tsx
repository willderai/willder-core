// @vitest-environment jsdom
//
// Standing regression test for the client FormData scope-append in
// upload-button.tsx's binary upload branch. Reverting that one line left the
// wider test suite green because nothing rendered the component and drove a
// real upload. A capability scoped to a deal/scope that uploads a
// PDF/DOCX/image must have that scope actually land in the multipart body
// the browser sends — dropping the `form.append("scope", scope)` call is
// exactly the bug that shipped once already and read the upload back
// org-wide.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { UploadButton } from "./upload-button";

vi.mock("@/components/posthog-provider", () => ({ useAnalytics: () => undefined }));

// Not in the finally-block position inside each test: an assertion failure
// partway through a test would otherwise leave the stub in place for the
// next one.
afterEach(() => {
  vi.unstubAllGlobals();
});

function pdfFile(name = "contract.pdf") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

function selectFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

describe("UploadButton binary branch — scope append", () => {
  it("appends the selected scope to the multipart FormData sent to /api/memory/upload", async () => {
    let sentForm: FormData | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/memory/upload") {
        sentForm = init?.body as FormData;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onUploaded = vi.fn();
    const { container } = render(<UploadButton scope="deal-123" onUploaded={onUploaded} onError={() => {}} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    selectFile(input, pdfFile());

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("contract.pdf"));

    expect(sentForm).not.toBeNull();
    expect(sentForm!.get("scope")).toBe("deal-123");
    expect((sentForm!.get("file") as File).name).toBe("contract.pdf");
  });

  it("omits the scope field entirely when no scope is selected (not an empty string)", async () => {
    let sentForm: FormData | null = null;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/memory/upload") {
        sentForm = init?.body as FormData;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onUploaded = vi.fn();
    const { container } = render(<UploadButton scope={null} onUploaded={onUploaded} onError={() => {}} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    selectFile(input, pdfFile("note.png"));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("note.png"));

    expect(sentForm).not.toBeNull();
    expect(sentForm!.has("scope")).toBe(false);
  });
});
