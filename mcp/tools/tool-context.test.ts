// The storage-error branches of toolError that a real database cannot be made to
// produce on demand: a lost connection, a value the database refuses for something
// other than a NUL byte. The NUL case runs end to end in mcp/storage-errors.realdb.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import { WorkingNoteGoneError } from "@/services/memory/working-notes";
import { toolError } from "./tool-context";

const CLIENT_VERSION = "7.8.0";

function adapterError(sqlState: string, message: string): Error {
  return Object.assign(new Error(message), {
    name: "DriverAdapterError",
    cause: { kind: "postgres", originalCode: sqlState, originalMessage: message },
  });
}

function textOf(e: unknown): string {
  return toolError(e).content[0].text;
}

describe("toolError on a storage error", () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => logged.mockClear());

  it("names the fix for a value the database refuses, without its text", () => {
    const text = textOf(adapterError("22001", "value too long for type character varying(64)"));
    expect(text).toMatch(/^invalid_input: .*Correct it and retry/);
    expect(text).not.toMatch(/varying|22001/);
  });

  it("reads the SQLSTATE through Prisma's wrapper", () => {
    const wrapped = new Prisma.PrismaClientKnownRequestError("Raw query failed. Code: `22021`.", {
      code: "P2010",
      clientVersion: CLIENT_VERSION,
      meta: { driverAdapterError: adapterError("22021", 'invalid byte sequence for encoding "UTF8": 0x00') },
    });
    expect(textOf(wrapped)).toMatch(/^invalid_input: .*NUL/);
  });

  it("tells the caller nothing needs to change when the failure is on the server's side", () => {
    const text = textOf(
      new Prisma.PrismaClientInitializationError("Can't reach database server at `db.internal:5432`", CLIENT_VERSION),
    );
    expect(text).toMatch(/^storage_error: .*Nothing in the request needs to change/);
    expect(text).not.toMatch(/db\.internal|5432/);
  });

  // Each Prisma error class isStorageError lists is a separate guard: dropping any one
  // of them sends that class's own text (query names, arguments, engine internals) to the client.
  it.each([
    [
      "an unknown request error",
      () =>
        new Prisma.PrismaClientUnknownRequestError("Invalid `prisma.memoryChunk.create()` invocation: engine said no", {
          clientVersion: CLIENT_VERSION,
        }),
    ],
    [
      "a validation error",
      () =>
        new Prisma.PrismaClientValidationError(
          "Invalid `prisma.memoryChunk.findMany()` invocation: Argument `where` is missing.",
          { clientVersion: CLIENT_VERSION },
        ),
    ],
    [
      "a panic",
      () =>
        new Prisma.PrismaClientRustPanicError(
          "Invalid `prisma.memoryChunk.create()` invocation: query engine panicked",
          CLIENT_VERSION,
        ),
    ],
  ])("answers %s as a server-side storage error, without its text", (_kind, makeError) => {
    const text = textOf(makeError());
    expect(text).toMatch(/^storage_error: .*Nothing in the request needs to change/);
    expect(text).not.toMatch(/prisma|memoryChunk|invocation|panicked|engine/i);
  });

  it("logs the original under the reference the reply quotes", () => {
    const original = adapterError("08006", "connection terminated unexpectedly");
    const reference = /reference ([0-9a-f]{8})/.exec(textOf(original))?.[1];
    expect(reference).toBeDefined();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(reference!), original);
  });

  it("still passes a plain error's own message through", () => {
    expect(textOf(new Error("supersedes needs kind: only a convention or decision can replace one."))).toBe(
      "supersedes needs kind: only a convention or decision can replace one.",
    );
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("toolError on a note removed while it was being renewed", () => {
  it("says the note no longer exists and how to start a new one, not a database error", () => {
    const text = textOf(new WorkingNoteGoneError("Renewal call"));
    expect(text).toMatch(/^note_gone: Your note on "Renewal call" no longer exists/);
    expect(text).toMatch(/Post it again/);
  });
});
