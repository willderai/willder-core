# Connect Claude Code to Willder

Anthropic's terminal coding agent.

**Transport:** Streamable HTTP · **Auth:** `Authorization: Bearer <capability token>` ·
**Endpoint:** `https://willder.ai/api/mcp`

**Verified end to end on 2026-10-05**, against `https://willder.ai/api/mcp`. Both of the client matrix's claims hold for this row: the server answered the transport and authentication shape this page configures, and Claude Code itself connected, listed the Willder tools (all of them: the page did not yet set `X-Willder-Tools: coding`) and answered one scoped `memory_query`. Re-run both halves yourself:

```sh
WILLDER_MCP_URL=https://willder.ai/api/mcp WILLDER_TOKEN='<token>' \
  WILLDER_DEPLOYED_COMMIT=<deployed commit> \
  npx tsx scripts/mcp-client-probe.ts --client=claude-code
```

The probe is `scripts/mcp-client-probe.ts`; see [the index](README.md) for what every other row says.

## Get a token

Open **Access → Tokens** in your Willder workspace and issue a capability token for the
narrowest scope that answers your questions. The value is shown once; only its hash is stored.
Keep it in the client's secret storage or an environment variable — never in a committed file,
a prompt or a screenshot.

```sh
export WILLDER_TOKEN='<your capability token>'
```

## One command

From your project directory, with `WILLDER_TOKEN` exported (Node 20.19, 22.12 or 24; nothing
from npm):

```sh
git clone --depth 1 https://github.com/willderai/willder-core.git ~/.willder && node ~/.willder/cli/willder.mjs init
```

No copy of this repository? [willder.ai/docs/claude-code](https://willder.ai/docs/claude-code) installs
the same hook files from the site (`https://willder.ai/hooks/<file>`, served from `cli/hooks` by
`app/hooks/[file]/route.ts`) with the same settings.

`willder init` writes the `willder` server into the project's `.mcp.json` (the block under
"Config file" below, task header included) and installs the hook described under "Hear it before
any tool call". It writes variable references, never the token, keeps any other servers and
hooks in both files, and refuses a file it cannot parse without writing anything. `--url
http://localhost:3000` points both at a local server. It ends by printing the remaining steps and
a first sentence to give the agent.

## Config file

`.mcp.json` in the project root (project scope), or `~/.claude.json` (user scope). `willder init`
or `claude mcp add` writes it for you.

```sh
claude mcp add --transport http willder https://willder.ai/api/mcp \
  --header "Authorization: Bearer ${WILLDER_TOKEN}" \
  --header "X-Willder-Tools: coding"
```

Or write `.mcp.json` directly:

```json
{
  "mcpServers": {
    "willder": {
      "type": "http",
      "url": "https://willder.ai/api/mcp",
      "headers": { "Authorization": "Bearer ${WILLDER_TOKEN}", "X-Willder-Tools": "coding" }
    }
  }
}
```

**The coding tool set.** `X-Willder-Tools: coding` lists the four tools a coding agent calls:
`memory_query`, `memory_version`, `memory_ingest` and `memory_changes`. Claude Code sends every
listed tool's description to the model on every turn, called or not, so listing the other nine
would cost tokens on every turn. Leave the header out to list every Willder tool (adding
`memory_entity`, briefs, staleness, working notes, source links, contacts and feedback); a call to
one of them on a coding connection is answered with this instruction, not run.

**Name your task (optional).** Add `--header 'X-Willder-Task: ${WILLDER_TASK:-}'` to the command
above, or `"X-Willder-Task": "${WILLDER_TASK:-}"` to `headers`, and export `WILLDER_TASK` (a ticket
key or branch name) before starting Claude Code: the first Willder tool result of each session then
leads with what earlier sessions of that task decided and wrote. Keep the single quotes and the
`:-`, so the variable is read at every start and an unset one sends nothing.

**Hear it before any tool call (recommended).** That block rides on a Willder tool result, and a
coding agent busy with files and shell commands often calls no Willder tool at all. The hook below
brings the same block in on the session's first prompt, and changes other agents make to your scope
after each tool call. The one command above installs it; from a checkout of this repository it is:

```sh
node cli/willder.mjs init --project /path/to/your/project
```

Besides the server entry, it registers `UserPromptSubmit` and `PostToolUse` hooks in that project's `.claude/settings.json`,
and a `SessionStart` hook that runs only when Claude Code compacts the context or you type `/clear`
(matcher `compact|clear`). It reads `WILLDER_TOKEN` and `WILLDER_TASK` from the environment at run
time; it never writes the token. The hook sends Claude Code's session id, so each session is told
the block once for its task. A compaction keeps the session id, but the model after it no longer
holds the block, so the hook asks for it once more with `X-Willder-Reason: compact`, and the prompt
after it is not told it again. A `/clear` starts a new session id, and the hook asks for its block
at once with `X-Willder-Reason: clear`. Either boundary's block leads with what is verified (a
person's records, what the hook saw the last session's tests and changes do), then what still fails,
the decisions and the options rejected, and serves plans and the next step last, as claims to check.
With `--capture` below, the session state written before the compaction, or when the cleared
session last stopped, is the newest, so what it saw opens the block.
On each prompt it also sends the prompt's first 512 characters, with anything that looks like a
secret replaced first (the same redaction as capture below), so the block's rules and recent writes
are ranked by what you asked rather than by the task's name alone. Willder reads it for that one
answer and keeps it nowhere: it is not stored, logged or added to memory.
Claude Code's MCP connection is its own session to Willder (each new connection is a new one), so
a session that also calls a Willder tool can be told it a second time, on that tool's first result.

