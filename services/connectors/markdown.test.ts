import { describe, it, expect } from "vitest";
import { splitMarkdownSections, unwrapMarkdown } from "./markdown";

describe("unwrapMarkdown", () => {
  it("joins a hard-wrapped paragraph into one line", () => {
    const wrapped =
      "[Context policy](docs/context-policy.md): the lead uses the compact tool;\nthe observer owns loop observation. Historical evidence stays available on demand.";
    expect(unwrapMarkdown(wrapped)).toBe(
      "[Context policy](docs/context-policy.md): the lead uses the compact tool; the observer owns loop observation. Historical evidence stays available on demand.",
    );
  });

  it("keeps headings, list items and paragraph breaks as their own lines, and continues a wrapped list item", () => {
    const md = "# Title\nIntro line one\nline two.\n\n- first item\n  wraps here\n- second item\n1. numbered\n\nAfter.";
    expect(unwrapMarkdown(md)).toBe(
      "# Title\nIntro line one line two.\n\n- first item wraps here\n- second item\n1. numbered\n\nAfter.",
    );
  });

  it("leaves fenced code untouched", () => {
    const md = "Run:\n```sh\nnpm test\nnpm run build\n```\nDone.";
    expect(unwrapMarkdown(md)).toBe(md);
  });
});

describe("splitMarkdownSections", () => {
  it("splits at headings and packs small neighbours up to the target", () => {
    const md = "# A\none\n## B\ntwo\n## C\n" + "x".repeat(50);
    expect(splitMarkdownSections(md, 20)).toEqual(["# A\none\n\n## B\ntwo", `## C\n${"x".repeat(50)}`]);
  });

  it("does not split at a heading-looking line inside a code fence", () => {
    const md = "# A\n```sh\n# a shell comment\n```\ntail";
    expect(splitMarkdownSections(md, 5)).toEqual([md]);
  });
});
