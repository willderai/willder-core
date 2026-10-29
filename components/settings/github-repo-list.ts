/**
 * The repository picker's list, one config for both ends: the connect form's
 * toolbar reads it for its search, order and filter controls, and
 * POST /api/sources/github/repositories applies it to the token's listing, so
 * the browser only ever holds one page of repositories.
 */
import { compareText, compareTime, type ListConfig } from "@/components/list-controls/list-query";
import type { GitHubRepositorySummary } from "@/services/connectors/github-token-probe";

/** Repositories on one page of the picker. */
export const GITHUB_REPO_PAGE_SIZE = 20;

export const GITHUB_REPO_SORTS = ["pushed", "name"] as const;
export const GITHUB_REPO_VISIBILITIES = ["public", "private", "internal"] as const;

const VISIBILITY_LABEL: Record<(typeof GITHUB_REPO_VISIBILITIES)[number], string> = {
  public: "Public",
  private: "Private",
  internal: "Internal",
};

export const GITHUB_REPO_LIST: ListConfig<GitHubRepositorySummary> = {
  noun: { one: "repository", many: "repositories" },
  searchText: (repo) => [repo.fullName, repo.description],
  sorts: [
    {
      key: "pushed",
      label: "Last pushed",
      compare: (a, b) => compareTime(a.pushedAt, b.pushedAt) || compareText(a.fullName, b.fullName),
      defaultDirection: "desc",
      directionLabels: { asc: "Oldest first", desc: "Newest first" },
    },
    {
      key: "name",
      label: "Name",
      compare: (a, b) => compareText(a.fullName, b.fullName),
      directionLabels: { asc: "A–Z", desc: "Z–A" },
    },
  ],
  filters: [
    {
      key: "visibility",
      label: "Visibility",
      options: GITHUB_REPO_VISIBILITIES.map((value) => ({ value, label: VISIBILITY_LABEL[value] })),
      matches: (repo, value) => repo.visibility === value,
    },
  ],
  paramPrefix: "github.",
};
