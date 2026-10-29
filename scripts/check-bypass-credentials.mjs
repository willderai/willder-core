#!/usr/bin/env node
// Fails when the README's list of credentials that bypass the authorizer falls
// behind the code.
//
// README.md, "Credentials that bypass the authorizer", tells a reader which
// secrets reach memory without `check()` (services/access/check.ts) deciding.
// That list is a security claim, and a claim written by hand goes stale the day
// someone adds a new secret. This check computes the other side from the code:
// every environment variable the shipped code reads, plus every one
// `.env.example` tells an operator to set (SDKs such as Inngest and Clerk read
// theirs implicitly, so the code never names them). Each one that is shaped
// like a credential must be classified exactly once:
//
//   - in the README table, because it reaches memory without check(); or
//   - in NOT_A_BYPASS below, with the reason it does not.
//
// A credential in neither place fails the check, so a new secret cannot ship
// until someone has decided, in review, which side it is on. A README entry
// that no code or `.env.example` mentions also fails: the list must not claim a
// credential that no longer exists. A name in both places fails, because the
// two answers contradict each other.
//
// Shipped code is everything tracked except tests, `scripts/` (operator tools
// that run with the operator's own credentials) and tooling directories.
//
// Usage:
//   node scripts/check-bypass-credentials.mjs          # exit 1 on any finding
//   node scripts/check-bypass-credentials.mjs --json   # the classification
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const README_HEADING = "## Credentials that bypass the authorizer";

/**
 * Credentials that do not reach memory without check(), each with the reason.
 * A reviewer adding a name here is asserting that reason, so keep it specific.
 *
 * @type {Record<string, string>}
 */
export const NOT_A_BYPASS = {
  CLERK_SECRET_KEY: "signs in as a user, whose requests check() still decides (the README says so under the table)",
  WILLDER_CAPABILITY_TOKEN: "a capability token; check() decides every call it makes",
  WILLDER_TOKEN: "the agent hook's capability token; check() decides every call it makes",
  WILLDER_URL: "the Willder API's address; calls to it go through check()",
  CRON_SECRET:
    "Vercel's cron credential; GET /api/mcp answers it a bodiless 204 and nothing else, and no route serves memory to it",
  GRAPHITI_SERVICE_URL: "an address; the memory service's credential is GRAPHITI_SERVICE_API_KEY",
  OPENAI_API_KEY: "calls the model provider; prompts carry memory out, but the key reads none of Willder's stores",
  OPENAI_BASE_URL: "the model provider's address",
  ANTHROPIC_API_KEY: "calls the model provider; prompts carry memory out, but the key reads none of Willder's stores",
  LANGFUSE_PUBLIC_KEY: "writes traces; reading them back needs LANGFUSE_SECRET_KEY, which is listed",
  GOOGLE_CLIENT_SECRET:
    "the OAuth app secret; connected users' tokens are sealed under APP_ENCRYPTION_KEY, which is listed",
  MICROSOFT_CLIENT_SECRET:
    "the OAuth app secret; connected users' tokens are sealed under APP_ENCRYPTION_KEY, which is listed",
  SLACK_CLIENT_SECRET:
    "the OAuth app secret; connected workspaces' tokens are sealed under APP_ENCRYPTION_KEY, which is listed",
  FIGMA_CLIENT_SECRET:
    "the OAuth app secret; connected accounts' tokens are sealed under APP_ENCRYPTION_KEY, which is listed",
  GITHUB_TOKEN: "raises the rate limit on GitHub's public secret-scanning keys; reaches no Willder store",
  STRIPE_SECRET_KEY: "billing only",
  STRIPE_WEBHOOK_SECRET: "verifies billing events, which write subscription state, not memory",
  RESEND_API_KEY: "sends email",
  APOLLO_API_KEY: "outbound enrichment lookups",
  EXA_API_KEY: "outbound enrichment lookups",
  FIRECRAWL_API_KEY: "outbound page fetches",
};

