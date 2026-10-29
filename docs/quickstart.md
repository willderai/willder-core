# Quickstart: one person, three agents, one memory

You run a coding agent, a research agent and an agent for a side project. This guide gives
them one memory where each sees only its own part, shares one part with a second agent on
purpose, and takes it back. Every command is copy-pasteable, every expected output is shown,
and every way it can fail has its fix.

You need: a Willder workspace you administer (if you created it, you do), and an agent
client that supports remote MCP with a custom `Authorization` header (Claude Code and
Cursor both do). For Claude Code's one-command setup you also need `git` and Node 20.19,
22.12 or 24; nothing is installed from npm. Cursor needs nothing installed.

From a new workspace to your Claude Code agent storing and reading its first fact is six
actions: create a scope, issue a token, load it in your shell, run one command, start
`claude` and approve the project's server, and give it one sentence. Until 2026-10-14 the same
result took nine: the same first three, then `claude mcp add`, cloning this repository and
running `willder init` for the hook, starting `claude`, a write, and a separate read. That is
a count of actions, not a timed run by someone new to Willder.

Prefer to run the service yourself? [docs/development.md](development.md) is the local
install; the steps below are the same once the app is at `http://localhost:3000`.

## Before you start: how to hold a token safely

A token looks like `wcap_...` and is shown exactly once. Willder stores only its hash, so a
lost token cannot be recovered, only replaced. Keep it in an environment variable or your
client's secret field. Never paste it into a prompt, a file in the repo, or a screenshot.

Open a terminal and run this; type or paste the token at the prompt. Nothing is echoed.

```bash
printf 'Willder token: '
stty -echo; read -r WILLDER_TOKEN; stty echo
printf '\n'
export WILLDER_TOKEN
```

Expected: a new prompt and nothing else. Run the remaining terminal commands in this same
session; a new terminal window does not have the variable.

| It went wrong | Fix |
|---|---|
| `fish:` reports an error | You are in `fish`. Run `bash` or `zsh` first, then the command. |
| You pasted and nothing appeared | The prompt hides what you type. Press Enter. |
| The terminal stopped showing what you type | You stopped the command before Enter. Run `stty echo`. |
| `echo $WILLDER_TOKEN` prints nothing in another window | Variables do not cross windows. Run the token prompt again there. |

## Step 1: give each agent its own scope

A scope is the part of memory an agent can reach. Three sibling scopes mean none covers
another.

