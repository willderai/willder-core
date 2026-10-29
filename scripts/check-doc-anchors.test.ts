// Coverage for the anchor scan (scripts/check-doc-anchors.mjs).
//
// Broken `#fragment` links were the one documentation defect nothing in this
// repository measured: the link renders, the file it names exists, and the
// reader simply lands at the top of the page instead of the section they
// asked for. These tests pin the two halves that make the scan trustworthy --
// the GitHub-compatible slug, and the decision about which links are even in
// scope -- so the scan keeps catching real breaks and keeps staying quiet
// about links it cannot resolve.
import { describe, expect, it } from "vitest";
import { slugify, headingSlugs, extractLinks, isExternal, findBrokenAnchors } from "./check-doc-anchors.mjs";

describe("slugify", () => {
  it("lowercases and joins words with hyphens", () => {
    expect(slugify("Ten-minute path: a local MCP server")).toBe("ten-minute-path-a-local-mcp-server");
  });

  it("drops punctuation but keeps underscores, as GitHub does", () => {
    expect(slugify("Why `DATABASE_URL` matters (really)")).toBe("why-database_url-matters-really");
  });

  it("reduces a heading's inline markdown to its rendered text", () => {
    expect(slugify("See [the guide](docs/guide.md) **now**")).toBe("see-the-guide-now");
  });
});

describe("headingSlugs", () => {
  it("collects ATX and setext headings", () => {
    const slugs = headingSlugs("# Title\n\nSetext Heading\n---\n\n### Deep One\n");
    expect([...slugs]).toEqual(["title", "setext-heading", "deep-one"]);
  });

  it("disambiguates repeated headings with GitHub's numeric suffixes", () => {
    const slugs = headingSlugs("## Overview\n\n## Overview\n\n## Overview\n");
    expect([...slugs]).toEqual(["overview", "overview-1", "overview-2"]);
  });

  it("ignores comment lines inside a fenced code block", () => {
    const slugs = headingSlugs("# Real\n\n```bash\n# 1. Not a heading\n```\n");
    expect([...slugs]).toEqual(["real"]);
  });

  it("accepts an explicit HTML id or name as a link target", () => {
    expect(headingSlugs('<a id="manual-anchor"></a>\n').has("manual-anchor")).toBe(true);
  });
});

describe("extractLinks", () => {
  it("reads inline links, titled links and reference definitions", () => {
    const links = extractLinks('[a](one.md#x)\n\n[b](two.md "Title")\n\n[ref]: three.md#y\n');
    expect(links.map((l) => l.target)).toEqual(["one.md#x", "two.md", "three.md#y"]);
  });

  it("skips example links inside a fenced code block", () => {
    expect(extractLinks("```md\n[a](nope.md#gone)\n```\n")).toEqual([]);
  });
});

describe("isExternal", () => {
  it("treats a scheme or a protocol-relative URL as out of scope", () => {
    expect(isExternal("https://example.com#top")).toBe(true);
    expect(isExternal("mailto:a@b.c")).toBe(true);
    expect(isExternal("//cdn.example.com/x#y")).toBe(true);
    expect(isExternal("docs/README.md#index")).toBe(false);
  });
});

describe("findBrokenAnchors", () => {
  const reader = (files: Record<string, string>) => (absolute: string) => {
    const match = Object.entries(files).find(([rel]) => absolute.endsWith(`/${rel}`));
    return match ? match[1] : null;
  };

  it("reports an anchor that no heading in the target file produces", () => {
    const findings = findBrokenAnchors(
      "docs/README.md",
      "[setup](../README.md#quick-start)\n",
      reader({ "README.md": "# Willder\n\n## Ten-minute path\n" }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "docs/README.md",
      anchor: "quick-start",
      targetFile: "README.md",
    });
  });

  it("accepts an anchor that the target file really defines", () => {
    expect(
      findBrokenAnchors(
        "docs/README.md",
        "[setup](../README.md#ten-minute-path)\n",
        reader({ "README.md": "# Willder\n\n## Ten-minute path\n" }),
      ),
    ).toEqual([]);
  });

  it("resolves a bare #fragment against the document it appears in", () => {
    const body = "# Guide\n\n[jump](#missing-section)\n\n## Present Section\n";
    expect(findBrokenAnchors("docs/guide.md", body, reader({ "docs/guide.md": body }))).toHaveLength(1);
  });

  it("stays silent on a dangling path, which the path scan owns", () => {
    expect(findBrokenAnchors("a.md", "[x](no-such-file.md#y)\n", reader({}))).toEqual([]);
  });

  it("stays silent on a non-markdown target, which has no heading slugs", () => {
    expect(findBrokenAnchors("a.md", "[d](docs/willder_erd.html#node)\n", reader({}))).toEqual([]);
  });

  it("decodes a percent-encoded non-ASCII fragment before comparing it", () => {
    const body = "# Guide\n\n[jump](#caf%C3%A9-notes)\n\n## Caf\u00e9 notes\n";
    expect(findBrokenAnchors("g.md", body, reader({ "g.md": body }))).toEqual([]);
  });
});
