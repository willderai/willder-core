import { requireAccessContext } from "@/lib/access-context";
import { MAX_LIST_SEARCH_LENGTH } from "@/lib/list-search";
import { applyListState, type ListState } from "@/components/list-controls/list-query";
import { pageRows } from "@/components/list-controls/list-page";
import {
  GITHUB_REPO_LIST,
  GITHUB_REPO_PAGE_SIZE,
  GITHUB_REPO_SORTS,
  GITHUB_REPO_VISIBILITIES,
} from "@/components/settings/github-repo-list";
import {
  GitHubProbeError,
  cachedTokenRepositories,
  findRepository,
  tokenFingerprint,
} from "@/services/connectors/github-token-probe";
import { parseRepoFullName } from "@/services/connectors/github";
import { bad, probeErrorReply, probeLimitReached, readToken, reply, tooManyProbes } from "../probe-request";

// POST /api/sources/github/repositories — the repositories a pasted GitHub token can
// read, one page at a time, and how far the token reaches, before anything is saved.
//   Body: { token, q?, sort?: "pushed" | "name", order?: "asc" | "desc",
//           visibility?: "public" | "private" | "internal", page?, refresh?: boolean }
//         `refresh` reads GitHub again instead of the minute-old listing, for a
//         person who has just authorized the token for an organization's SSO;
//         a read already in flight for the same person and token is joined.
//   200:  { token: GitHubTokenBreadth, reached, truncated, ssoPartialResults,
//           ssoWithheldOrganizations, ssoWithheldOrganizationIds, rows, total, page, pageSize }
//         `reached` is how many repositories the token lists (at most
//         MAX_LISTED_REPOSITORIES, `truncated` when it lists more); `total` is how
//         many match the search and filter; `rows` is the page asked for.
//         `ssoPartialResults` is true when GitHub left out the repositories of
//         organizations whose SAML single sign-on has not authorized the token, so
//         `reached` is not everything; `ssoWithheldOrganizations` counts the
//         organizations GitHub named (0 when it named none), by the numeric ids in
//         `ssoWithheldOrganizationIds`.
//
// The one rule: the token is used for this request and nowhere else. It is never
// stored, logged or echoed back, and it travels in the body, never the URL. The
// listing is kept for a minute under who asked and a hash of the token, so search
// and paging do not re-read GitHub; it is never served to anyone else.
//
// GitHub cannot search the repositories a token can list, so this route reads the
// listing (cached) and searches, filters, orders and pages it here: the browser
// holds one page. A search that is exactly `owner/name` and matches nothing in the
// listing is looked up directly, so a repository past the listing's cap, a public one
// a fine-grained token can read without listing it, or one since renamed (GitHub
// redirects the old name) can still be picked.
//
// Any signed-in member may ask: the answer is only what the caller's own token can
// see, and nothing of the org. Connecting stays gated by POST /api/sources. A broad
// token is reported, never refused.

const MAX_PAGE = 10_000;

type Body = {
  token?: unknown;
  q?: unknown;
  sort?: unknown;
  order?: unknown;
  visibility?: unknown;
  page?: unknown;
  refresh?: unknown;
};

/** True when `query` names one repository as owner/name. */
function isRepoName(query: string): boolean {
  try {
    parseRepoFullName(query);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return reply({ error: "unauthorized" }, 401);

  if (probeLimitReached(rc.org.id, rc.user.id)) return tooManyProbes();

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return bad("invalid json body");
  }
  if (body === null || typeof body !== "object") return bad("invalid json body");

  const read = readToken(body.token);
  if ("error" in read) return bad(read.error);
  const { token } = read;

  if (body.q !== undefined && typeof body.q !== "string") return bad("q must be a string");
  const query = (body.q ?? "").trim();
  if (query.length > MAX_LIST_SEARCH_LENGTH) return bad(`q must be at most ${MAX_LIST_SEARCH_LENGTH} characters`);
  if (query.includes("\u0000")) return bad("q must not contain a NUL character");

  const sort = body.sort ?? "pushed";
  if (!GITHUB_REPO_SORTS.includes(sort as never)) return bad(`sort must be one of ${GITHUB_REPO_SORTS.join(", ")}`);
  const order = body.order ?? (sort === "name" ? "asc" : "desc");
  if (order !== "asc" && order !== "desc") return bad("order must be asc or desc");
  const visibility = body.visibility;
  if (visibility !== undefined && !GITHUB_REPO_VISIBILITIES.includes(visibility as never)) {
    return bad(`visibility must be one of ${GITHUB_REPO_VISIBILITIES.join(", ")}`);
  }
  const page = body.page ?? 1;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    return bad(`page must be a whole number from 1 to ${MAX_PAGE}`);
  }

  if (body.refresh !== undefined && typeof body.refresh !== "boolean") return bad("refresh must be true or false");

  const view: ListState = {
    query,
    sort: sort as string,
    direction: order,
    filters: visibility === undefined ? {} : { visibility: visibility as string },
  };

  try {
    const listing = await cachedTokenRepositories(`${rc.org.id}:${rc.user.id}:${tokenFingerprint(token)}`, token, {
      refresh: body.refresh === true,
    });
    let rows = applyListState(listing.repositories, GITHUB_REPO_LIST, view);
    const named = isRepoName(query) && !rows.some((r) => r.fullName.toLowerCase() === query.toLowerCase());
    if (named) {
      const found = await findRepository(token, query);
      // The search named it, so only the filters apply: a renamed repository answers under its new name.
      // It then takes its place in the chosen order, among rows that already matched the search.
      const unsearched = { ...view, query: "" };
      const kept =
        found && !rows.some((r) => r.fullName === found.fullName)
          ? applyListState([found], GITHUB_REPO_LIST, unsearched)
          : [];
      if (kept.length > 0) rows = applyListState([...rows, ...kept], GITHUB_REPO_LIST, unsearched);
    }
    return reply({
      token: listing.breadth,
      reached: listing.repositories.length,
      truncated: listing.truncated,
      ssoPartialResults: listing.ssoWithheldOrganizationIds !== null,
      ssoWithheldOrganizations: listing.ssoWithheldOrganizationIds?.length ?? 0,
      ssoWithheldOrganizationIds: listing.ssoWithheldOrganizationIds ?? [],
      rows: pageRows(rows, page, GITHUB_REPO_PAGE_SIZE),
      total: rows.length,
      page,
      pageSize: GITHUB_REPO_PAGE_SIZE,
    });
  } catch (e) {
    if (e instanceof GitHubProbeError) return probeErrorReply(e);
    throw e;
  }
}
