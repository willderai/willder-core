// For panel tests that connect a GitHub repository: the answers the connect form's
// probe routes give for a token that reads `repos`, in the shape those routes send
// (app/api/sources/github/{repositories,reach}), and the steps a person takes to pick
// one. github-connect-form.contract.test.tsx proves the form against the real routes;
// a panel test only needs the form to reach its onConnect.
import { fireEvent, screen, within } from "@testing-library/react";
import type { GitHubRepositorySummary } from "@/services/connectors/github-token-probe";

function summary(fullName: string): GitHubRepositorySummary {
  return {
    fullName,
    private: true,
    visibility: "private",
    description: null,
    archived: false,
    fork: false,
    pushedAt: "2026-10-14T18:31:02Z",
  };
}

/** The probe routes' answer to `url`, or null when `url` is not one of them. */
export function gitHubProbeAnswer(url: string, repos: string[]): Response | null {
  if (url === "/api/sources/github/repositories") {
    const rows = repos.map(summary);
    return new Response(
      JSON.stringify({
        token: { kind: "fine-grained", scopes: null, canWrite: "unknown", writeScopes: [], expiresAt: null },
        reached: rows.length,
        truncated: false,
        ssoPartialResults: false,
        ssoWithheldOrganizations: 0,
        ssoWithheldOrganizationIds: [],
        rows,
        total: rows.length,
        page: 1,
        pageSize: 20,
      }),
      { status: 200 },
    );
  }
  if (url === "/api/sources/github/reach")
    return new Response(JSON.stringify({ repo: summary(repos[0] ?? ""), unreadable: [] }), { status: 200 });
  return null;
}

/** Pastes `token`, asks what it reaches, and picks `fullName`, inside `scope` (a panel) or the whole screen. */
export async function pickGitHubRepository(
  token: string,
  fullName: string,
  scope: HTMLElement = document.body,
): Promise<void> {
  const inside = within(scope);
  fireEvent.change(inside.getByLabelText("Token"), { target: { value: token } });
  fireEvent.click(inside.getByRole("button", { name: "Find repositories" }));
  fireEvent.click(await inside.findByRole("radio", { name: fullName }));
  // The pick is sent once the reach answer is on screen, as a person would see it.
  await screen.findByText(new RegExp(`of ${fullName.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\.`));
}
