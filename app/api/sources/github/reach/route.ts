import { requireAccessContext } from "@/lib/access-context";
import { GitHubProbeError, findRepository, unreadableParts } from "@/services/connectors/github-token-probe";
import { GitHubConnectorError, parseRepoFullName } from "@/services/connectors/github";
import { bad, probeErrorReply, probeLimitReached, readToken, reply, tooManyProbes } from "../probe-request";

// POST /api/sources/github/reach — what a pasted token may read of the one
// repository picked in the connect form, before anything is saved.
//   Body: { token, repo: "owner/name" }
//   200:  { repo: GitHubRepositorySummary, unreadable: ("readme" | "issues" | "pulls" | "commits")[] }
//   404:  the token cannot see the repository.
//
// A part is unreadable only when GitHub refuses it for lack of permission; a sync of
// that repository skips the same parts, so the form can say so before connecting.
// The token is used for this request only: never stored, logged or echoed back.
// It shares the per-person probe limit with POST /api/sources/github/repositories.

export async function POST(req: Request) {
  const rc = await requireAccessContext();
  if (!rc) return reply({ error: "unauthorized" }, 401);

  if (probeLimitReached(rc.org.id, rc.user.id)) return tooManyProbes();

  let body: { token?: unknown; repo?: unknown };
  try {
    body = await req.json();
  } catch {
    return bad("invalid json body");
  }
  if (body === null || typeof body !== "object") return bad("invalid json body");

  const read = readToken(body.token);
  if ("error" in read) return bad(read.error);
  if (typeof body.repo !== "string") return bad("repo (owner/name) is required");
  try {
    parseRepoFullName(body.repo);
  } catch (e) {
    if (e instanceof GitHubConnectorError) return bad(e.message);
    throw e;
  }
  const name = body.repo.trim();

  try {
    const repo = await findRepository(read.token, name);
    if (!repo)
      return reply({ error: `This token cannot see ${name}. Check the name, or give the token access to it.` }, 404);
    return reply({ repo, unreadable: await unreadableParts(read.token, repo.fullName) });
  } catch (e) {
    if (e instanceof GitHubProbeError) return probeErrorReply(e);
    throw e;
  }
}
