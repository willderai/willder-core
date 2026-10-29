import { describe, expect, it } from "vitest";
import { envFileDatabaseRefusal, localTargetRefusal, selfhostTargetRefusal } from "./local-database-guard";

const LOCAL = "postgresql://postgres:willder@localhost:5432/willder";

describe("localTargetRefusal", () => {
  it.each([
    ["localhost", LOCAL],
    ["127.0.0.1", "postgresql://postgres:willder@127.0.0.1:5432/willder"],
    ["::1", "postgresql://postgres:willder@[::1]:5432/willder"],
  ])("allows a database on %s", (_host, url) => {
    expect(localTargetRefusal({ DATABASE_URL: url, NODE_ENV: "development" })).toBeNull();
  });

  it("refuses production even with a local database", () => {
    expect(localTargetRefusal({ DATABASE_URL: LOCAL, NODE_ENV: "production" })).toBe("NODE_ENV is production");
  });

  it.each(["VERCEL", "VERCEL_ENV"])("refuses a Vercel environment (%s set)", (name) => {
    expect(localTargetRefusal({ DATABASE_URL: LOCAL, [name]: "1" })).toBe("this is a Vercel environment");
  });

  it("refuses when DATABASE_URL is missing", () => {
    expect(localTargetRefusal({})).toBe("DATABASE_URL is not set");
  });

  it.each([
    ["a hosted database", "postgresql://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require"],
    ["a lookalike host", "postgresql://u:p@localhost.attacker.example/willder"],
    ["a private network host", "postgresql://u:p@10.0.0.5:5432/willder"],
  ])("refuses %s", (_label, url) => {
    expect(localTargetRefusal({ DATABASE_URL: url })).toMatch(/^DATABASE_URL points at .+, not this machine$/);
  });

  it("refuses a local URL whose host query parameter redirects the connection", () => {
    expect(localTargetRefusal({ DATABASE_URL: `${LOCAL}?host=db.example.com` })).toBe(
      "DATABASE_URL sets a host query parameter",
    );
  });

  it("refuses a hosted unpooled URL next to a local pooled one", () => {
    expect(
      localTargetRefusal({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: "postgresql://u:p@db.example.com/willder" }),
    ).toBe("DATABASE_URL_UNPOOLED points at db.example.com, not this machine");
  });

  it("refuses a value that is not a URL", () => {
    expect(localTargetRefusal({ DATABASE_URL: "not a url" })).toBe("DATABASE_URL is not a valid URL");
  });
});

describe("envFileDatabaseRefusal", () => {
  const HOSTED = "postgresql://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/neondb?sslmode=require";

  it("refuses a hosted URL the file supplied", () => {
    expect(envFileDatabaseRefusal({ DATABASE_URL: HOSTED }, { DATABASE_URL: HOSTED })).toBe(
      "DATABASE_URL points at ep-cool-name-123.us-east-2.aws.neon.tech, not this machine",
    );
  });

  it("refuses a hosted unpooled URL the file supplied next to a local pooled one", () => {
    const file = { DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: HOSTED };
    expect(envFileDatabaseRefusal(file, file)).toBe(
      "DATABASE_URL_UNPOOLED points at ep-cool-name-123.us-east-2.aws.neon.tech, not this machine",
    );
  });

  it("refuses a local URL from the file whose host query parameter redirects it", () => {
    const url = `${LOCAL}?host=db.example.com`;
    expect(envFileDatabaseRefusal({ DATABASE_URL: url }, { DATABASE_URL: url })).toBe(
      "DATABASE_URL sets a host query parameter",
    );
  });

  it("allows a local URL from the file", () => {
    expect(envFileDatabaseRefusal({ DATABASE_URL: LOCAL }, { DATABASE_URL: LOCAL })).toBeNull();
  });

  it("allows a file without database URLs", () => {
    expect(envFileDatabaseRefusal({ FOO: "bar" }, { FOO: "bar", DATABASE_URL: HOSTED })).toBeNull();
  });

  it("skips a file value the environment overrides, since the exported URL is the one in effect", () => {
    const exported = "postgresql://u:p@db.example.com/willder";
    expect(envFileDatabaseRefusal({ DATABASE_URL: HOSTED }, { DATABASE_URL: exported })).toBeNull();
  });
});

describe("selfhostTargetRefusal", () => {
  const REMOTE = "postgresql://u:p@db.example.com:5432/willder";
  const FLAG = "WILLDER_SELFHOST_ALLOW_REMOTE_DB";

  it.each([
    ["a local database", { DATABASE_URL: LOCAL }],
    ["a remote database with the flag", { DATABASE_URL: REMOTE, DATABASE_URL_UNPOOLED: REMOTE, [FLAG]: "1" }],
    [
      "a Clerk development key",
      { DATABASE_URL: LOCAL, CLERK_SECRET_KEY: "sk_test_x", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_x" },
    ],
  ])("allows %s", (_label, env) => {
    expect(selfhostTargetRefusal(env)).toBeNull();
  });

  it.each([
    [
      "a remote database without the flag",
      { DATABASE_URL: REMOTE },
      `DATABASE_URL points at db.example.com, not this machine; set ${FLAG}=1 to use a database on another machine`,
    ],
    [
      "a remote unpooled URL without the flag",
      { DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: REMOTE },
      /^DATABASE_URL_UNPOOLED points at db\.example\.com/,
    ],
    ["a flag that is not 1", { DATABASE_URL: REMOTE, [FLAG]: "true" }, `${FLAG} must be 1 or unset, got "true"`],
    [
      "a host query parameter, flag or not",
      { DATABASE_URL: `${REMOTE}?host=other.example.com`, [FLAG]: "1" },
      "DATABASE_URL sets a host query parameter",
    ],
    [
      "a value that is not a URL, flag or not",
      { DATABASE_URL: "not a url", [FLAG]: "1" },
      "DATABASE_URL is not a valid URL",
    ],
    ["production, flag or not", { DATABASE_URL: LOCAL, NODE_ENV: "production", [FLAG]: "1" }, "NODE_ENV is production"],
    [
      "a Vercel build or function, flag or not",
      { DATABASE_URL: REMOTE, VERCEL: "1", [FLAG]: "1" },
      "this is a Vercel environment",
    ],
    [
      "a Vercel environment name, flag or not",
      { DATABASE_URL: REMOTE, VERCEL_ENV: "preview", [FLAG]: "1" },
      "this is a Vercel environment",
    ],
    [
      "a live Clerk secret key, flag or not",
      { DATABASE_URL: REMOTE, CLERK_SECRET_KEY: " sk_live_x", [FLAG]: "1" },
      "CLERK_SECRET_KEY is a production Clerk key",
    ],
    [
      "a live Clerk publishable key",
      { DATABASE_URL: LOCAL, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_x" },
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is a production Clerk key",
    ],
    ["a missing DATABASE_URL", { [FLAG]: "1" }, "DATABASE_URL is not set"],
  ])("refuses %s", (_label, env, expected) => {
    const refusal = selfhostTargetRefusal(env as Record<string, string>);
    if (typeof expected === "string") expect(refusal).toBe(expected);
    else expect(refusal).toMatch(expected);
  });
});