/**
 * True for a variable name that holds a secret or the address of a store.
 * Names under NEXT_PUBLIC_ are compiled into the browser bundle, so they are
 * public by construction and never a bypass.
 */
export function isCredentialShaped(name) {
  if (name.startsWith("NEXT_PUBLIC_")) return false;
  return /(KEY|SECRET|TOKEN|PASSWORD|USERNAME|CREDENTIALS?)(_|$)|_(URL|URI|DSN)(_|$)/.test(name);
}

const ENV_READ_PATTERNS = [
  // process.env.NAME, and env.NAME where `env` is process.env passed in
  /\benv\.([A-Z][A-Z0-9_]+)/g,
  /\benv\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g, // process.env["NAME"], env["NAME"]
  /os\.environ(?:\.get)?[[(]\s*["']([A-Z][A-Z0-9_]+)["']/g, // os.environ["NAME"], .get("NAME")
  /os\.getenv\(\s*["']([A-Z][A-Z0-9_]+)["']/g, // os.getenv("NAME")
];

// `const { NAME, OTHER: alias, THIRD = "x" } = process.env` (or `= env`).
const ENV_DESTRUCTURE = /\{([^{}]*)\}\s*=\s*(?:process\.)?env\b/g;

// A string literal that is exactly a credential-shaped name, such as
// `clientSecretEnv: "SLACK_CLIENT_SECRET"` later read as process.env[clientSecretEnv].
// A read through a variable cannot be followed statically, so the name itself
// appearing as a literal counts as the read. Backticks are left out: comments
// use them to mention names, and a mention must not keep a stale entry alive.
const NAME_LITERAL = /(["'])([A-Z][A-Z0-9_]+)\1/g;

/**
 * Environment variable names a JavaScript, TypeScript or Python source reads:
 * direct reads, destructured reads, and credential-shaped names written as a
 * string literal (an indirect read such as process.env[name]).
 */
export function envReadsInSource(text) {
  const names = new Set();
  for (const pattern of ENV_READ_PATTERNS) {
    for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  for (const match of text.matchAll(ENV_DESTRUCTURE)) {
    for (const binding of match[1].split(",")) {
      const key = /^\s*([A-Z][A-Z0-9_]+)\s*(?:[:=]|$)/.exec(binding);
      if (key) names.add(key[1]);
    }
  }
  for (const match of text.matchAll(NAME_LITERAL)) {
    if (isCredentialShaped(match[2])) names.add(match[2]);
  }
  return names;
}

/**
 * Variables a shell script expands (`$NAME`, `${NAME}`, `${NAME:-x}`), less the
 * ones it assigns itself on a line of their own, which are its locals.
 */
export function envReadsInShell(text) {
  const locals = new Set(
    [...text.matchAll(/^\s*(?:export\s+|local\s+|readonly\s+)?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]),
  );
  const expanded = [...text.matchAll(/\$\{?([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
  return new Set(expanded.filter((name) => !locals.has(name)));
}

/**
 * Variables a pydantic `BaseSettings` class reads: each field name, upper-cased
 * (pydantic-settings' default mapping, which memory-service/app/config.py uses).
 */
export function envReadsInPydanticSettings(text) {
  const names = new Set();
  let inSettings = false;
  for (const line of text.split("\n")) {
    if (/^class \w+\(BaseSettings\):/.test(line)) {
      inSettings = true;
    } else if (/^\S/.test(line)) {
      inSettings = false;
    } else if (inSettings) {
      const field = /^ {4}([a-z][a-z0-9_]*)\s*:/.exec(line);
      if (field) names.add(field[1].toUpperCase());
    }
  }
  return names;
}

/** Names `.env.example` assigns, including commented-out optional ones. */
export function envNamesInExample(text) {
  return new Set([...text.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
}

/** Backticked variable names in the first column of the README's bypass table. */
export function readmeBypassNames(readme) {
  const start = readme.indexOf(README_HEADING);
  if (start === -1) throw new Error(`README.md has no "${README_HEADING}" section`);
  const rest = readme.slice(start + README_HEADING.length);
  const end = rest.search(/^## /m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const names = new Set();
  for (const line of section.split("\n")) {
    const row = /^\|([^|]*)\|/.exec(line);
    if (!row) continue;
    for (const match of row[1].matchAll(/`([A-Z][A-Z0-9_]+)`/g)) names.add(match[1]);
  }
  if (names.size === 0) throw new Error(`README.md "${README_HEADING}" lists no credentials`);
  return names;
}

/** True for a tracked file that is part of what ships, not a test or a tool. */
export function isShippedSource(file) {
  if (/(^|\/)(tests?|__tests__)\//.test(file)) return false;
  if (/\.(test|spec)\.[a-z]+$/.test(file) || /(^|\/)test_[^/]*\.py$/.test(file)) return false;
  if (/^(scripts|\.agents|\.claude|\.github|docs|claude)\//.test(file)) return false;
  return /\.(ts|tsx|mjs|cjs|js|py|sh)$/.test(file);
}

/**
 * Classifies every credential found against the README list and NOT_A_BYPASS.
 * Returns the findings; an empty array means the README is complete.
 */
export function classify({ found, readme, notABypass = NOT_A_BYPASS }) {
  const findings = [];
  const credentials = [...found.keys()].filter(isCredentialShaped).sort();
  for (const name of credentials) {
    const listed = readme.has(name);
    const excused = Object.hasOwn(notABypass, name);
    if (!listed && !excused) {
      findings.push(
        `${name} (read in ${found.get(name).join(", ")}) is in neither the README's bypass ` +
          `list nor NOT_A_BYPASS in scripts/check-bypass-credentials.mjs. Decide whether it ` +
          `reaches memory without check() and add it to one of them.`,
      );
    } else if (listed && excused) {
      findings.push(
        `${name} is in the README's bypass list and also in NOT_A_BYPASS. Remove it from the one that is wrong.`,
      );
    }
  }
  for (const name of [...readme].sort()) {
    if (!found.has(name)) {
      findings.push(
        `${name} is in the README's bypass list, but no shipped code or .env.example reads it. ` +
          `Remove the stale entry, or name where it is read.`,
      );
    }
  }
  for (const name of Object.keys(notABypass).sort()) {
    if (!found.has(name)) {
      findings.push(`${name} is in NOT_A_BYPASS, but nothing reads it. Remove the stale entry.`);
    }
  }
  return findings;
}

/** Every variable the repository reads, mapped to the files that read it. */
export function collectEnvReads(root = ROOT) {
  const found = new Map();
  const add = (names, file) => {
    for (const name of names) found.set(name, [...(found.get(name) ?? []), file]);
  };
  const files = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(isShippedSource);
  for (const file of files) {
    const text = readFileSync(path.join(root, file), "utf8");
    if (file.endsWith(".sh")) add(envReadsInShell(text), file);
    else add(envReadsInSource(text), file);
    if (file.endsWith(".py")) add(envReadsInPydanticSettings(text), file);
  }
  add(envNamesInExample(readFileSync(path.join(root, ".env.example"), "utf8")), ".env.example");
  return found;
}

function main() {
  const found = collectEnvReads();
  const readme = readmeBypassNames(readFileSync(path.join(ROOT, "README.md"), "utf8"));
  const findings = classify({ found, readme });
  if (process.argv.includes("--json")) {
    const credentials = [...found.keys()].filter(isCredentialShaped).sort();
    console.log(
      JSON.stringify(
        {
          bypass: credentials.filter((n) => readme.has(n)),
          notABypass: credentials.filter((n) => Object.hasOwn(NOT_A_BYPASS, n)),
          findings,
        },
        null,
        2,
      ),
    );
  } else if (findings.length === 0) {
    console.log(`README bypass list matches the code: ${readme.size} credentials listed.`);
  } else {
    for (const finding of findings) console.error(finding);
  }
  if (findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