1. Sign in at [willder.ai](https://willder.ai/sign-in) and open **Access**, then **Scopes**.
   If the page stays on the sign-in form after you submit, open
   [willder.ai/access](https://willder.ai/access) yourself.
2. Under **Scope name** type `Coding`, leave **Parent scope** on `Org root`, choose
   **Create scope**.
3. Repeat for `Research` and `Side project`.

Expected: three rows in the scopes list, each with a path like `org_xxxx.coding_1a2b3c`.
The suffix is random; copy the path from this list whenever a step asks for one.

| It went wrong | Fix |
|---|---|
| **Access** is not in the navigation | You are not an administrator of this workspace. Ask the person who created it, or create your own workspace. |
| `scope not found` when you type a parent path | Leave the parent on `Org root`, or pick the parent from the list. |
| Signing in leaves you on `/sign-in` | Open [willder.ai/access](https://willder.ai/access) directly. If that sends you back to sign in, the sign-in did not complete: check the email and password and submit again. |

## Step 2: mint one token per agent

1. Still in **Access**, open **Tokens** and find **Issue token**.
2. Fill in: **Agent** `coding_agent` (if the list has no such agent, choose **Other client**
   and type the name as **Client ID**), **Scope** `Coding`, **Permission** `write`,
   **TTL hours** `168` (seven days). **Scope** is a tree picker that starts on `Org root`:
   open it, type `Coding` in **Search scopes**, and pick `Coding`. Choose **Issue token**.
3. The page shows **Token issued — copy now, shown once**. Copy it, then load it with the
   token prompt above.
4. Repeat for `research_agent` on `Research` and `side_project_agent` on `Side project`, each
   `write`, each copied into its own agent's client.

Expected: three rows in **Agent tokens**, status `active`, each on a different scope.

The same thing over the API, from a browser session that is signed in (the route uses your
session, not a token):

```
POST https://willder.ai/api/access/capabilities
{ "agentId": "coding_agent", "scopePath": "org_xxxx.coding_1a2b3c", "permission": "write", "ttlHours": 168 }
```

Expected: HTTP 201 with `id`, `agentId`, `scopePath`, `permission`, `expiresAt` and, once
only, `token`.

| It went wrong | Fix |
|---|---|
| The scope field was left at **Org root** | That token can read every scope. Revoke it (step 6 shows how) and issue another on `Coding`. |
| You closed the page before copying | The value is gone. Issue a new token; revoke the one you lost. |
| HTTP 403 with a reason naming `access.manage` | You do not administer that scope. Issue from a scope you created, or ask its admin. |
| HTTP 404 `scope not found` | The `scopePath` has a typo. Copy it from **Access → Scopes**. |
| `ttlHours` above 2160 is silently capped | 90 days is the maximum lifetime. Pick a shorter one for anything temporary. |
| An `admin` token expires after two hours | Admin on an agent is for setup only: it ends two hours after issue and cannot be extended. Issue `read` or `write` for anything that runs longer. |

## Step 3: connect the agent

### Claude Code

One command, from the project directory, in the terminal where `WILLDER_TOKEN` is loaded.
It needs only Node (20.19, 22.12 or 24) and nothing from npm: the installer and its hook use
Node's built-in modules.

```bash
git clone --depth 1 https://github.com/willderai/willder-core.git ~/.willder && node ~/.willder/cli/willder.mjs init
```

Expected, ending with:

```
Connected this project to Willder:
  /path/to/project/.mcp.json  (the willder MCP server; it holds the variable name, not the token)
  /path/to/project/.claude/hooks/willder-changes.mjs
  /path/to/project/.claude/settings.json

Session-state capture is off. Add --capture to turn it on (see docs/connect/claude-code.md).

Next:
  Start claude in this project and answer Yes when it asks to use the project's MCP servers.
  Then tell it:
    Save this to Willder: we store sessions in Postgres, not Redis, so they survive a restart. Then ask Willder where we store sessions and why.
```

If it also prints `WILLDER_TOKEN is not set in this shell`, run the token prompt from the
top of this page before starting `claude`.

It writes two things next to your code. `.mcp.json` holds the `willder` server with the header
`Bearer ${WILLDER_TOKEN}`, the variable name, which Claude Code expands at connect time, so
the token never lands in a file, and `X-Willder-Tools: coding`, which lists only the tools a
coding agent calls. `.claude/settings.json` registers the hook that brings in, on
each prompt and after each tool call, what other agents changed in this scope. Other servers
and hooks already in either file are kept, and running it again replaces only its own entries.

Start `claude` from the same terminal. The first time, it asks whether to use the MCP servers
in this project's `.mcp.json`: answer yes. Until you do, the server stays off and
`claude mcp list` shows `willder` as `Pending approval`. Then run `/mcp`, and `willder` is
listed as connected with its four coding tools (`memory_query`, `memory_version`,
`memory_ingest`, `memory_changes`). Remove the `X-Willder-Tools` header from `.mcp.json` to list
every Willder tool (adding `memory_entity`, `fact_link_source`, `memory_stale`, `memory_note`,
`get_my_brief`, `send_feedback` and the contact tools); see
[docs/connect/claude-code.md](connect/claude-code.md#config-file).

Prefer to wire it by hand? `claude mcp add -s project --transport http willder
https://willder.ai/api/mcp --header 'Authorization: Bearer ${WILLDER_TOKEN}' --header
'X-Willder-Tools: coding'` writes the same server entry without the hook; keep the single quotes.

### Cursor

Create or edit `.cursor/mcp.json` in the project. The token is read from the environment
Cursor was started with, so it never lands in the file:

```json
{
  "mcpServers": {
    "willder": {
      "url": "https://willder.ai/api/mcp",
      "headers": { "Authorization": "Bearer ${env:WILLDER_TOKEN}" }
    }
  }
}
```

Expected: in Cursor's MCP settings, `willder` shows a green status and the tool list.

### Check from the terminal (any client)

This direct request is supported by the stateless endpoint and proves the token is
recognized:

```bash
curl --silent --show-error https://willder.ai/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $WILLDER_TOKEN" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Expected: JSON with `result.tools`, one entry per tool, each with a name, description and
input schema.

| It went wrong | Fix |
|---|---|
| HTTP 401 `Missing bearer capability token` | The header did not arrive. In the terminal, `echo ${#WILLDER_TOKEN}` should print a number above 20; if it prints `0`, run the `read` line again. In a client, check the header field name is exactly `Authorization`. |
| HTTP 401 `Invalid or unknown capability token` | The token has a typo, has expired, or was revoked. Issue a new one. |
| The client asks for OAuth | That client cannot send a custom header. Use Claude Code or Cursor, or any client with a bearer-header field. |
| `claude mcp list` shows `willder` as `Pending approval` | You have not approved the project's servers yet. Start `claude` in this directory and answer yes when it asks. |
| Claude Code lists `willder` as failed | Run `claude mcp get willder` to see the stored URL and header; remove with `claude mcp remove -s project willder` and add again. |
| `.mcp.json` contains your real token | It was added by hand with double quotes, so the shell expanded the variable. Revoke that token in **Access → Tokens**, then run `node ~/.willder/cli/willder.mjs init` again: it replaces the entry and tells you it held a token. |
| `init` says `.mcp.json is not valid JSON` or `.claude/settings.json ... Fix it` | It found a file it cannot merge into and wrote nothing. Fix the file the message names, then run it again. |
| `git clone` says the destination already exists | You cloned before. Run `git -C ~/.willder pull`, then the `node` half of the command. |
| Cursor shows `${env:WILLDER_TOKEN}` literally | Cursor was started before the variable existed. Quit Cursor fully and launch it from a terminal where `WILLDER_TOKEN` is set. |
| `curl: (6) Could not resolve host` | No network, or a proxy. Try `curl https://willder.ai` first. |

## Step 4: first write, then check the fence

Tell your coding agent the sentence `willder init` printed, or these words in any client:

> Save this to Willder: we store sessions in Postgres, not Redis, so they survive a restart.
> Then ask Willder where we store sessions and why.

It calls `memory_ingest` with the decision as `content` and a `name` for what it is about.
Both are required; a call without `name` is refused before anything is stored.

Expected tool result, ending with the id a later update passes as `baseVersion`:

```
Stored and readable now; graph extraction continues in the background. Version: <version id>.
```

Then it calls `memory_query`. Expected: one bullet per fact, with when it was stored, who
wrote it and its version, then the answer's revision:

```
• we store sessions in Postgres, not Redis, so they survive a restart. (as of <when it was stored>) — from: <agent name> (agent) · version <version id>
revision: <16 hex characters>
```

The bullet carries the words the agent wrote. Once graph extraction finishes, the same
question can also return facts extracted from it, each with its own bullet.

Then ask your research agent, through its own `Research` token, the same question.

Expected:

```
No facts found.
```

That is the fence. The decision lives in `Coding`; the research token covers `Research`.

| It went wrong | Fix |
|---|---|
| `Stored. Queued for ingest — will appear in memory shortly.` | The immediate store was skipped; the queued job finishes it. Wait a minute and query again. |
| The write returns an error mentioning `memory service` or `timed out` | The memory service was slow (a known in-flight fix). Query first: if the fact is there, do not write it again. If not, retry the write once. |
| `Access denied` on the write | The token's permission is `read`. Issue a `write` token on `Coding`. |
| The research agent does see the Coding decision | Its token is on the org root or on `Coding`. Open **Access → Tokens**, check the row's scope, revoke it and issue one on `Research`. |
| The coding agent's query says `No facts found.` right after the write | Ask again; the first read can race the store by a second. If it still fails after a minute, the write did not land: write again. |
| The agent "saves" it in its own notes instead of calling the tool | Say `use the willder memory_ingest tool`. Check the tool list in step 3 shows `memory_ingest`. |

## Step 5: share Coding with your second agent

Your first grant goes to your own second agent, not to another person.

1. **Access → Tokens → Issue token**: **Agent** `research_agent`, **Scope** `Coding`,
   **Permission** `read`, **TTL hours** `24`.
2. Add it to the research agent's client as a second server named `willder_coding`
   (Claude Code: the `claude mcp add` line again with `willder_coding` as the name and the new
   token in a second variable such as `WILLDER_CODING_TOKEN`).
3. Ask the research agent the sessions question through `willder_coding`.

Expected: the Postgres bullet from step 4, naming the coding agent as its writer. Through its original `willder` server the answer
is still `No facts found.`, and a write through `willder_coding` is refused:

```
Access denied: no valid capability for agent research_agent granting write on org_xxxx.coding_1a2b3c
```

Optional: have the research agent call `memory_changes` on `willder_coding`. Expected: the
coding agent's write, listed once. Its own writes are never listed. `No changes.` means
nothing new since its last call.

| It went wrong | Fix |
|---|---|
| Both servers answer the same | The two tokens are on the same scope. Check the rows in **Access → Tokens**. |
| The second server will not connect | The second variable is empty in the shell that started the client. `echo ${#WILLDER_CODING_TOKEN}`. |
| The write through `willder_coding` succeeds | That token is `write`, not `read`. Revoke and reissue. |

## Step 6: revoke, then read the audit

1. **Access → Tokens**, find the `research_agent` row whose scope is `Coding` and choose
   **revoke**. The button turns into `Sure?` with **yes** and **no**; choose **yes**. The row
   now shows a **revoked** badge and no revoke button.
2. Ask the research agent the sessions question through `willder_coding` again.

Expected: the call fails with HTTP 401:

```
Invalid or unknown capability token.
```

The research agent's own `Research` server keeps working. Over the API the same revoke is
`DELETE /api/access/capabilities/<token id>` from a signed-in session; expected
`{ "revoked": "<id>", "revokedAt": "<timestamp>" }`, and a second call returns the same
timestamp with `alreadyRevoked: true` (revoking twice never moves the date).

3. Open **Audit** and filter by actor `research_agent`.

Expected: the allowed `memory.read` rows from step 5, then a `capability.refused` row with
decision `deny` and reason `capability revoked: token refused before any action ran`.

What revocation does not do: it cannot take back answers the agent already received, and it
does not touch the agent's other tokens. Revoke each one you mean to end.

| It went wrong | Fix |
|---|---|
| The next call still succeeds | A client may cache a response. Ask a different question. If it still answers, the row you revoked was a different token: compare the **Token ID** column with `claude mcp get willder_coding`. |
| `could not revoke that token` | You do not administer that scope. The scope's admin revokes it. |
| No `capability.refused` row | The agent has not called since the revoke. Make one call, then refresh **Audit**. An unknown token (never issued) is refused without a row, since there is no agent to record it against. |

## Where to go next

- A brief: on **Agents**, set up the Handoff agent on `Coding` for `research_agent`. Its brief
  is read with `get_my_brief`, which the coding tool set does not list, so add a third server
  for the research agent: the `willder_coding` line from step 5 under another name, without the
  `X-Willder-Tools` header. Through that server, have the agent read its brief.
- A second person: **Access → Grants** gives a member a scope and a permission the same way.
- Every tool and its inputs: [mcp/README.md](../mcp/README.md). Routes:
  [willder_api.md](willder_api.md).
- Something broke that this page did not predict: open an issue with the step number, the
  exact error text, and the client. Never include a token.
