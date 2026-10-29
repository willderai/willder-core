// Every API path the agents page fetches must resolve to a route that exists.
//
// The Era 1 outbound-sales cut deleted `app/api/agents/[id]/research/route.ts`
// without touching this page, which still selected that endpoint for the
// research role — so any agent row created before the cut had a Test-run button
// pointing at a route that was no longer there. Nothing failed at build or type
// time, because a fetch target is just a string. This test is that missing
// check: it reads the page's own fetch calls and resolves each one against the
// real `app/api` tree.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PAGE = join(__dirname, "page.tsx");
const API_ROOT = join(__dirname, "..", "..", "..", "app", "api");

/** Fetch targets that build their endpoint name from a variable, so no static
 *  reader can tell which route they hit. (A variable `[id]` segment is fine —
 *  the resolver matches those against the `[param]` directory.) Each one's
 *  possible endpoint names are listed here and checked individually; the
 *  "covers every variable target" test below fails if the page grows another
 *  one that is not listed here. */
const VARIABLE_ENDPOINTS: Record<string, string[]> = {
  // startInteractiveRun's `endpoint` parameter — a four-member string union.
  "/api/agents/${agentId}/${endpoint}": ["run-interactive", "plan-interactive", "run-manager", "plan-manager"],
  // runQuick's `path` argument, at its three call sites.
  "/api/agents/${agent.id}/${path}": ["handoff", "architecture", "qa"],
};

/** A `${...}` interpolation in a fetch template literal. Stands in for whatever
 *  a dynamic `[param]` segment matches. */
const DYNAMIC = Symbol("dynamic segment");
type Segment = string | typeof DYNAMIC;

/** Every `/api/...` string or template literal in a source file.
 *
 *  Deliberately not "the argument of a fetch call": the bug this test exists to
 *  catch built its URL into a variable first and passed that to fetch, so a
 *  reader that only looked inside `fetch(...)` would have walked straight past
 *  it. Any `/api/...` literal in a page is a route the page means to call. */
function apiPathLiterals(source: string): string[] {
  const all = [...source.matchAll(/(["'`])(\/api\/[^"'`]*)\1/g)].map((m) => m[2]);
  return [...new Set(all)];
}

function toSegments(path: string): Segment[] {
  return path
    .replace(/\?.*$/, "")
    .split("/")
    .filter(Boolean)
    .slice(1) // drop the leading "api"
    .map((raw) => (raw.includes("${") ? DYNAMIC : raw));
}

/** Walk `app/api` the way Next's router does: a literal segment matches a
 *  directory of that name, and anything else falls back to a `[param]`
 *  directory at that level. */
function routeExists(path: string): boolean {
  let dir = API_ROOT;
  for (const segment of toSegments(path)) {
    if (!existsSync(dir)) return false;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const dynamic = entries.find((name) => name.startsWith("["));
    const next = segment !== DYNAMIC && entries.includes(segment) ? segment : dynamic;
    if (!next) return false;
    dir = join(dir, next);
  }
  return existsSync(join(dir, "route.ts"));
}

/** Replace a variable final segment with one concrete endpoint name. */
function withEndpoint(target: string, endpoint: string): string {
  return target.replace(/\$\{[^}]*\}$/, endpoint);
}

describe("agents page API targets", () => {
  const targets = apiPathLiterals(readFileSync(PAGE, "utf8"));
  const variable = Object.keys(VARIABLE_ENDPOINTS);
  const fixed = targets.filter((t) => !variable.includes(t));

  it("finds the page's API paths at all", () => {
    // Guards against a vacuous pass: if the regex stops matching, every
    // assertion below would pass over an empty list.
    expect(fixed.length).toBeGreaterThan(0);
  });

  it.each(fixed)("%s resolves to a route that exists", (target) => {
    expect(routeExists(target)).toBe(true);
  });

  it.each(variable.flatMap((target) => VARIABLE_ENDPOINTS[target].map((endpoint) => [target, endpoint] as const)))(
    "%s resolves to a route that exists with endpoint %s",
    (target, endpoint) => {
      expect(routeExists(withEndpoint(target, endpoint))).toBe(true);
    },
  );

  it("covers every variable target the page actually has", () => {
    // A target that cannot be resolved on its own and is missing from
    // VARIABLE_ENDPOINTS would otherwise go unchecked, and a stale entry would
    // check a call the page no longer makes.
    const unresolvable = targets.filter((t) => !routeExists(t));
    expect(unresolvable.sort()).toEqual([...variable].sort());
  });

  it("does not target the deleted research endpoint", () => {
    expect(targets).not.toContain("/api/agents/${agent.id}/research");
  });

  it("rejects a route that is not there", () => {
    // The resolver has to be able to fail, or the checks above prove nothing.
    expect(routeExists("/api/agents/${agent.id}/research")).toBe(false);
    expect(routeExists("/api/agents/${agent.id}/${path}")).toBe(false);
    expect(routeExists("/api/definitely-not-a-route")).toBe(false);
  });
});
