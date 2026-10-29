// A fake of the paged GET /api/sources in the Integrations panels' component tests:
// it answers a page request over a fixture with the semantics services/memory/source-page.ts
// gives the query (that file's realdb test pins the SQL), so a test checks what the
// panels send and show.
import { parseAccessListQuery } from "@/lib/access-lists";
import { CONNECTOR_SOURCE_TYPES, SOURCE_LIST_SPEC, SOURCE_PAGE_SIZE, typesNamed } from "@/lib/source-lists";

/** The fields of a source row this fake reads; a fixture may carry any others. */
type SourceFixture = { id: string; type: string; name: string; scopePath: string; status: string; createdAt: string };

const byText = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase());

/** True for a GET of the sources list (not a per-source route). */
export function isSourcesList(url: string): boolean {
  return new URL(url, "http://localhost").pathname === "/api/sources";
}

/** The JSON GET /api/sources?page= answers over `sources`, given in newest-first order. */
export function sourcesPage<S extends SourceFixture>(url: string, sources: S[]) {
  const params = new URL(url, "http://localhost").searchParams;
  const q = parseAccessListQuery(params, SOURCE_LIST_SPEC);
  if (q === null || "error" in q) throw new Error(`not a page request: ${url}`);
  const { type, status, kind } = q.filters;
  const named: string[] = typesNamed(q.search);
  const connectorTypes: readonly string[] = CONNECTOR_SOURCE_TYPES;
  const listed = sources.filter((s) => !kind || connectorTypes.includes(s.type));
  const kept = listed.filter(
    (s) =>
      (!type || s.type === type) &&
      (!status || s.status === status) &&
      (q.search === "" ||
        [s.name, s.scopePath].some((t) => t.toLowerCase().includes(q.search.toLowerCase())) ||
        named.includes(s.type)),
  );
  const sign = q.order === "asc" ? 1 : -1;
  const ordered = [...kept].sort((a, b) =>
    q.sort === "name"
      ? sign * byText(a.name, b.name)
      : q.sort === "scope"
        ? sign * byText(a.scopePath, b.scopePath)
        : sign * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
  );

  const at = params.get("at");
  const index = at === null ? -1 : ordered.findIndex((s) => s.id === at);
  const page = index >= 0 ? Math.floor(index / SOURCE_PAGE_SIZE) + 1 : q.page;
  const start = (page - 1) * SOURCE_PAGE_SIZE;
  return {
    sources: ordered.slice(start, start + SOURCE_PAGE_SIZE),
    total: kept.length,
    count: listed.length,
    page,
    pageSize: SOURCE_PAGE_SIZE,
    ...(at === null ? {} : { found: index >= 0 }),
  };
}

/**
 * A fetch fake over `sources`: a GET of the list answers one page of them, and
 * every other request answers `{ sources }` with 200.
 */
export function answerSources<S extends SourceFixture>(sources: S[]) {
  return async (url: string, init?: RequestInit) =>
    isSourcesList(url) && (init?.method ?? "GET") === "GET"
      ? Response.json(sourcesPage(url, sources))
      : Response.json({ sources });
}
