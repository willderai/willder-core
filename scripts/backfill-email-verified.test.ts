// The backfill's command line: dry run unless --apply is given, and anything
// unrecognised is refused rather than ignored, so a typo of --apply cannot
// quietly turn into a run the operator did not mean. A failure is reported in one
// line that never carries an email address or the Clerk secret, whichever library
// raised it.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createClerkClient } from "@clerk/backend";
import { describe, expect, it } from "vitest";
import { Prisma } from "@/lib/generated/prisma/client";
import { describeFailure, missingEnv, parseBackfillArgs } from "./backfill-email-verified";

const SECRET = "sk_" + "test_neverprinted";

/** The error the real @clerk/backend client throws for a call to `apiUrl`. */
async function clerkErrorFrom(apiUrl: string): Promise<unknown> {
  const clerk = createClerkClient({ secretKey: SECRET, apiUrl });
  return clerk.users.getUserList({ userId: ["user_1"], limit: 1 }).then(
    () => expect.unreachable("the request should fail"),
    (error: unknown) => error,
  );
}

describe("parseBackfillArgs", () => {
  it("is a dry run with no arguments", () => {
    expect(parseBackfillArgs([])).toEqual({ apply: false });
  });

  it("reads --apply, --org and --page-size", () => {
    expect(parseBackfillArgs(["--apply", "--org", "org-1", "--page-size", "50"])).toEqual({
      apply: true,
      orgId: "org-1",
      pageSize: 50,
    });
  });

  it("refuses a misspelt flag instead of falling back to a dry run or an apply", () => {
    expect(() => parseBackfillArgs(["--aply"])).toThrow(/unknown argument/);
  });

  it("refuses a page size Clerk would not accept", () => {
    expect(() => parseBackfillArgs(["--page-size", "101"])).toThrow(/1 to 100/);
    expect(() => parseBackfillArgs(["--page-size", "0"])).toThrow(/1 to 100/);
  });

  it("refuses --org with no value", () => {
    expect(() => parseBackfillArgs(["--org", "--apply"])).toThrow(/Org.id/);
  });
});

describe("missingEnv", () => {
  it("names every missing variable in one line", () => {
    expect(missingEnv({})).toBe("DATABASE_URL and CLERK_SECRET_KEY are not set");
    expect(missingEnv({ DATABASE_URL: "postgresql://x" })).toBe("CLERK_SECRET_KEY is not set");
    expect(missingEnv({ CLERK_SECRET_KEY: SECRET })).toBe("DATABASE_URL is not set");
  });

  it("is null when both are set", () => {
    expect(missingEnv({ DATABASE_URL: "postgresql://x", CLERK_SECRET_KEY: SECRET })).toBeNull();
  });
});

describe("describeFailure", () => {
  it("reports a Clerk HTTP error by status and trace id, never its body", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          errors: [
            {
              code: "form_param_format_invalid",
              message: "ada@example.test is invalid",
              long_message: "ada@example.test",
            },
          ],
          clerk_trace_id: "trace-1",
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const error = await clerkErrorFrom(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const line = describeFailure(error);

      expect(line).toBe("Clerk request failed with HTTP 422 (trace trace-1)");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("says a Clerk request got no response, rather than printing nothing", async () => {
    const line = describeFailure(await clerkErrorFrom("http://127.0.0.1:1"));

    expect(line).toMatch(/^Clerk request failed without an HTTP response/);
    expect(line).not.toContain(SECRET);
  });

  it("reports a Prisma error by class and code, never its message, which can echo query values", () => {
    const validation = new Prisma.PrismaClientValidationError(
      'Invalid `db.user.updateMany()` invocation: where: { email: "ada@example.test" }',
      { clientVersion: "test" },
    );
    const known = new Prisma.PrismaClientKnownRequestError("ada@example.test", {
      code: "P2002",
      clientVersion: "test",
    });

    expect(describeFailure(validation)).toBe("database error PrismaClientValidationError");
    expect(describeFailure(known)).toBe("database error PrismaClientKnownRequestError P2002");
  });

  it("keeps the message of the script's own errors, which name the fix", () => {
    expect(
      describeFailure(new Error("Clerk rate limit persisted after 8 retries; rerun to resume after user u_1")),
    ).toBe("Clerk rate limit persisted after 8 retries; rerun to resume after user u_1");
  });
});
