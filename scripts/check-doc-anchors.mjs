#!/usr/bin/env node
// Resolves every in-page anchor link in the repository's markdown against the
// headings that actually exist in the file it points at, and fails on any that
// resolves to nothing.
//
// The rule this enforces: a link written as `[text](path#anchor)` or
// `[text](#anchor)` must name a heading (or an explicit HTML anchor) that is
// really present in the target document. Nothing else in the repository
// checked this -- a link whose *file* exists but whose `#fragment` does not
// renders as a normal link and silently drops the reader at the top of the
// page, so broken anchors were only ever found by hand.
//
// Scope: anchors only. A link to a file that does not exist at all is a
// dangling path, which `scripts/check-doc-paths.mjs` reports; this script
// skips those so one defect is not counted twice.
//
// Usage:
//   node scripts/check-doc-anchors.mjs           # exit 0 clean, 1 on any break
//   node scripts/check-doc-anchors.mjs --json    # machine-readable findings
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/**
 * GitHub's heading-to-fragment slug: lowercase, drop every character that is
 * not a letter, number, space, hyphen or underscore, then spaces to hyphens.
 * Unicode letters and numbers are kept, which is why the classes are
 * `\p{L}`/`\p{N}` rather than `a-z0-9`.
 */
export function slugify(headingText) {
  return stripInlineMarkdown(headingText)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Reduces a heading's source text to the plain text a renderer would show, so
 * the slug matches what GitHub generates. Images drop out entirely, links
 * collapse to their label, and code spans and emphasis markers are removed.
 */
export function stripInlineMarkdown(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .trim();
}

/**
 * Every fragment a reader can link to inside one markdown document: the slug
 * of each ATX or setext heading, plus any explicit `id=`/`name=` attribute on
 * an inline HTML element. Headings inside fenced code blocks are not headings.
 *
 * Repeated heading text gets GitHub's `-1`, `-2`, ... disambiguating suffixes,
 * so both `#overview` and `#overview-1` are valid when "Overview" appears
 * twice.
 */
export function headingSlugs(markdown) {
  const slugs = new Set();
  const seen = new Map();
  const lines = markdown.split("\n");
  let fence = null;

  const add = (raw) => {
    const base = slugify(raw);
    if (!base) return;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      add(atx[2]);
      continue;
    }
    const setext = /^\s{0,3}(=+|-+)\s*$/.exec(line);
    if (setext && i > 0 && lines[i - 1].trim() && !/^\s{0,3}#/.test(lines[i - 1])) {
      add(lines[i - 1]);
    }
  }

  for (const match of markdown.matchAll(/<[a-zA-Z][^>]*\s(?:id|name)=["']([^"']+)["']/g)) {
    slugs.add(match[1].toLowerCase());
  }
  return slugs;
}

/**
 * Pulls every link target out of one markdown document, as
 * `{ target, line }`. Covers inline links, reference definitions and bare
 * autolinks; link text spanning lines is reported at the line the target sits
 * on. Fenced code blocks are skipped so an example link in a snippet is not
 * treated as a real one.
 */
export function extractLinks(markdown) {
  const links = [];
  const lines = markdown.split("\n");
  let fence = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const bare = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    for (const match of bare.matchAll(/\]\(\s*<?([^()\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
      links.push({ target: match[1], line: i + 1 });
    }
    const definition = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s<>]+)>?/.exec(bare);
    if (definition) links.push({ target: definition[1], line: i + 1 });
  }
  return links;
}

/** True for a target this scan has no way to resolve locally. */
export function isExternal(target) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//");
}

/**
 * Checks one document's anchor links against `readFile`, a
 * `(absolutePath) => string | null` reader that returns null for a path that
 * does not exist. Returns one finding per unresolvable anchor.
 */
export function findBrokenAnchors(relPath, markdown, readFile) {
  const findings = [];
  for (const { target, line } of extractLinks(markdown)) {
    const hash = target.indexOf("#");
    if (hash === -1 || isExternal(target)) continue;

    const anchor = decodeURIComponent(target.slice(hash + 1)).toLowerCase();
    if (!anchor) continue;

    const pathPart = decodeURIComponent(target.slice(0, hash));
    let targetRel = relPath;
    if (pathPart) {
      targetRel = path.posix.normalize(
        pathPart.startsWith("/") ? pathPart.slice(1) : path.posix.join(path.posix.dirname(relPath), pathPart),
      );
      // A link into a non-markdown file (an .html diagram, an image) has no
      // heading slugs to check, and a missing file is the path scan's finding.
      if (!targetRel.endsWith(".md")) continue;
    }

    const contents = readFile(path.join(ROOT, targetRel));
    if (contents === null) continue;

    if (!headingSlugs(contents).has(anchor)) {
      findings.push({ file: relPath, line, target, anchor, targetFile: targetRel });
    }
  }
  return findings;
}

function readFileOrNull(absolute) {
  try {
    if (!statSync(absolute).isFile()) return null;
  } catch {
    return null;
  }
  return readFileSync(absolute, "utf8");
}

function trackedMarkdown() {
  const out = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function main() {
  const findings = [];
  for (const rel of trackedMarkdown()) {
    const absolute = path.join(ROOT, rel);
    if (!existsSync(absolute)) continue;
    findings.push(...findBrokenAnchors(rel, readFileSync(absolute, "utf8"), readFileOrNull));
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else {
    for (const f of findings) {
      process.stdout.write(`${f.file}:${f.line}  ${f.target}  -> no "#${f.anchor}" in ${f.targetFile}\n`);
    }
    process.stdout.write(`${findings.length} broken anchor link(s)\n`);
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
