// A structural scan: every call site that reads or writes the graph, or reads a row
// anchored on a graph uuid, has an entry in the routing policy's GRAPH_CALL_SITES saying how it
// answers a tier that does not read the graph. A new call site without one fails here, and so
// does an entry naming a call its file no longer makes (the memory-gate-scan pattern).
//
// The scan reads source text, with comments removed, under app/, services/, lib/ and mcp/.
// Test files and test support are left out: they build these calls on purpose. The graph
// store itself (graphiti-store.ts) is the thing being called, not a caller.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { GRAPH_CALL_SITES, type GraphCallSite } from "./routing-policy";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SCANNED_DIRS = ["app", "services", "lib", "mcp"];
const NOT_A_CALLER = new Set(["services/memory/graphiti-store.ts"]);

/** The calls that reach the graph, each named the way GRAPH_CALL_SITES names it. */
const GRAPH_CALLS: readonly [RegExp, (m: RegExpMatchArray) => string][] = [
  [/(?<![\w.])graphitiStore\.(\w+)\(/g, (m) => `graphitiStore.${m[1]}`],
  [
    /(?<![\w.])(guardedMemory|memory)\.(entity|graph|retrieve|findFact|findFactById|resolveFacts|removeEntity|transferEntity)\(/g,
    (m) => `${m[1]}.${m[2]}`,
  ],
  [
    /(?<![\w.])this\.(store|graphiti|reads)\.(entity|graph|retrieve|findFactById|removeEntity|transferEntity)\(/g,
    (m) => `this.${m[1]}.${m[2]}`,
  ],
  // The source-checked reads call the backing store they wrap by its parameter name.
  [/(?<![\w.])store\.(entity|graph|retrieve|findFactById)\(/g, (m) => `store.${m[1]}`],
  [/(?<![\w.])(?:db|tx)\.(factDispute|factProvenance)\.(find\w+)\(/g, (m) => `db.${m[1]}.${m[2]}`],
  [/\b(?:FROM|JOIN)\s+"(fact_provenance|fact_disputes)"/g, (m) => `sql:${m[1]}`],
];

/** Source text without comments, so a call named in prose is not counted. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** The receivers the scan knows by name, which an import may rename. */
const GRAPH_RECEIVERS = new Set(["guardedMemory", "memory", "graphitiStore", "db"]);

/**
 * The source as the patterns read it: comments removed, a call split over lines joined
 * (`guardedMemory\n  .entity(` reads as `guardedMemory.entity(`), and a receiver an import
 * renamed (`import { guardedMemory as gm }`) called by its own name.
 */
function normalised(source: string): string {
  let text = withoutComments(source)
    .replace(/\s*\??\.\s*(?=[A-Za-z_$])/g, (m) => (m.includes("?") ? "?." : "."))
    .replace(/([\w$])\s+\(/g, "$1(");
  for (const named of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
    for (const spec of named[1].split(",")) {
      const alias = /^\s*([\w$]+)\s+as\s+([\w$]+)\s*$/.exec(spec);
      if (!alias || !GRAPH_RECEIVERS.has(alias[1]) || alias[1] === alias[2]) continue;
      text = text.replace(new RegExp(`(?<![\\w.$])${alias[2].replace(/\$/g, "\\$")}\\.`, "g"), `${alias[1]}.`);
    }
  }
  return text;
}

/** The graph calls one file's source makes, sorted. */
export function graphCallsIn(source: string): string[] {
  const text = normalised(source);
  const found = new Set<string>();
  for (const [pattern, name] of GRAPH_CALLS) for (const m of text.matchAll(pattern)) found.add(name(m));
  return [...found].sort();
}

/** Calls with no entry, and entries naming a call the file no longer makes. */
export function graphCallGaps(
  callsByFile: Readonly<Record<string, readonly string[]>>,
  registry: Readonly<Record<string, readonly GraphCallSite[]>> = GRAPH_CALL_SITES,
): { unlisted: string[]; stale: string[] } {
  const unlisted: string[] = [];
  const stale: string[] = [];
  for (const [file, calls] of Object.entries(callsByFile)) {
    const listed = new Set((registry[file] ?? []).flatMap((entry) => entry.calls));
    for (const call of calls) if (!listed.has(call)) unlisted.push(`${file}: ${call}`);
  }
  for (const [file, entries] of Object.entries(registry)) {
    const made = new Set(callsByFile[file] ?? []);
    for (const call of entries.flatMap((entry) => entry.calls)) if (!made.has(call)) stale.push(`${file}: ${call}`);
  }
  return { unlisted: unlisted.sort(), stale: stale.sort() };
}

function scanRepo(): Record<string, string[]> {
  const byFile: Record<string, string[]> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "generated") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name) || /testsupport/.test(name)) continue;
      const file = relative(REPO_ROOT, path).split(sep).join("/");
      if (NOT_A_CALLER.has(file)) continue;
      const calls = graphCallsIn(readFileSync(path, "utf8"));
      if (calls.length > 0) byFile[file] = calls;
    }
  };
  for (const dir of SCANNED_DIRS) walk(join(REPO_ROOT, dir));
  return byFile;
}

describe("every graph call site has a routing-policy entry", () => {
  it("finds no call site without an entry, and no entry without its call site", () => {
    expect(graphCallGaps(scanRepo())).toEqual({ unlisted: [], stale: [] });
  });

  it("gives every tier-gated entry a description of what it answers instead", () => {
    const blank = Object.entries(GRAPH_CALL_SITES).flatMap(([file, entries]) =>
      entries.filter((entry) => entry.gated.trim() === "").map(() => file),
    );
    expect(blank).toEqual([]);
  });

  // The mutant: a planted reader at a path the registry does not know is caught, by each kind of call.
  it("catches a new graph reader planted without an entry", () => {
    const planted = [
      'import { guardedMemory, memory } from "@/services/memory";',
      "// guardedMemory.entity(ctx, input) in a comment is not a call",
      "export const a = () => guardedMemory.entity(ctx, { groupId, entityId });",
      "export const b = () => memory.graph({ groupId });",
      "export const c = () => graphitiStore.sourceRecords({ orgId });",
      "export const d = () => db.factProvenance.findMany({ where: {} });",
      'export const e = () => db.$queryRaw`SELECT 1 FROM "fact_disputes"`;',
    ].join("\n");
    const calls = graphCallsIn(planted);
    expect(calls).toEqual([
      "db.factProvenance.findMany",
      "graphitiStore.sourceRecords",
      "guardedMemory.entity",
      "memory.graph",
      "sql:fact_disputes",
    ]);
    expect(graphCallGaps({ ...scanRepo(), "app/api/planted-probe/route.ts": calls }).unlisted).toEqual(
      calls.map((call) => `app/api/planted-probe/route.ts: ${call}`),
    );
  });

  it("catches a call through a renamed import, and a call split across lines", () => {
    const planted = [
      'import { guardedMemory as gm, memory as raw } from "@/services/memory";',
      'import { graphitiStore as g } from "./store";',
      "export const a = () => gm.entity(ctx, { groupId, entityId });",
      "export const b = () =>",
      "  raw",
      "    .graph({ groupId });",
      "export const c = () => g . sourceRecords ({ orgId });",
      "export const d = () => guardedMemory",
      "  .findFact(ctx, input);",
      "export const notOne = () => gmx.entity(ctx);",
    ].join("\n");
    expect(graphCallsIn(planted)).toEqual([
      "graphitiStore.sourceRecords",
      "guardedMemory.entity",
      "guardedMemory.findFact",
      "memory.graph",
    ]);
  });

  it("catches a new call added to a listed file, and an entry left behind by a removed call", () => {
    const repo = scanRepo();
    const withExtra = { ...repo, "lib/inngest/enrichment.ts": [...repo["lib/inngest/enrichment.ts"], "memory.entity"] };
    expect(graphCallGaps(withExtra).unlisted).toEqual(["lib/inngest/enrichment.ts: memory.entity"]);
    const { ["lib/inngest/enrichment.ts"]: _removed, ...withoutEnrichment } = repo;
    expect(graphCallGaps(withoutEnrichment).stale).toEqual(["lib/inngest/enrichment.ts: memory.graph"]);
  });
});
