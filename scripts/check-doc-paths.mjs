#!/usr/bin/env node
// Reports repository paths named in the documentation that do not exist.
//
// A document that points a reader at `services/access/resolver.ts` when the
// file was renamed, or at a script that was never written, costs a stranger
// more than a vague sentence would: they go looking, find nothing, and stop
// trusting the rest of the page. This scan reads every tracked markdown file,
// pulls out the things that are written AS repository paths -- link targets
// and code spans -- and checks each one against the working tree.
//
// Companion to `scripts/check-doc-anchors.mjs`, which owns the `#fragment`
// half of the same question. This script is a report, not a gate: a large
// backlog predates it, so it always exits 0 unless `--max <n>` is given.
//
// Two things are absent from the tree without being broken, and the scan
// says so rather than making a reader filter them out by hand: a gitignored
// path (`.env`, `.next/`) is absent by design, and a config file a setup guide
// tells the reader to create lives on the reader's machine.
//
// Usage:
//   node scripts/check-doc-paths.mjs            # listing plus a total
//   node scripts/check-doc-paths.mjs --json     # machine-readable findings
//   node scripts/check-doc-paths.mjs --max 120  # exit 1 above a ceiling
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/** Directories whose markdown is a historical log rather than documentation. */
export const EXCLUDED_PREFIXES = [];

/** Non-path things that are spelled with a slash and appear often in prose. */
const NON_PATH_PREFIXES = ["origin/", "upstream/", "refs/", "heads/"];

/**
 * Config files `docs/connect/` tells a reader to write on their own machine.
 * They are supposed to be missing from this repository.
 */
export const READER_OWNED_PATHS = new Set([
  ".mcp.json",
  "mcp.json",
  "settings.json",
  "claude_desktop_config.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".gemini/settings.json",
  ".claude/settings.json",
  ".continue/mcpServers/willder.yaml",
]);

/** Extensions that make a token a path even without a directory separator. */
const FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "mdx",
  "html",
  "css",
  "sql",
  "prisma",
  "sh",
  "py",
  "yml",
  "yaml",
  "toml",
  "svg",
  "png",
]);
// `env` and `txt` are deliberately absent: `.env` is never committed and
// `process.env` and "a `.txt` file" are prose, so every hit would be noise.

/**
 * True when `token` is written the way a repository path is written. The
 * exclusions matter more than the inclusions: a scoped npm package, a URL
 * fragment, a shell flag, an environment variable and an `a/b` prose slash
 * all look path-shaped and none of them is a file in this repository.
 */
export function looksLikePath(token) {
  if (!token || token.length > 200) return false;
  if (/^[@~]/.test(token)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(token) || token.startsWith("//")) return false;
  if (/[\s`"'<>|$(){}\\,;!?=+^&#]/.test(token)) return false;
  if (/^-/.test(token)) return false;
  if (/^[A-Z0-9_]+$/.test(token)) return false;
  if (!/[a-zA-Z]/.test(token)) return false;

  const extension = /\.([a-zA-Z0-9]+)$/.exec(token)?.[1]?.toLowerCase();
  if (token.includes("/")) {
    // A slash alone is not enough: `and/or` and `tools/list` are prose and an
    // API method, not files. A known extension or a trailing slash is.
    if (NON_PATH_PREFIXES.some((prefix) => token.startsWith(prefix))) return false;
    if (extension && FILE_EXTENSIONS.has(extension)) return true;
    return token.endsWith("/");
  }
  return Boolean(extension && FILE_EXTENSIONS.has(extension));
}

/**
 * Collects every path-shaped token in one markdown document, as
 * `{ token, line }`. Two sources: the target of a markdown link, and the
 * contents of an inline code span, which is how this repository's prose
 * normally names a file.
 */
export function extractPathTokens(markdown) {
  const tokens = [];
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

    for (const match of line.matchAll(/\]\(\s*<?([^()\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
      tokens.push({ token: match[1].split("#")[0], line: i + 1, inLink: true });
    }
    for (const match of line.matchAll(/`([^`\n]+)`/g)) {
      tokens.push({ token: match[1].split("#")[0], line: i + 1, inLink: false });
    }
  }
  return tokens.filter((t) => looksLikePath(t.token));
}

/**
 * Resolves one token against the tree. A link target is relative to the
 * document; a code span is normally written from the repository root but is
 * also accepted relative to the document. A `*` makes it a glob, which this
 * scan does not expand -- the directory above it is checked instead.
 */
export function resolveToken(relPath, token, exists) {
  if (READER_OWNED_PATHS.has(token)) return true;
  const cleaned = token.replace(/\/+$/, "");
  const globFree = cleaned.includes("*") ? path.posix.dirname(cleaned.split("*")[0]) : cleaned;
  if (!globFree || globFree === "." || globFree === "..") return true;

  const fromDocument = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), globFree));
  if (!fromDocument.startsWith("..") && exists(fromDocument)) return true;
  // `./x` and `../x` are explicitly relative to the document and get no
  // second chance from the root; `.github/x` is a root path that happens to
  // start with a dot.
  if (/^\.\.?\//.test(globFree)) return false;
  return exists(path.posix.normalize(globFree));
}

/** Every path-shaped token in `markdown` that resolves to nothing. */
export function findDanglingPaths(relPath, markdown, exists) {
  return extractPathTokens(markdown)
    .filter(({ token }) => !resolveToken(relPath, token, exists))
    .map(({ token, line }) => ({ file: relPath, line, token }));
}

/**
 * True when git deliberately ignores `rel`. Checked one path at a time
 * because `git check-ignore` exits 1 for "not ignored", which is a normal
 * answer here rather than a failure.
 */
function isGitIgnored(rel) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const files = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((rel) => !EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix)));
  const exists = (rel) => existsSync(path.join(ROOT, rel)) || isGitIgnored(rel);

  const findings = [];
  for (const rel of files) {
    const absolute = path.join(ROOT, rel);
    if (!existsSync(absolute)) continue;
    findings.push(...findDanglingPaths(rel, readFileSync(absolute, "utf8"), exists));
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  } else {
    for (const f of findings) process.stdout.write(`${f.file}:${f.line}  ${f.token}\n`);
    process.stdout.write(`${findings.length} dangling path reference(s)\n`);
  }

  const maxIndex = process.argv.indexOf("--max");
  const max = maxIndex === -1 ? Infinity : Number(process.argv[maxIndex + 1]);
  process.exit(findings.length > max ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
