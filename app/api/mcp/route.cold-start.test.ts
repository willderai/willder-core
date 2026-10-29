// What a cold instance of /api/mcp loads before it can answer anything.
//
// Every module the route imports statically, and every module those import, is loaded
// and evaluated when a new function instance takes its first request, whether that
// request is a tools/list, a memory_note or a memory_query. On a cold deployment each
// concurrent request starts its own instance, so this graph is paid once per concurrent
// caller. The one rule this file enforces: code that only memory_ingest's write pipeline
// uses is never in that eager graph. That is the Inngest barrel with every background job
// it registers (ingestion, enrichment, connector sync, scheduled jobs), the packages only
// those jobs use, and the Unicode confusables table agent naming reads. memory_ingest
// loads them with `await import(...)` when it writes.
//
// The graph is read from source with the TypeScript parser, the way a bundler sees it:
// type-only imports are erased, `import()` is lazy, and a package import is recorded by
// name and not followed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const ROUTE = "app/api/mcp/route.ts";

/** Project files a cold /api/mcp instance must not load: the Inngest barrel, every job behind it, the clients only those jobs use, and agent naming's Unicode tables. */
const WRITE_PIPELINE_FILES =
  /^(lib\/inngest(\.ts$|\/)|lib\/llm\.ts$|services\/enrichment\/|services\/audit\/actor-names\.ts$|lib\/unicode\/)/;

/** Packages reached only through the background jobs. Each one is module-load time on every cold start. */
const BACKGROUND_JOB_PACKAGES = ["inngest", "openai", "exa-js", "@mendable/firecrawl-js"];

interface EagerGraph {
  /** Every project file loaded eagerly, mapped to the file that first imported it (null for the entry). */
  files: Map<string, string | null>;
  /** Every package loaded eagerly, mapped to the project file that first imported it. */
  packages: Map<string, string>;
}

/** The package a bare specifier names: "next/server" is "next", "@a/b/c" is "@a/b". */
function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** The project file a local specifier names. Throws, naming the import, when it resolves to nothing. */
function resolveLocal(importer: string, specifier: string): string {
  const base = specifier.startsWith("@/") ? specifier.slice(2) : join(dirname(importer), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (/\.(ts|tsx|js|mjs|json)$/.test(candidate) && existsSync(join(REPO_ROOT, candidate))) {
      return relative(REPO_ROOT, join(REPO_ROOT, candidate));
    }
  }
  throw new Error(
    `${importer} imports "${specifier}", which resolves to no file (run \`npx prisma generate\` for the generated client)`,
  );
}

/** Whether an import or export declaration survives compilation: one that names only types is erased. */
function survivesCompilation(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true; // `import "x"` runs x for its side effects
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    if (!bindings || ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly);
  }
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  return (
    !clause ||
    !ts.isNamedExports(clause) ||
    clause.elements.length === 0 ||
    clause.elements.some((element) => !element.isTypeOnly)
  );
}

/** The specifiers `file` loads as soon as it is evaluated: static imports, re-exports and `require` calls, never `import()`. */
function eagerSpecifiers(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(join(REPO_ROOT, file), "utf8"), ts.ScriptTarget.Latest, false);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (survivesCompilation(node)) specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** The eager import graph of `entry`: what loading it loads, before any handler runs. */
function eagerGraph(entry: string): EagerGraph {
  const files = new Map<string, string | null>([[entry, null]]);
  const packages = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (file.endsWith(".json")) continue; // data, imports nothing
    for (const specifier of eagerSpecifiers(file)) {
      if (specifier.startsWith("@/") || specifier.startsWith(".")) {
        const target = resolveLocal(file, specifier);
        if (!files.has(target)) {
          files.set(target, file);
          queue.push(target);
        }
      } else if (!specifier.startsWith("node:") && !packages.has(packageName(specifier))) {
        packages.set(packageName(specifier), file);
      }
    }
  }
  return { files, packages };
}

/** The import chain from the entry to `file`, so a failure says where to cut. */
function chainTo(graph: EagerGraph, file: string): string {
  const chain = [file];
  for (let at = graph.files.get(file); at; at = graph.files.get(at)) chain.unshift(at);
  return chain.join(" -> ");
}

describe(`the eager module graph of ${ROUTE}`, () => {
  const graph = eagerGraph(ROUTE);

  it("contains the tool registrations every request needs, so the checks below read the real graph", () => {
    expect(graph.files.has("mcp/tools.ts")).toBe(true);
    expect(graph.files.has("mcp/tools/memory-note.ts")).toBe(true);
    expect(graph.files.has("mcp/tools/memory-ingest.ts")).toBe(true);
    expect(graph.files.has("lib/db.ts")).toBe(true);
    expect(graph.packages.has("@modelcontextprotocol/sdk")).toBe(true);
  });

  it("does not load the Inngest barrel, any background job, the clients only they use, or agent naming", () => {
    const loaded = [...graph.files.keys()].filter((file) => WRITE_PIPELINE_FILES.test(file));
    expect(
      loaded.map((file) => chainTo(graph, file)),
      "load these with `await import()` in the handler that uses them",
    ).toEqual([]);
  });

  it("does not load the packages only the background jobs use", () => {
    const loaded = BACKGROUND_JOB_PACKAGES.filter((name) => graph.packages.has(name));
    expect(
      loaded.map((name) => `${name} via ${chainTo(graph, graph.packages.get(name)!)}`),
      "load these with `await import()` in the handler that uses them",
    ).toEqual([]);
  });
});