**Keep where each session stopped (optional, off by default).** Add `--capture` to the init
command. The hook then writes one fact per task and Claude Code session into your Willder scope,
replacing it each time: the files changed since the session started, the last test command and
whether it passed and when it ran, which test files (tests, snapshots, mocks, fixtures, test runner
configs) the session had edited before that run, which of them the command named, which of them
already existed when the session started, which it edited after it, the files Claude's edit tools
wrote, up to the last eight shell commands it ran with their exit status (as many as fit in 700
characters; the command only, never what it printed, without a heredoc's body, and with passwords
given as `-p`, `-a`, `--password`, `user:password`, a here-string or an `echo` into a pipe or a file
replaced by `[redacted]`), and the agent's last message (cut to 1,000 characters, the whole fact to
3,000; the commands and edited files are shortened first). After a compaction or `/clear` the next
session is served the commands with the agent's claims, not as verified, since their words (a commit
message, say) are the agent's own; a session's first block leaves them out. It also writes the functions git names over the session's changes.
It writes every five tool calls of the session's own (`WILLDER_SNAPSHOT_EVERY` sets another count;
`0` turns these snapshots off), when the session stops, before it compacts, and when a test run flips
between failing and passing (at most once every 10 minutes), through `/api/mcp` with your
`WILLDER_TOKEN`, so the same access checks and audit log apply; a read-only token captures nothing.
A write whose content has not changed since the last one is not sent. A snapshot asks nothing of
Claude and tells it nothing: a separate background process writes it while Claude carries on, and
logs what it did to `capture.log` in the state directory below. One write runs at a time: a Stop
that finds a snapshot still writing hands its own write to the same kind of background process.
All of one session's writes count as one memory episode toward the free plan's limit, and other
agents in your scope are told of a session's state once, when it is first written. The next session of the task
is served it after anything recorded on purpose, opening with that last test run; a note that says
the task is done is marked unverified only when that run failed, passed after the session edited
tests that existed before it, or tests were edited after it. A pass when the session only wrote
new tests is said plainly and not marked. Before anything is sent, the hook replaces what
looks like a secret with `[redacted]`: the values of your secret-named environment variables
(`*_TOKEN`, `*_KEY`, `*_PASS`, `*_SECRET`, `*_DSN`, `DATABASE_URL`, ...); private key blocks (PEM
and PGP); the user and password or token in a URL; known token shapes (Willder, Anthropic, OpenAI,
Stripe, GitHub, GitLab, Slack, AWS, Google, npm, JWTs, `Bearer` and `Basic` credentials); the value
given to a secret-named key in env, YAML, JSON, URL query, HTTP header (`Authorization`, `X-Api-Key`,
`Cookie`, `Set-Cookie`) and `=>`/`:=` form; and long runs of random-looking base64 or hex. This is
best-effort, not a guarantee: a secret in none of these forms, or described in the agent's own words,
is sent as written, so do not turn capture on where a session may handle text that must not leave the
machine. The hook also keeps a small state file per session and repository, readable only by you, in
your OS temp directory (`willder-capture/`): the commit the session started on, digests of the names
of the files that were already untracked then with each file's size and modification time, the last
test command (redacted), its result and time and the test files edited before it (redacted), the
last shell commands with their exit status and the files the edit tools wrote (redacted), a count
of tool calls, and the
version of the last write, with the stamps of the test files changed at that run; and one small file
per session listing, as digests, the repositories it was seen in. It never holds your token. When
the session ends the state file is cut down to the version of its last write, so a session resumed
with `claude --resume` replaces its one fact instead of writing a second; the handoff ask keeps three
flags per session beside it. Any of these left by a session that was killed or never resumed is
deleted a week later. `--capture` sets `WILLDER_CAPTURE` in
`.claude/settings.json`, so it applies to everyone who runs agents in this project; to turn it off,
run `willder init` again without `--capture`.

**Long work: a handoff before the context is cleared (with `--capture`).** When a session re-sends
120,000 tokens or more of context each turn (`WILLDER_HANDOFF_AT` sets another size; `0` turns it
off), the hook asks Claude once, right after a test run passes or a commit is made, to record a
handoff: one `memory_ingest` named `Handoff: <task>, session <id>` with what still fails, what was
done and checked with its evidence, the decisions and rejected options with their reasons, what is
not yet checked, and the next step as what to verify first. Willder refuses a handoff missing a part
and says what to add. After `/clear` or a compaction, the next session is told the handoff part by
part, each labelled by what recorded evidence shows, never by its own words. Setting
`WILLDER_RESTART_NUDGE=on` also has Claude end its reply with `Willder handoff recorded: /clear to
continue from it.` once the handoff is stored; it is off until the long-task study shows a split
session finishes as well as an unbroken one.

A server written into `.mcp.json` is project-scoped, and Claude Code holds it at
`⏸ Pending approval` until you approve it once in an interactive session (`claude`, then
**Yes** when it asks about the project's MCP servers). `claude mcp add` writes a local-scope
server instead, which needs no approval — that is why it is the first command here.

## Verify the connection

```sh
claude mcp get willder    # expect: ✔ Connected
```

Then ask Claude Code to call `memory_query` and confirm it returns facts from your scope.

## Notes

Claude Code also supports an OAuth login flow (`/mcp` → authenticate). Willder does not serve OAuth yet, so use the header.

See [the index](README.md) for the other clients and [`mcp/README.md`](../../mcp/README.md) for the tool surface and the token rules.
