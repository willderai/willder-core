import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { sealSecret, unsealSecret } from "./crypto";

describe("sealSecret / unsealSecret", () => {
  const original = process.env.APP_ENCRYPTION_KEY;
  beforeAll(() => {
    process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
  });
  afterAll(() => {
    process.env.APP_ENCRYPTION_KEY = original;
  });

  it("never returns the plaintext secret in the sealed blob", () => {
    const sealed = sealSecret({ apiKey: "phx_super_secret_value" });
    expect(sealed).not.toContain("phx_super_secret_value");
  });

  it("round-trips through unsealSecret", () => {
    expect(unsealSecret(sealSecret({ apiKey: "phx_abc", host: "https://us.posthog.com" }))).toMatchObject({
      apiKey: "phx_abc",
      host: "https://us.posthog.com",
    });
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = sealSecret({ apiKey: "same" });
    const b = sealSecret({ apiKey: "same" });
    expect(a).not.toEqual(b);
  });

  it("rejects a blob sealed under a different key", () => {
    const sealed = sealSecret({ apiKey: "x" });
    process.env.APP_ENCRYPTION_KEY = "b".repeat(64);
    expect(() => unsealSecret(sealed)).toThrow();
    process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
  });

  it("requires a 64-char hex APP_ENCRYPTION_KEY", () => {
    process.env.APP_ENCRYPTION_KEY = "too-short";
    expect(() => sealSecret({ apiKey: "x" })).toThrow(/APP_ENCRYPTION_KEY/);
    process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
  });
});
