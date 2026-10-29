// `ingestContentKey`: what makes two ingests the same fact, and what does not.
import { describe, expect, it } from "vitest";
import { ingestContentKey } from "./ingest-content-key";

const base = {
  groupId: "org_1",
  scopePath: "org_org_1.sales",
  name: "Acme Corp",
  content: "Acme renewed its contract with Willder.",
};

describe("ingestContentKey", () => {
  it("is a SHA-256 hex digest, stable across calls", () => {
    const key = ingestContentKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(ingestContentKey({ ...base })).toBe(key);
  });

  it("ignores whitespace that does not change the content", () => {
    const key = ingestContentKey(base);
    expect(ingestContentKey({ ...base, content: `  ${base.content}\n` })).toBe(key);
    expect(ingestContentKey({ ...base, content: "Acme renewed\r\n its   contract with Willder." })).toBe(key);
  });

  it("treats decomposed and precomposed Unicode as the same text", () => {
    const precomposed = ingestContentKey({ ...base, content: "Zoë signed." });
    const decomposed = ingestContentKey({ ...base, content: "Zoë signed." });
    expect(decomposed).toBe(precomposed);
  });

  it("keeps case and punctuation, which can change meaning", () => {
    const key = ingestContentKey(base);
    expect(ingestContentKey({ ...base, content: base.content.toLowerCase() })).not.toBe(key);
    expect(ingestContentKey({ ...base, content: base.content.replace(".", "?") })).not.toBe(key);
  });

  it("separates orgs, scopes, names and content", () => {
    const key = ingestContentKey(base);
    expect(ingestContentKey({ ...base, groupId: "org_2" })).not.toBe(key);
    expect(ingestContentKey({ ...base, scopePath: "org_org_1.eng" })).not.toBe(key);
    expect(ingestContentKey({ ...base, name: "Acme Inc" })).not.toBe(key);
    expect(ingestContentKey({ ...base, content: "Acme cancelled its contract." })).not.toBe(key);
  });

  it("reads an omitted scope as the org root, like the store and the feed do", () => {
    const omitted = ingestContentKey({ ...base, scopePath: undefined });
    expect(omitted).toBe(ingestContentKey({ ...base, scopePath: "org_org_1" }));
    expect(omitted).not.toBe(ingestContentKey(base));
  });

  it("cannot be forged by moving a boundary between fields", () => {
    const a = ingestContentKey({ groupId: "org_1", scopePath: "s", name: "ab", content: "c" });
    const b = ingestContentKey({ groupId: "org_1", scopePath: "s", name: "a", content: "bc" });
    expect(a).not.toBe(b);
  });
});
