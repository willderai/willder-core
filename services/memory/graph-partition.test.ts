// toGid is the only name a graph partition has, so two scope paths must never share one:
// the graph serves whatever is in the partition a read names, and nothing after it can
// tell two scopes apart. These tests pin that it is one-to-one, that every scope stored
// before it escaped dashes keeps its partition, and that no other code names a partition.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toGid } from "./graphiti-store";

/** The path a group id was made from: the inverse the toGid doc comment describes. */
function fromGid(gid: string): string {
  const segments = gid.split("-");
  const labels: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== "") {
      labels.push(segments[i]);
      continue;
    }
    const escaped = segments[++i];
    const bytes = escaped.replace(
      /_([0-9A-F]{2})|([A-Za-z0-9])/g,
      (_, hex: string | undefined, kept: string | undefined) => (hex ? `%${hex}` : kept!),
    );
    labels.push(decodeURIComponent(bytes));
  }
  return labels.join(".");
}

/** Every string up to `length` characters over `alphabet`. */
function strings(alphabet: string[], length: number): string[] {
  const out: string[] = [];
  let level = [""];
  for (let n = 1; n <= length; n++) {
    level = level.flatMap((prefix) => alphabet.map((c) => prefix + c));
    out.push(...level);
  }
  return out;
}

const namesAPartition = (path: string) => path.split(".").every((label) => label !== "");

describe("toGid", () => {
  it.each([
    ["the org root", "org_ck1abc", "org_ck1abc"],
    ["a bare org id", "ck1abc", "ck1abc"],
    ["a scope", "org_x.eng.secrets", "org_x-eng-secrets"],
    ["underscores", "org_x.a_b.c_1", "org_x-a_b-c_1"],
    ["scripts/test-seed-ingest-eng.py's GROUP_ID", "org_demoteam.engineering", "org_demoteam-engineering"],
  ])("keeps the partition %s has always had", (_, path, gid) => {
    expect(toGid(path)).toBe(gid);
  });

  it.each([
    ["a dashed label and the dotted child it looked like", ["org_x.eng-secrets", "org_x.eng.secrets"]],
    ["a dash on either side of a dot", ["org_x.a-.b", "org_x.a.-b", "org_x.a--b", "org_x.a.b"]],
    ["an escape spelled out in a plain label", ["org_x.eng-secrets", "org_x.eng_2Dsecrets"]],
  ])("gives each path its own partition: %s", (_, paths) => {
    expect(new Set(paths.map(toGid)).size).toBe(paths.length);
  });

  it("is one-to-one and reversible over every short path, and stays inside its org", () => {
    const paths = strings(["a", "_", "-", ".", "é"], 5).filter(namesAPartition);
    const gids = paths.map(toGid);

    expect(new Set(gids).size).toBe(paths.length);
    for (const [i, path] of paths.entries()) {
      expect(gids[i]).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(fromGid(gids[i])).toBe(path);
      expect(toGid(`org_x.${path}`).startsWith("org_x-")).toBe(true);
    }
  });

  it.each(["", "a..b", ".a", "a.", "a.\uD800"])("refuses %j, which names no partition", (path) => {
    expect(() => toGid(path)).toThrow();
  });
});

// The rules below find a graph partition named by anything other than toGid. Each one
// is a form that existed before this file did.
const THIS_FILE = "services/memory/graph-partition.test.ts";
const TO_GID_HOME = "services/memory/graphiti-store.ts";

/**
 * Turning a path's dots into dashes, by literal: a regex (`\.` or `[.]`, any flags) or a
 * string, through replace, split/join, Python's join, re.sub or maketrans. A pattern or
 * replacement held in a variable is not caught.
 */
const DOT_TO_DASH = [
  /\.replace(?:All)?\(\s*\/(?:\\\.|\[\.\])\/[a-z]*\s*,\s*["'`]-["'`]/,
  /\.replace(?:All)?\(\s*["'`]\.["'`]\s*,\s*["'`]-["'`]/,
  /\.split\(\s*(?:["'`]\.["'`]|\/(?:\\\.|\[\.\])\/)\s*\)[^;\n]*\.join\(\s*["'`]-["'`]\s*\)/,
  /["'`]-["'`]\.join\([^\n]*\.split\(\s*["'`]\.["'`]/,
  /re\.sub\(\s*r?["'](?:\\\.|\[\.\])["']\s*,\s*["']-["']/,
  /maketrans\(\s*["']\.["']\s*,\s*["']-["']/,
];
/** A group id written into a memory service request: a key (bare or quoted), a query string, or URLSearchParams. */
const GROUP_ID_KEY = /\bgroup_ids?\s*:|["']group_ids?["']\s*:|[?&]group_id=|\.(?:set|append)\(\s*["']group_id["']/;
/** An org's partition spelled out by hand: a template, a concatenation, or orgRootPath() plus a dash. */
const HAND_BUILT_ORG_GROUP = {
  ts: /org_\$\{[^}]*\}-|["'`]org_["'`]\s*\+|orgRootPath\([^)]*\)(?:\}-|\s*\+\s*["'`]-)/,
  py: /f["']org_\{[^}]*\}|["']org_["']\s*\+|["']org_%s|["']org_\{\}["'-]/,
};
/** Benchmark partitions named `bakeoff_<corpus>`, on a lab memory service; never a scope path. */
const LAB_GROUPS = "scripts/benchmarks/retrieval-lab/bakeoff/";

const isTest = (file: string) => /\.(test|spec)\.|testsupport|(^|\/)tests?\//.test(file);

function violations(): string[] {
  const files = execFileSync("git", ["ls-files", "--", "*.ts", "*.tsx", "*.mts", "*.mjs", "*.js", "*.py"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file && file !== THIS_FILE);
  const found: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // listed by git but deleted in this checkout
    }
    const py = file.endsWith(".py");
    for (const [n, line] of text.split("\n").entries()) {
      const at = `${file}:${n + 1}`;
      if (file !== TO_GID_HOME && DOT_TO_DASH.some((rule) => rule.test(line)))
        found.push(`${at} turns dots into dashes`);
      if (!py && HAND_BUILT_ORG_GROUP.ts.test(line)) found.push(`${at} spells out an org's partition`);
      if (
        py &&
        file.startsWith("memory-service/app/") &&
        file !== "memory-service/app/partitions.py" &&
        HAND_BUILT_ORG_GROUP.py.test(line)
      ) {
        found.push(`${at} spells out an org's partition outside org_groups`);
      }
    }
    // Per file: a file that calls toGid anywhere may send a group_id. Python is not checked here.
    const sendsGroupIds =
      !py && !isTest(file) && file !== TO_GID_HOME && !file.startsWith(LAB_GROUPS) && GROUP_ID_KEY.test(text);
    if (sendsGroupIds && !/\btoGid\(/.test(text)) found.push(`${file} sends a group_id it did not get from toGid`);
  }
  return found;
}

describe("graph partition names", () => {
  it("come from toGid alone, in every file of the repo", () => {
    expect(violations()).toEqual([]);
  });
});
