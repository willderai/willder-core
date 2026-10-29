// The invariant: a Vercel Blob `put()` must never be called with public
// access, because a blob holds customer memory content and a public blob URL
// is unauthenticated, permanent, and reachable by anyone who can guess or is
// handed it.
//
// The invariant is now structural, enforced in two halves:
//
//   1. lib/blob-storage.ts is the only module that calls the Blob SDK, and it
//      writes `access: "private"` itself -- the access level is not a
//      parameter any caller can pass. That is what this file tests.
//   2. eslint.blob-access.mjs fails the build on any other module importing
//      `@vercel/blob`, in static, re-export, dynamic-`import()` or `require()`
//      form. That is what keeps half 1 true, and `npm run scope-gate:check`
//      and `npm run lint:ratchet` both gate on it in CI.
//
// This replaces an earlier version of this file that read the repository's
// SOURCE and asserted over a hard-coded list of file paths that called put().
// It enforced the same invariant, but it was coupled to where the code lived:
// moving a call site to another file failed it even though no blob had become
// public. Reading source was also the only option at the time, because the
// second call site sat inside an Inngest handler that no test could invoke.
// A wrapper removes both problems: there is one tiny function to call
// directly, and the lint rule covers the whole repository without a list.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { put, del, list, get } = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn(), list: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/blob", () => ({ put, del, list, get }));

import { deletePrivateBlob, listPrivateBlobs, putPrivateBlob, readPrivateBlob } from "./blob-storage";

describe("putPrivateBlob", () => {
  beforeEach(() => {
    put.mockReset();
    put.mockResolvedValue({ url: "https://blob.example/stored" });
  });

  it("stores with access:'private', never 'public'", async () => {
    const body = Buffer.from("contract bytes");

    await putPrivateBlob("memory/org_1/contract.pdf", body);

    expect(put).toHaveBeenCalledExactlyOnceWith("memory/org_1/contract.pdf", body, {
      access: "private",
      addRandomSuffix: true,
    });
  });

  it("returns the stored blob's URL, which is how callers reach it again", async () => {
    await expect(putPrivateBlob("sources/org_1/src_1/spec.pdf", Buffer.from("x"))).resolves.toEqual({
      url: "https://blob.example/stored",
    });
  });

  it("lets the caller choose the pathname and the body, and nothing else", async () => {
    // The signature is the invariant: there is no options argument, so no call
    // site can reach `access` at all. A `put()` option added later must be
    // added here deliberately, in front of a reviewer.
    expect(putPrivateBlob).toHaveLength(2);
  });

  it("ignores a third argument, so a forwarded options bag cannot reach access", async () => {
    // toHaveLength above counts only parameters without a default, so an
    // `options: { access?: string } = {}` passthrough added later would leave
    // it at 2 and still hand `access` straight to the SDK. This calls the
    // wrapper the way such a passthrough would be used -- past its declared
    // arity, which is what the cast is for -- and asserts the SDK still sees
    // private access.
    const callWithExtraArgument = putPrivateBlob as unknown as (
      pathname: string,
      body: Buffer,
      options: unknown,
    ) => Promise<unknown>;

    await callWithExtraArgument("memory/org_1/contract.pdf", Buffer.from("x"), {
      access: "public",
    });

    expect(put).toHaveBeenCalledExactlyOnceWith("memory/org_1/contract.pdf", expect.anything(), {
      access: "private",
      addRandomSuffix: true,
    });
  });
});

describe("deletePrivateBlob", () => {
  it("deletes the blob at the URL putPrivateBlob returned", async () => {
    del.mockReset();
    await deletePrivateBlob("https://blob.example/memory/org_1/contract-x1.pdf");
    expect(del).toHaveBeenCalledExactlyOnceWith("https://blob.example/memory/org_1/contract-x1.pdf");
  });
});

describe("readPrivateBlob", () => {
  beforeEach(() => get.mockReset());

  it("reads with private access from origin storage, and returns the body", async () => {
    const stream = new Blob(["contract bytes"]).stream();
    get.mockResolvedValue({ statusCode: 200, stream });

    await expect(readPrivateBlob("https://blob.example/memory/org_1/contract-x1.pdf")).resolves.toBe(stream);
    expect(get).toHaveBeenCalledExactlyOnceWith("https://blob.example/memory/org_1/contract-x1.pdf", {
      access: "private",
      useCache: false,
    });
  });

  it("returns null for a blob that is not stored", async () => {
    get.mockResolvedValue(null);
    await expect(readPrivateBlob("https://blob.example/memory/gone.pdf")).resolves.toBeNull();
  });
});

describe("listPrivateBlobs", () => {
  it("follows the cursor until the last page", async () => {
    const at = new Date("2026-10-01T00:00:00Z");
    const blob = (pathname: string) => ({
      url: `https://blob.example/${pathname}`,
      downloadUrl: "",
      pathname,
      size: 3,
      uploadedAt: at,
      etag: "e",
    });
    list.mockReset();
    list
      .mockResolvedValueOnce({ blobs: [blob("memory/a.pdf")], hasMore: true, cursor: "c1" })
      .mockResolvedValueOnce({ blobs: [blob("memory/b.pdf")], hasMore: false });

    const listed = await listPrivateBlobs("memory/");

    expect(list.mock.calls).toEqual([
      [{ prefix: "memory/", cursor: undefined }],
      [{ prefix: "memory/", cursor: "c1" }],
    ]);
    expect(listed.map((b) => b.pathname)).toEqual(["memory/a.pdf", "memory/b.pdf"]);
    expect(listed[0]).toEqual({
      url: "https://blob.example/memory/a.pdf",
      pathname: "memory/a.pdf",
      size: 3,
      uploadedAt: at,
    });
  });
});
