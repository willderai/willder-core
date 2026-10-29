# Willder MCP server

Connect a compatible AI client to shared project memory. Hosted clients use scoped bearer
capability tokens; local development can use the same tools over stdio. Handoff, Architecture
and QA briefs can also be retrieved through MCP. Tool registration lives in
[`mcp/tools.ts`](tools.ts), shared by both transports.

## Hosted setup

Hosted access requires no source checkout or database credentials.

1. Open **Access → Tokens** in a Willder workspace. An administrator of the chosen scope can
   issue a token for an agent with a permission and expiry. Select a narrow existing scope;
   omitting the scope defaults to the workspace root.
2. Copy the token when shown. It is returned once and only its hash is stored. Put it in the
   client's secret storage; keep it out of prompts, source control and screenshots.
3. Configure the client with these connection values:

   | Setting | Value |
   |---|---|
   | URL | `https://willder.ai/api/mcp` |
   | Transport | Streamable HTTP |
   | Authorization header | `Bearer <your capability token>` |

4. Use the client's normal MCP initialization/discovery flow. `tools/list` returns the current
   names, descriptions and input schemas. Then try a small `memory_query` against knowledge
   in that scope.

The client must support remote MCP with a custom bearer header. Configuration file formats
and secret interpolation differ by client; an OAuth-only connector cannot use this flow
unchanged. See the [hosted connection guide](https://willder.ai/docs/connect).

The endpoint at [`app/api/mcp/route.ts`](../app/api/mcp/route.ts) is stateless: it creates a
server and transport for each request. There is no persistent MCP session or server-initiated
SSE subscription. Its GET/DELETE transport handlers do not provide a live memory feed;
use `memory_changes` or the separate change-feed endpoint.

### Direct diagnostic request

Load the token without putting its value in shell history:

```bash
printf 'Willder token: '
stty -echo; read -r WILLDER_TOKEN; stty echo
printf '\n'
export WILLDER_TOKEN
```

This direct `tools/list` request is supported by the stateless endpoint. SDK clients should
still follow their normal initialization flow.

```bash
curl --silent --show-error https://willder.ai/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $WILLDER_TOKEN" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

To query, use the same headers with this JSON body:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "memory_query",
    "arguments": { "query": "What decisions are recorded for this project?", "limit": 5 }
  }
}
```

“No facts found.” is a valid empty result. Facts are returned as text with source/actor
attribution when available, not a structured list of fact UUIDs. Check the evidence before
using an answer for an important decision. Successful discovery does not prove that the token
has the scope and permission needed for a later tool call.

## Server instructions: recording the rules a person states

Every `initialize` result carries `instructions` (`mcp/willder-server.ts`, the same text on the
hosted endpoint and the stdio server, whatever tool set the connection asks for). They tell the
agent to record a lasting rule, preference or decision the person states with `memory_ingest`
(`kind: "convention"` or `"decision"`), and to show the person the confirm link the reply
carries. Only a person can confirm. Until then a decision is served as a lead to verify, while a
convention is served at once, marked `[agent-recorded]`; so the text says to use `decision` when
unsure. They also say what not to record: instructions for the current task only, questions, the
agent's own guesses, a rule Willder already served unchanged, and anything read from files, tool
results or memory rather than said by the person. They do not point the agent at `supersedes`:
an agent's replacement of a person's rule is not yet refused.

A client that honours server instructions keeps this text in its model's context for the whole
connection. Claude Code does. A client that does not can be given the same text in its own
instruction file; [`docs/connect/README.md`](../docs/connect/README.md#recording-the-rules-you-state)
has it. Whether a model follows the text is measured by a live session, not by the tests:
`mcp/willder-server.test.ts` pins the text and its wiring, and `mcp/rule-confirmation.realdb.test.ts`
follows a recorded and confirmed rule to the next session's task-start block.

## Current tools

Use `tools/list` as the input-schema reference. Checked against the registrar on 2026-10-16:

| Tool | Purpose | Permission |
|---|---|---|
| `memory_query` | Retrieve facts for a natural-language question; optional `scopePath` and limit up to 50. Every completed read ends with a note naming the one scope it was checked against (its name, never a parent's, sibling's or child's) | Read on the requested scope |
| `memory_entity` | Read an entity and its known facts | Read on the requested scope |
| `memory_version` | Read one stored version of a fact or rule by the id a change notice gave you, with whether it is current, superseded or retired | Read on the version's own scope |
| `memory_ingest` | Queue a note; optionally record a typed convention or decision, or update a fact you read with `baseVersion` | Write on the requested scope |
| `fact_link_source` | Link a known fact UUID to a source for provenance/staleness checks | Write on the requested scope |
| `get_my_brief` | Read a named brief, or the latest brief for the selected scope | Read on the brief's scope |
| `memory_stale` | The few records (briefs, derived records) whose cited or source fact has been replaced, or was changed or removed after they were built, most depended-on first, with the reason | Read on the requested scope |
| `memory_changes` | Read other actors' changes since this agent's server-held position | Read on the requested scope |
| `memory_note` | Post, renew or release a short-lived working note: what this agent is doing right now | Write on the requested scope |
| `contact_search` | Search contact records | Read at the workspace root |
| `contact_read` | Read a contact by ID | Read at the workspace root |
| `contact_upsert` | Create/update a contact with revision checks | Write at the workspace root |
| `send_feedback` | Send a bug, request or praise privately to the people who run this server; at most 20 an hour per agent | Any valid token |

### The coding tool set: `X-Willder-Tools: coding`

An MCP client sends every listed tool's schema to its model on every turn, whether or not the
tool is called. A hosted connection that sends the `X-Willder-Tools: coding` header is listed
only `memory_query`, `memory_version`, `memory_ingest` and `memory_changes`, the tools a coding
agent calls (`memory_changes` because every change notice names it for what it could not fit); the
Claude Code and Codex connect pages and `willder init` set it. Without the header, or with any
other value (a header sent twice, `coding, coding`, still selects it), every tool above is listed. The set changes what is listed, never what the token
may do. A `tools/call` to another Willder tool on a coding connection is answered with an error
naming the header to remove, not run (a notification gets no reply, and a JSON-RPC batch gets the SDK's "Tool <name> not found" instead). The
stdio server does not read the header and lists every tool. Defined in `mcp/tool-set.ts`.

`memory_ingest` takes `content`, `name`, optional `scopePath`, optional
`kind: "convention" | "decision"`, optional `supersedes` for replacing a typed rule,
optional `baseVersion` for updating a fact you read, optional `occurredAt` for when the content
happened, optional `intentionalShareFrom` for sharing content read in another scope (below), and
an optional `idempotencyKey`. The note
is stored and announced on the change feed before the call returns ("Stored and readable now"),
so `memory_query` and other agents' `memory_changes` see it at once; graph extraction (entities,
relations) is queued separately and lands later. A recorded typed rule can be served at session
start. When the immediate store fails the call still succeeds with "Queued for ingest", and the
note becomes readable once the queued job finishes.

To retry safely, send an `idempotencyKey` (1 to 255 characters, unique to the write). A call
repeated with the same key and the same arguments writes nothing and returns the first call's
reply; the same key with any argument changed is refused; a repeat that arrives while the first
call is still writing is refused as "still in progress", so retry it again shortly. Keys belong
to the calling agent in its org and do not expire. Without a key, a repeat of the same note
(same scope, name and content) is collapsed only when the immediate store succeeded; a note
that was queued instead is written once per call.

When two agents write the same fact — the same `name` in the same scope — within one second
of each other, the version the server stored first wins and stays current; every later version
in that window is recorded as superseded by it and announced on the change feed, and both stay
readable with `memory_version`. A rule write that loses the same race is refused, but its
version is stored too, and the refusal names it.
One agent's own writes never conflict with each other, so several facts it records about one
entity at once all stay current. A `memory_ingest` whose version has already lost when it is
stored replies "Stored, but superseded by <id>" instead of "Stored and readable now".

### Writing content read in another scope: `intentionalShareFrom`

An agent that may read scope A and write scope B could read A and write a summary of it into B,
handing A's content to every reader of B. Willder does not let that happen silently
(`services/access/derived-writes.ts`):

- **Reads are recorded.** The scope of every fact an agent's session is shown is recorded,
  wherever it is shown: `memory_query`, `memory_entity` and `memory_version`, a fact's line in
  the change feed (`memory_changes`, a change notice, `GET /api/changes`) or in the task-start
  block, whole or as an excerpt. So is the scope of a brief (`get_my_brief`), of a graph fact
  or entity summary with no stored version behind it (the scope it was read under), of a
  contact (the org root), of another agent's working note (in the change feed, the task-start
  block, or a claim's reply naming an earlier claim), and of a source link served as a stale
  flag in the task-start block. Your own write's reply and your own notes are not reads; reading
  that fact back later is.
- **A silent downgrade is refused.** A write into B after the session read a scope that is
  neither B nor inside B (a sibling, or a parent: a grant on B covers B's subtree only) is
  refused with `derived_write:`, nothing is stored, and the refusal names the scopes to declare.
  Content is never compared: a write that only reads like it came from elsewhere is refused the
  same, and a summary is refused however it is worded.
- **A declared share is visible.** Send the named scopes in `intentionalShareFrom` and the write
  is stored with a `derivedFrom` edge to each source scope, written in the same statement as the
  fact. Each source scope's audit log gets a "Shared content from a restricted scope into a wider
  one" row naming B, and its readers see the share on their change feed. A reader of B who may
  also read the source sees `shared from <scope>` on the fact's bullet and in `memory_version`;
  one who may not sees `shared from a restricted scope`, which reads the same for a hidden scope
  and a deleted one.
- **A declaration is checked.** It may name only scopes this session read; a scope that does not
  exist, one you may not read and one you simply did not read get the same refusal. A scope
  inside B needs no declaration and is refused if named. Declaring a scope covers what the
  session read inside it.

A session is keyed on your agent, not on the connection: every connection and every token of
one agent is one session, and it ends after 30 minutes with no memory read or write. The hosted
endpoint is stateless and its `Mcp-Session-Id` is a value the client sends back, so a fresh
connection cannot start a fresh session.

A working note (`memory_note`) is checked as a write: posting one from a session that read a
scope outside the note's scope is refused with `derived_write:`. A note cannot declare a share,
so carry that content with `memory_ingest` and `intentionalShareFrom` instead. Releasing a note
is not checked; it removes your own note and carries no content. A renewal of a note that was removed
while the renewal ran (a person erasure takes your note lock first, so it is not one of
these) is refused with `note_gone:` and nothing is stored: post again to start a new note.
A release of such a note finds nothing to release, as when you had none. A source link
(`fact_link_source`) is checked the same way: its reference is shown to the scope's readers when
the source moves, so recording one from a session that read a scope outside the link's scope is
refused with `derived_write:`, and a link cannot declare a share either.

What the rule cannot see: content carried past a 30-minute gap outside Willder (in your own
context, a file), content passed between two agents outside Willder, and a person copying text
by hand. A rule served in the task-start block is not recorded as a read, and change notices
that announce a shared fact to B's readers do not carry its marker yet.

### When the content happened: `occurredAt`

A note is dated by when it was stored unless it says otherwise. Send `occurredAt` when the
content happened earlier: a meeting written up the next day, a chat imported a month later. It
takes an ISO-8601 date (`2026-03-11`, read as midnight UTC) or a date-time with an offset
(`2026-03-11T15:10:00Z`, `2026-03-11T08:10:00-07:00`), and is stored in UTC. A value without an
offset, a day the calendar does not have, or a time more than five minutes ahead of the server's
clock is refused with `invalid_input:` and nothing is stored: it is when something happened,
not when it is due. A date inside that allowance but after the moment the note is stored is
recorded as the moment it is stored, so a note cannot be dated ahead of writes that came after
it. The date is shown on the note's `memory_query` bullet, `(as of <date>)`.

`occurredAt` dates and orders the note only. Graph extraction still runs on the server's clock,
so a stated time never decides which of two contradicting extracted facts the graph retires. A
note whose text is already stored writes nothing: the stored version keeps its own date. When
that differs from the date this write would have had, the reply names the version and its date:
`occurredAt was not applied: …` when you sent one, or `…; that date stands.` when you did not and
the stored version carries a date its writer stated.

`memory_query` serves its answer in relevance order, and the date only breaks ties. Two notes
written under the same `name` in the same scope are versions of one fact: the newest takes the
best place any of them holds, so an updated value is read before the one it replaced. Two
different notes are never reordered by date alone, however close their match. The one exception
is the answer's first bullet, when the question asks for a value ("what is", "how many",
"when"). A later note in the same scope and provenance tier, dated the same way and served whole
(not an excerpt), is served directly above it, newest first, when its words state a new value of
the same thing, of the same kind and period. The first bullet stays, marked `· a later record on
this is shown above`. The mark says only that: a later record about this thing is above. It does
not say the later record replaced this one, because that is read from words, not known.

Four wordings count: "the deadline was extended to May 20", "I've adjusted our holiday gift
budget to $450", "my increased budget of $650", "the budget is now $550". The thing is the noun
phrase the value belongs to: its head noun is one of the question's words (not a name, not a word
the question only puts after a preposition as in "at Acme", and not a word the first bullet only
uses to qualify another noun, as "savings" in "savings goal"); when the question asks about a
goal, limit or target, the head must be that goal. Its other words are the question's or the first
bullet's, the words after its head are the question's, and it carries every word the question and
the first bullet both put before that noun. A scope phrase after the value is part of the thing
too. It opens with "for", "in", "at", "across", "within", "inside", "outside", "under", "among",
"throughout", "per", "through", "via", "by", "with", "from", "toward", "beyond", "alongside" or
"upon", or with "on" after "to <value>", and runs to the end of its clause; a next clause that
opens with one of them ("for good, for the Denver team") and a list joined by "and" or "or" ("for
marketing and sales") are read too. Its words, short codes such as "UK", "U.K.", "H2" or "R&D"
included, must also be the question's or the first bullet's: "increased to $10,000 for my side
business", "on Sam's project", "through the staffing agency", "for FY25", "for the UK" or "for
IT" is another budget, while "for groceries" can be the queried one. "For good", "for everyone"
and "at my annual review" name nothing, but only as the whole phrase: "for everyone on the Denver
team" names the Denver team. A capitalized code spelled like a common word ("IT", "OR", "ME")
counts only in text that has lower-case words too, so all-caps text reads as its lower-case
spelling does. This costs recall: a phrase that names a person, a manner or a time rather than
another thing ("by my manager", "with immediate effect", "via text", "by Friday") also keeps a
real change from linking. The first bullet's value must be that thing's own
(said within a few words of its name, not spent, left, covered, conditional or someone else's).
So "the estate tax exemption" is not an estate tax rate, "the budget for dining" is not the
budget for groceries, and "my monthly budget" is not "my grocery budget".

Only the person's own words are read: text under no speaker label, or under "User:", "Human:",
"Me:" or "You"; never an assistant's or another speaker's turn, a quoted line, or lines a line
ending in a colon introduces, and a change of the "I increased …" form needs "I" or "we" as its
subject. A change is not read when its clause denies, asks, conditions, wishes, plans or proposes
it; when its sentence reports it second hand ("Alexis said …"), dates it away from now ("last
year", "during the pandemic", "for 2025"), makes it temporary or per something else ("for a
month", "for the year", "per person"), opens with a time, place, condition or question verb
("When I lived in Boston …", "Do you remember …"), gives back a value the first bullet states
("…, then cut back to $500"), or undoes it ("I refused"); nor when the note takes something back
("never mind", "just kidding") or is a scenario, a dream or about someone else, the change is
someone else's ("her rent", "Alexis's budget"), said of "it", a bound or a difference ("up to",
"$50 more"), or from a value the first bullet does not state. Each of these is a list of words:
a qualifier worded some other way is not seen, which is why the mark claims no more than a later
record on the same thing. So a later record on the same thing that is not its current value can
still be served above it: one dated away in words the lists do not hold ("years before we had
kids"), a draft, an undo that gives no value ("then lowered it again"), a temporary purpose ("for
the wedding"), or a subset ("for enterprise clients"). A phrase after the value that names
something the question does not ("to $550 in the app") also keeps a real change from linking. Nothing is dropped or added, and only bullets the answer already holds
are compared. The match is on the words, in English, with no model asked; a change worded any
other way is not linked, which leaves the answer in its ranked order. Only `memory_query` does
this; the REST read and the chat search return the ranked order. A fact the graph extracted keeps
its place: a date its text claims, "as of 2099", never moves it. The date never decides which
facts are in the answer. A fact the graph extracted from a note is served as
that note when the same answer already holds the note, so one note never takes several bullets
and its date is never lost to an undated paraphrase. Erasure still judges a note by when it was
stored, whatever `occurredAt` says.

### Updating a fact you read: `baseVersion`

A write that is based on a read says which version it read, the way `contact_upsert`'s
`baseRevision` does for a contact. Each `memory_query` bullet that answers from one stored
version ends with `· version <id>`; `memory_version`, change notices and the `memory_ingest`
reply (`Version: <id>`) name versions too. Pass that id as `baseVersion` with the same `name`
and scope, and the new version replaces it: the old one stops being served, stays readable by
id, and other agents see a `supersede` change naming the replacement. A bullet a connected
source synced from one item also names that item, `· item <id>`, before any version: the id
the item's change notices name, so a notice can be matched to the fact it produced even when
the fact is worded differently from the item.

If someone else replaced that version after you read it, the write is refused with
`stale_version:`, naming the current version, and nothing is stored: read the current version,
then write again with its id as `baseVersion`. This is what stops agent A, writing back from a
stale read, from replacing agent B's newer version. If the stale write raced B's so closely
that it was already stored, it is kept but marked superseded by B's version, never extracted
into the graph, and the refusal names both. A `baseVersion` that is not a version of this fact
is refused with `unknown_version:`. An identical retry of an accepted based write replays
without storing anything again.

### Writing without `baseVersion`

Most clients never send `baseVersion`, so the server keeps its own record of what each agent
read: every version a `memory_query` bullet, a `memory_entity` fact, a `memory_version` answer
or a `memory_ingest` reply served to it, plus the versions it wrote. A read the server cannot
record is answered with an error instead of the facts; retry it. A `create fact` line in
`memory_changes`, a change notice or the task-start block is recorded too, as a sighting: its
text may be cut short, so it is never counted as reading that version.

A write without `baseVersion` replaces nothing, but when the fact (same `name`, same scope) has
a current version that you never read and did not write, stored after the newest version of it
you read or wrote (or, if you have only seen it in the feed, after the first version you saw
there) and more than a second before your write, the write comes from a stale read and is
refused with `stale_version:`, naming that version; nothing is stored. Read it with
`memory_version`, then write again: without a base to add your version beside it, or with its
id as `baseVersion` to replace it. A write that raced that version past the check is kept,
marked superseded by it, and the refusal names both. A version stored within the second before
your write is a concurrent write instead, settled by the conflict rule above: when yours loses,
it is stored, the reply says "Stored, but superseded by <id>", and nothing is refused. A write
about a fact you have neither read, written nor seen in the feed is an ordinary new version.

Two writes within the conflict window are not a conflict when one writer had already read the
other's version: the later one was written knowing the earlier, so neither supersedes the
other, and a third writer's version in the same window cannot make the earlier one win over
it. Seeing it only in the feed does not count.

Rules follow the same contract through `supersedes`: replacing a rule that was already replaced
is refused and nothing is stored. The refusal reads the same as for an id you cannot reach, so it
cannot probe what exists; `memory_version` on the id you passed names its replacement when you
may read it.

An agent never replaces a rule a person recorded or confirmed. Naming one in `supersedes` still
stores your rule, beside the person's and replacing nothing: a decision of yours is served as a
lead next to their settled one, a convention in force next to theirs, tagged as agent-recorded.
The reply names both and the fix (a person confirms yours and retires theirs), and the refusal
leaves one `memory.write` deny row. `memory_query` serves the two rules' fact copies the same way:
the settled one first, credited to its person, and anything else on its subject after it,
each line labelled settled or lead.

The contact tools are supporting business-record operations, not outreach draft approval.
`draft_list`, `draft_approve`, `draft_reject` and `campaign_list` are not registered. MCP has
no general fact update/delete tool; use the authorized app operations for those changes.
`fact_link_source` does not automatically refresh an existing fact.

## Task context and change notices

On the first tool result of a session, the server can attach scoped conventions, decisions,
recent writes and stale flags. Clients may provide optional `_meta` hints `willder/session`
and `willder/task`; they guide grouping and selection, not authorization. When no session hint
is provided, each new connection is a new session: the hosted endpoint answers every `initialize`
with a fresh `Mcp-Session-Id`, which the client sends back on that connection's requests, and a
stdio server is one session per process. On one connection, or for a client that does not send
the id back, a pause of 30 minutes without a call starts a new session. A block counts as told
only if the client is still waiting when it is ready: when the client hangs up, or the change-feed
hook's 2-second wait has run out, the block is left for the session's next call. The task block has an estimated
600-token budget for its header, records and closing line. The two lines that name no record,
the premise check and the line on what changed since the last session, are added on top when
shown and never take a record's room, so a block is at most 694 tokens; the combined piggyback,
with five change lines of typical length, is an estimated 1,100 tokens (a merged change line
names its fact in full and can run past it). These use a rough character-based count.

`willder/task` is your name for the task (an issue key, an item id, a branch name). A
`memory_ingest` call made in a session that names a task records that name with the write. A
later session naming the same task, by any agent, is served first what those writes left
inside the reader's own scope: the decisions they recorded, as the versions in force now, and
the current versions of the facts they wrote, then the scope's other rules. The facts come
those their writers declared decide the task first, then the writes most relevant to what the
session is doing (the prompt or the call's own arguments), the newest first among equals, each
as an excerpt of at most 200 characters that `memory_version` opens whole by its fact id (a
captured session state is served up to 1,300 characters from its opening). A fact someone
updated or that lost a conflict is served as the version that replaced it. Names are matched
exactly. The session's words never bring in a record that is not the task's, but they order
the task's facts, and so decide which of them fit the budget. Without `willder/task`, the block ranks the scope's rules and recent writes
by the words of the call's own arguments instead.

What another session left is served as a lead, labelled by what backs it, never by its words. A
cause or a constraint keeps the role its writer declared (`[cause · proposed]`). A decision whose
session recorded no test run after it is labelled `[untested plan: verify before following]`; any
other plan nothing backs keeps a label that says why (`[plan · proposed: ...]`). The leads serve the
causes and constraints, and what its own session's passing run backs (a progress note or a
rejected option aside), first; then the rest in the read's order, so a plan sits beside the options
its writer rejected. The planned test after a fact's excerpt names one command block-wide, the
narrowest any served fact of the task names, and a sentence of a plan that only introduces a
command or a verify list is left out of its excerpt. A cause, a constraint or a decision rule is
served whole, command included. The change notices on the same result leave out the creation of a
fact version the block shows.

Clients that cannot set `_meta` per call (Claude Code, Cursor and the other IDE clients) name
the task for the whole connection with an `X-Willder-Task` request header, usually set from an
environment variable in their MCP config. It is read exactly like `willder/task` (control
characters become spaces, then trimmed and cut at 512 characters; a blank value, or one that is
an unexpanded `${...}` reference because the client did not expand its config, names no task),
and a call's own `willder/task` wins over it. The
hosted endpoint reads it; the stdio server does not. [`docs/connect/`](../docs/connect/README.md)
shows the line for each client.

### Compact read responses

Full supplementary context remains the default. To keep read responses short, set
`_meta["willder/context"]` to `"compact"` on a tool call. Hosted clients that cannot set
per-call metadata can send the `X-Willder-Context: compact` header on each request.
`"full"` restores normal delivery; an explicit per-call value overrides the header.
Other values select full delivery. Stdio supports the per-call metadata, not the HTTP header.

Compact applies to `memory_query`, `memory_entity`, `memory_version`, `get_my_brief`,
`contact_search`, `contact_read` and `memory_stale`. It leaves their answers,
revisions, access checks and primary-answer warnings intact. It defers only automatic change
notices. The session's first task-start block, including the scope's standing rules, is still
delivered whether or not the caller names a task or session.

Allowed read results carry `Change notices deferred; memory_changes reads pending changes.`
in place of automatic change notices. This is a delivery preference, not a claim that nothing
changed. Deferred changes are neither consumed nor recorded as feed sightings; task-start
context still records the content it serves. Use `memory_changes` to read the feed explicitly
(it advances the normal server-held cursor), or send `"full"` to resume automatic delivery.
Compact still records notice denial and recovery exactly as full mode does. When the token's
notice scope is denied, no deferred line is shown. Changes written while denied are skipped
by the existing denial rule.

An allowed compact-only reader leaves its feed position unchanged. If its readable scope later
widens, an explicit feed read can include older changes that are now readable; a full reader
may already have scanned past those changes. All deliveries are checked against current
access. Read the feed explicitly when you want its position to advance.

Writes ignore compact mode and retain their existing notices, including pre-write sightings
used by stale-read checks. Session-state captures still carry no notices because their caller
discards the reply.

### Working notes

`memory_note` posts one line about what the agent is doing right now, so another agent in the
scope learns it on its next tool call instead of after the work is finished. It takes
`kind` (`claim`, `intent`, `status` or `question`), `task` (what the note is about; defaults to
the session's `willder/task`), `body` (at most 280 characters), optional `expiresInMinutes`
(default 30, at most 240), optional `action: "release"` and optional `scopePath` (defaults to
the token's scope; posting needs write on it).

- A note is live until it expires or is released. Posting the same kind on the same task again
  renews it from now; `release` ends it. Expired and released notes are kept but no longer
  served as live: notices, the task-start block and the collision check leave them out, while
  `memory_changes` and `GET /api/changes` still list their posts as history.
- Each post, renewal and release is a change on the change feed (`recordType` `note`), so it
  reaches other agents through the change notices below, the hook and `memory_changes`, with
  the same scope filter. A notice leaves out the post of a note that has since ended and keeps
  its release.
- The task-start block lists up to three notes live in the scope, notes on the session's own
  task first, and says how many more are live when there are.
- A `claim` on a task another agent has a live claim on (compared without regard to case) is
  stored, and the reply names that agent, when it claimed and its line, for claims in scopes
  the caller can read. Both claims stay; Willder detects and reports the overlap and does not
  decide between them.
- A `claim` may carry `touches`, the files its agent edits, as `file:<repo>/<path>` (at most 64;
  they replace the claim's earlier list; omitted keeps it). Where the org has claim overlap on
  (`orgs.settings.claimOverlap = true`; off otherwise, and then touches are not stored), the reply
  names other agents' live claims on other tasks, in scopes the caller can read, that already touch
  a file the post added (five listed, with how many more), and every one of those claimants hears
  of it on its next tool call, including ones the caller cannot read, when its own scope covers
  both claims (`recordType` `claim_overlap`, filed under the two claims' lowest common scope, so
  only readers of both see it). A claimant whose scope covers only its own claim, as with two
  sibling scopes, is not told: telling it would show the other claim to readers who cannot read
  it. A touches-only post adds its files to the claim's list rather than replacing it, renews
  the agent's claim on the task in the target scope or one below it, and leaves out a touch that
  is not a file node, keeping the rest. Turning the flag off stops new touches and new overlaps;
  overlap events already recorded keep showing in notices until the claim that made them ends. Touches alone
  never claim a task its agent released, and an empty list alone makes no claim. A shared file is reported once per pair of claims. A claim may be posted with
  touches and no body; it then keeps the body it had and never shortens its life. Detected and
  reported, never resolved (`services/memory/claim-overlap.ts`).
- A note is not a fact: it is never ingested, `memory_query` never returns it, and anything
  worth keeping is written with `memory_ingest`.

A session that starts more than 30 minutes after the agent's last call in the org is a return.
When others changed something in the token's scope after that call that the agent has not been
told about yet, the task-start block opens with one line under its header:
`Since your last session (last call 2026-10-13 09:12 UTC): 7 changes by 2 other writers in your scope, 3 on this task.`
It counts changes by other agents, people and connector syncs, not working-note posts, only
inside the scope, and at most 1000 ("1000 or more changes"); "on this task" counts those made
under the session's `willder/task`. It names no record: the change notices after the block say
what changed. It takes none of the records' room, so a return is served the same records a
first session would be, with the line above them. A first session, a reconnect within 30 minutes, or a return to a scope where
nothing changed gets no line. The last call is read from the task-start deliveries Willder
already keeps (`services/memory/since-last-session.ts`), so nothing new is recorded; the daily
prune of idle deliveries keeps each agent's newest one for this. Like the block itself, a return
that opens a hook session and an MCP connection at the same moment can be told the line once by
each.

Results other than `memory_changes` may also include `Changed in your scope since your last
call:` with up to five lines about changes from other actors. When more than five changes are
new, the notice merges them by subject: a fact (every version of one name in one scope, the
versions memory_version and the conflict rule treat as one fact) or any other record. A merged
line reads `- 4 changes to fact "acme/web#101" by 3 actors; latest: supersede fact <id>: ...`,
naming the latest change and its operation in full. The notice describes the longest run of new
changes, in feed order, that fits five subjects, and reads no further: the last line says how
many changes wait ("12 more changes are waiting: call memory_changes.") and they arrive on a
later call or from `memory_changes`. Nothing is consumed without being described, except your
own changes and the posts of working notes that have since ended. Every count covers only
changes in your scope.
`memory_changes` reads the feed explicitly and may carry task-start context without
adding the same change-notice wrapper. When there is no applicable context, no extra block is
attached. Notice retrieval failures leave the original tool result intact.

The feed shares a server-held cursor with the optional Claude Code hook and excludes the
agent's own writes. This mechanism delivers context on tool calls; it does not interrupt an
agent, rewrite an earlier answer, or guarantee a changed decision. There is no fixed delivery
latency promised here.

For an agent spending time in shell/file tools, install the optional hook from the checkout:

```bash
node cli/willder.mjs init --project /path/to/your/project
# For a local app, add: --url http://localhost:3000
```

It writes the `willder` server into that project's `.mcp.json` (variable references, never the
token; other servers kept) and registers `UserPromptSubmit` and `PostToolUse` hooks in its Claude settings,
plus a `SessionStart` hook that runs only after a compaction or a `/clear` (matcher `compact|clear`),
uses `WILLDER_TOKEN` from the environment and calls `GET /api/changes/notice`, which answers with
what a tool result would carry: the task-start block on the session's first call, then the change
notices. `WILLDER_TASK`, when set, is sent as `X-Willder-Task`, so the block serves that task's own
records. The hook also sends Claude Code's `session_id` as `X-Willder-Session`, and the block is
told once per session, task and token scope, and once more after Claude Code compacts the session
(`X-Willder-Reason: compact`), since compaction keeps the session id. After a `/clear` the hook asks
at once with `X-Willder-Reason: clear`. A block at either boundary, or for a task that holds a
handoff, is laid out verified first and serves plans and the next step last, as claims to check
(`mcp/task-start-notice.ts`), with a records budget of 2,000 tokens. An MCP connection that names no session is its own
session to that count (its `Mcp-Session-Id`), so a Claude Code session using both can be told the block once by each. It stays silent without a token, on an error, or when there is no notice. It does not store
the token in the project. See [docs/development.md](../docs/development.md) for the local service setup.

With `--capture`, the hook also keeps one `progress` fact per task and Claude Code session saying
where the work stands (files changed; the files its edit tools wrote; the last test run's result
and time, which test files the session had edited before it, which of those the command named, which
of those existed when the session started, and which it edited after it; its last shell commands with
their exit status, never their output; last message; secrets redacted), written every `WILLDER_SNAPSHOT_EVERY` tool calls of the session's own (5 when unset, `0` for
never) by a detached process that the agent never hears from, on `Stop`, `PreCompact` and a test
result that flips, through `memory_ingest` with the same token
(`cli/hooks/willder-capture.mjs`; redaction, best-effort, in `cli/hooks/willder-redact.mjs`). Its calls carry `_meta["willder/capture"] = "session-state"`,
which skips graph extraction for that write and leaves the session's notices for the agent
(`mcp/session-capture.ts`). It is off unless `WILLDER_CAPTURE=session-state`.

On a long session the hook also asks the agent, once per crossing of `WILLDER_HANDOFF_AT` tokens of
context (120,000 when capture is on), at a passing test run or a commit, for a handoff
(`cli/hooks/willder-handoff.mjs`): a `memory_ingest` named `Handoff: <task>, session <id8>` with six
headings (`services/memory/session-handoff.ts`). `memory_ingest` refuses one missing a part, with
`incomplete_handoff:` and what to add, and stores a complete one as `progress` without graph
extraction. `WILLDER_RESTART_NUDGE=on` adds a restart line once it is stored; it is off by default.

With `WILLDER_CLAIM_TOUCHES=on` and a `WILLDER_TASK`, the hook records the files the agent edits
on its claim on that task: after each `Edit`, `Write`, `MultiEdit` or `NotebookEdit` call it adds the
file's path from the repository root, and at most once a minute sends the list as the claim's
`touches` through `memory_note` (`cli/hooks/willder-touches.mjs`). Only paths are sent, never a
file's contents, and a path redaction would change is left out. When the reply names another
agent's claim that shares one of the files, the hook shows the model that part of the reply. Its
calls carry `_meta["willder/capture"] = "touches"`, so no notices ride on them.

The task-start block serves the task's newest capture first among its progress notes, opening with
its last test run: `PASSED` or `FAILED`, when it ran, and what the capture saw its session do to
tests around it ("no test edits seen in this repo", existing tests it edited and ran, tests it
wrote and passed, tests edited after it, or tests it ran outside what the capture can see). A line showing one of the task's own
decisions, facts or writes (those the task itself wrote) that says the work is done, finished,
fixed, resolved, completed, implemented, shipped or addressed is marked `[unverified: ...]` only on
evidence of a problem: the last recognised run failed (a summary that counts failures is a failure,
whatever the command's exit); it passed after its own session edited a test file that existed when
the session started, whatever the run named (when every test file the session edited is one it
wrote, that is test-first work, stated without a mark); or a test file was edited after it (`services/memory/session-state.ts`). No recognised
run, a capture that could not tell, tests outside what it can see, and non-test edits after a pass
mark nothing. A run's time is never taken as later than when its capture was written.
A task with no capture is told nothing about tests. The run's result and test edits are read from
lines the hook writes before the command, where nothing the agent wrote can stand in for them. A
capture is recognised by its name, role and opening line, so it is trusted as far as any fact its
writer could write; the change notices that ride beside the block are not marked.

## Resources and prompts

Every connection, hosted or stdio, is also served these, each read through the same access
decision as the tool it mirrors:

- `willder://brief`, listed: the newest brief generated for the token's own scope, as
  `get_my_brief` returns it without an id.
- `willder://version/{versionId}`, a template that lists nothing: one stored version of a fact or
  rule, as `memory_version` returns it. A version the token may not read, an erased one and an
  unknown id all answer `Resource not found`, alike.
- `start_task`, a prompt: opens a task with the facts the token may read that bear on it, cited,
  read as `memory_query` reads them (with its note when the task names a value no readable memory
  holds), and asks the agent to record what it learns. Its `scopePath` argument completes to the
  scopes at or below the token's own, at most 100, marked `hasMore` when there are more.

Willder's resources are not subscribable; `memory_changes` is where a client reads what changed.
`mcp/resources-prompts.realdb.test.ts` holds these rules.

## The MCP conformance suite: `X-Willder-Conformance: fixtures`

The official suite (`@modelcontextprotocol/conformance`) tests each protocol feature by calling
fixtures with fixed names and contents: a tool `test_image_content`, a resource
`test://static-text`, a prompt `test_simple_prompt`, an elicitation with fixed defaults. A
connection that sends `X-Willder-Conformance: fixtures` is served them beside Willder's own tools,
resources and prompts (`mcp/conformance-fixtures.ts`), but only if its agent is listed in
`MCP_CONFORMANCE_AGENTS`: comma-separated `orgId/agentId` pairs. Unset or empty means nobody, and
any other token that sends the header gets a plain connection. A fixture reads and writes no
memory, so no `check()` stands in its way, and a sampling or elicitation fixture can hold a call
open for 30 s; that is why it is not every token's. No other connection lists them, so an agent's
model is never shown a test tool. To run the suite against a deployment, use a dedicated agent
in an org that holds no memory and set its pair in `MCP_CONFORMANCE_AGENTS` on the deployment.
The suite's server runner cannot send an Authorization header, so start a loopback proxy in front
of `https://<host>/api/mcp` that adds `Authorization: Bearer <the agent's read token>` and this
header, and maps a Host or Origin naming the proxy to the target's (any other Host or Origin goes
through as sent, so the target judges it). Then point the pinned suite at the proxy:

```bash
npx @modelcontextprotocol/conformance@0.2.0-alpha.12 server --url <proxy URL> --requirements 2025-11-25
```

The suite needs Node 22 or later. `--requirements` exists from the 0.2.0 line on.

On such a connection replies stream as server-sent events, because the fixtures send log and
progress notifications, and sampling and elicitation requests, while a call runs. The client
answers a request with a new POST, which reaches a fresh server, often on another instance; the
waiting call reads the answer from `mcp_client_requests`, and takes it only from the token that
asked, as its agent, in its org: another token of the same agent is ignored. The row keeps the
token's hash, or for an OAuth app the capability it was issued for, never the token
(`mcp/client-requests.ts`, `mcp/client-requests.realdb.test.ts`). What this endpoint,
stateless by design, does not do:

- `logging/setLevel` is accepted, but no level is kept between requests, so it filters nothing;
  Willder's own tools send no log messages.
- A subscription is accepted for the fixture `test://watched-resource` only, and no update is
  sent for it.
- A client's capabilities are not known after `initialize`, so a request to a client that does
  not support it fails on the client's error, or after 30 s without an answer.
- Streams are not resumable: the suite's unscored `server-sse-polling` (`test_reconnection`) fails.

## Local stdio development

This path imports the backend directly and needs a checked-out repo and a migrated local
Postgres database: the [ten-minute path](../docs/development.md#ten-minute-path-a-local-mcp-server)
sets both up and connects Claude Code. Queries then answer "No facts found."; storing and
finding facts also needs the memory service from the
[full local path](../docs/development.md#full-path-the-web-app-with-memory). It is separate
from hosted access and does not require Clerk.

From the repository root, mint a development token:

```bash
bash scripts/run-check.sh scripts/dev-token.ts
```

The script creates a local org, root scope and write token. It refuses nonlocal databases and
`NODE_ENV=production`. Optional `DEV_TOKEN_PERMISSION=read` issues a read-only token;
`DEV_TOKEN_TTL_HOURS` accepts 1–2160 hours, default 168. Keep the printed token private.

Load it into the environment, then start the server from the repo root:

```bash
printf 'Local Willder token: '
stty -echo; read -r WILLDER_CAPABILITY_TOKEN; stty echo
printf '\n'
export WILLDER_CAPABILITY_TOKEN
npm run --silent mcp
```

For a client-managed stdio process, configure its command as `npm` with the arguments
`--prefix <absolute path to the checkout> run --silent mcp`, and `WILLDER_CAPABILITY_TOKEN`
supplied through its secret environment. `--prefix` runs the server from the checkout from
any working directory; `--silent` keeps npm's script banner off stdout, which carries the MCP
protocol. The process needs the local `.env` service settings; it does not connect to the
hosted service merely because the token came from a hosted workspace. Logs go to stderr;
stdout carries MCP protocol messages.

Without a real extraction-model key, the local read-only smoke path can use the nonempty
placeholder described in `docs/development.md` and return “No facts found.” Populating memory
requires working extraction credentials; this is not an offline ingestion mode.

## Permissions, revocation and errors

Hosted requests resolve identity from the bearer token. Missing, unknown, expired or revoked
tokens return HTTP 401 before tool execution; this does not necessarily produce an
access-audit row. Guarded tool operations evaluate current scope and permission through
`check()` and record their decisions. Validation failures and discovery are not all memory
access decisions, so “every request is audited” is not the contract.

Read tools with a `scopePath` generally fall back to the token scope when it is absent or
malformed. Write tools reject malformed nonempty paths. Copy real scope paths and validate
intent in the client; do not rely on malformed input as a way to select a scope. Contact
operations require root access even when ordinary scoped memory reads succeed.

Token lifetime defaults to seven days and is capped at 90 days on hosted issuance. Revoke
unneeded tokens from Access; issuing a replacement does not disable an old token. Revocation
limits subsequent access and cannot erase data already delivered to a client.

Handle HTTP 401, JSON-RPC `error`, and tool-level `result.isError` separately. HTTP 200 alone
is not tool success. Read retry behavior can differ from writes: after an uncertain write,
check state before repeating it. A source citation or access-audit record is not proof that
the returned fact or generated brief is accurate.
