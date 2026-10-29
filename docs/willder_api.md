# Willder API routes

Current developer reference, checked against the route handlers on 2026-09-29.
Willder is shared memory for people and AI agents, with scoped access, connected sources,
change notices and Handoff, Architecture and QA workflows. This is a selected route map,
not an OpenAPI schema; the handler and its input validation are authoritative.

## Authentication and response conventions

- Workspace UI routes generally resolve a Clerk session through `requireAccessContext()`.
  They derive the workspace and human actor on the server. Authorization differs by operation;
  being signed in does not automatically grant access to a memory scope.
- Hosted MCP and the change-feed endpoints use a bearer capability token. The server derives
  the workspace and agent from that token, rather than a client-supplied organization ID.
- `check()` records access decisions for guarded operations. Authentication failures, request
  validation, tool discovery and other preliminary work can happen before it; do not expect
  one access-audit row for every HTTP request.
- An accepted ingest is searchable and on the change feed when the call returns (its pgvector
  row and feed event are written before graph extraction is queued); graph entities and
  relations arrive when the queued job finishes. To retry an ingest safely, give it an
  idempotency key (`idempotencyKey` on `memory_ingest`, the `Idempotency-Key` header on
  `POST /api/memory/ingest`; 1 to 255 characters, unique to the write). A repeat with the same
  key and the same input writes nothing and returns the first reply; the same key with different
  input is refused (`422` over REST); a repeat while the first call is still writing is refused
  as in progress (`409` over REST), so retry it again shortly. Keys belong to the calling agent
  or person in its org and do not expire. Without a key, a repeated `memory_ingest` with the
  same scope, name and content is collapsed only when its immediate store write succeeded, and
  every `POST /api/memory/ingest` request is written.
  `/api/memory/ingest` currently returns HTTP 202 with `{ "jobId": "queued" }`; that value is
  not a unique ID for polling `/api/runs/:runId`. Agent run IDs and ingestion acknowledgements
  are different contracts.
- Read both HTTP status and response content. MCP tool failures can return HTTP 200 with
  `result.isError: true`; JSON-RPC protocol failures use an `error` envelope.

## Hosted MCP

`POST /api/mcp` serves stateless Streamable HTTP at `https://willder.ai/api/mcp`.
Send `Authorization: Bearer <capability token>`, JSON content type, and an Accept header
supporting `application/json, text/event-stream`. Use the normal initialization flow in an
MCP SDK, then `tools/list` and `tools/call`. The deployed tool schemas are discoverable through
`tools/list`; they are more precise than a static example here.

Missing, unknown, expired or revoked bearer tokens return HTTP 401 before tool execution.
The endpoint also exports GET and DELETE transport handlers, but this stateless configuration
has no persistent session or server-initiated SSE subscription; do not use GET as a change feed.

| Tool | Purpose | Required access |
|---|---|---|
| `memory_query` | Retrieve matching facts as text, with source/actor attribution when available | Read within the token's scope |
| `memory_entity` | Retrieve an entity and its known facts | Read within the requested scope |
| `memory_ingest` | Queue a note, or record a typed convention/decision using its schema | Write within the requested scope |
| `fact_link_source` | Link a known fact UUID to provenance used for staleness checks | Write within the requested scope |
| `memory_changes` | Read other actors' changes since the agent's server-held position | Read within the requested scope |
| `memory_note` | Post or release a short-lived working note saying what the agent is doing now | Write within the requested scope |
| `get_my_brief` | Retrieve the latest accessible matching brief | Read on the brief's scope |
| `contact_search`, `contact_read` | Find or read contact records | Read at the workspace root |
| `contact_upsert` | Create/update a contact with revision checks | Write at the workspace root |

A source link does not automatically refresh a fact. Tool results may include a task-start
context block and scoped change notices. Delivery occurs on subsequent calls, not by
interrupting an agent or rewriting an earlier answer. Changes made by the caller itself are
excluded from `memory_changes`; read ingested content back with `memory_query` after processing.

Both this endpoint and local `mcp/server.ts` use `mcp/tools.ts`. See
[the MCP reference](../mcp/README.md) for setup and compatibility details.

## Memory and sources

| Method and route | Behavior |
|---|---|
| `GET /api/memory/scopes` | List readable scopes for the UI picker |
| `POST /api/memory/query` | Retrieve facts; body `{ query, limit?, scope? }`; limit is capped at 50 |
| `POST /api/memory/ingest` | Queue extraction; body `{ content, source?, name?, scope? }`; optional `Idempotency-Key` header |
| `POST /api/memory/upload` | Upload material for processing; use the handler's multipart contract |
| `POST /api/memory/chat` | Stream the memory chat workflow; its tool calls use the selected scope. In Ask and Write each sentence is checked as it streams: when no fact served is about the question it says memory has nothing on it, a citation to a fact that was not served is removed, and so is a sentence stating a date or figure its cited facts do not hold (`services/memory/answer-grounding.ts`) |
| `GET /api/memory/stores` | What memory holds in one scope (`?scope=`, default the org root; `memory.read` on it): exact counts and the newest 50 records, chunks and files. With `list` (`records`, `chunks` or `files`), one page of 50 of that store instead: `q` (record title; chunk text, author or source; file or source name), one filter (`kind` brief/source/contact, `version` current/superseded, or `type` source type), `sort` (records `updated`/`title`, chunks `created`, files `synced`/`name`/`chunks`), `order` (`desc` or `asc`) and `page`. Returns `{ items, total, page, pageSize, capped }`; only rows inside the scope are listed or counted, and a searched or filtered chunk list leaves out an erased person's restored copies before it counts (`capped` is true when it stopped counting at 2,000) |
| `GET /api/memory/graph` | Return graph data for the explorer; `?query=` narrows it to the entities whose name or facts contain the text, `?limit=` caps nodes (default 300, at most 500) |
| `GET /api/memory/export` | The signed-in person's export as JSON Lines (`docs/export-format.md`): the whole org and its audit log for an admin of the root, the readable scopes for a member. Erased content is left out; the download is streamed. 403 when the person can read no scope |
| `POST /api/memory/import` | Load an export (the request body) into this org. Admin on the org root, and an org with no memory yet; otherwise 403 or 422 with the reason, and nothing is written. Records the org's erasures cover are left out, and its erasures are re-applied once the import is written; 503 when that re-apply fails, and the import is undone. Returns `{ imported, erased, skippedEdges, auditRowsNotImported, erasuresReapplied }` |
| `GET /api/memory/entities/:id` | Read an entity and facts within the supplied scope |
| `DELETE /api/memory/entities/:id` | Authorized entity removal; inspect the handler's scope and deletion rules |
| `POST /api/memory/entities/merge` | Merge entities through the dedicated merge operation |
| `POST /api/memory/facts` | Queue a human-asserted fact; body `{ fact, scope? }` |
| `PATCH /api/memory/facts/:id` | Remove the old fact and queue corrected text; body `{ fact, scope? }`. Refused before anything is removed with 400 (text Postgres cannot store), 402 (free plan episode cap), 404 (no such fact in this scope) or 409 (another version already replaced it; `currentVersionId` names the version in force). 202 `{ jobId }`; 503 `{ factRemoved: true }` when the fact was removed but the corrected text could not be queued |
| `DELETE /api/memory/facts/:id` | Remove a fact through the guarded store |
| `GET /api/memory/facts/:id/provenance` | Inspect recorded source links |
| `POST /api/memory/facts/:id/provenance` | Add a source link |
| `POST /api/memory/facts/staleness-check` | Check recorded source relationships for stale facts |
| `GET /api/memory/versions/:id` | Read one stored version of a fact or rule by id; no scope parameter, the version carries its own |
| `DELETE /api/memory/conventions/:id` | Retire a rule so it stops being served at session start; the row is kept and stays readable |
| `DELETE /api/memory/conventions/:id/permanent` | Org admin (`access.manage` at the org root) removes a retired rule's row; 409 while it is not retired, while a newer version names it, or when it replaced a version that was never retired; its `supersedes` edges are kept; one visible `record.removed` audit row, with ids only, never the record's name |
| `GET /api/sources` | Org-wide writers only (`memory.write` at the org root). With `page`, one page of 10 searched (`q`: name, destination scope or type name), filtered (`type`, `status`, `kind=connector`) and ordered (`sort`: `created`, `name`, `scope`; `order`), answering `{ sources, total, count, page, pageSize }`; `at=<id>` answers the page holding that source in the view, with `found`. Without `page`, every source, newest first, for API clients |
| `POST /api/sources` | Connect/reconnect a source with provider-specific fields and optional `scopePath` |
| `POST /api/sources/:id/sync` | Request another sync |
| `DELETE /api/sources/:id` | Disconnect and attempt retirement of content attributed to that source |
| `DELETE /api/sources/:id/permanent` | Org admin (`access.manage` at the org root) removes a disconnected source's row; 409 while it is connected or while `GET /api/sources/:id/records` still counts records it wrote, 502 when the memory service cannot answer; one visible `record.removed` audit row, with ids only, never the record's name |
| `GET /api/sources/:id/records` | Count, scope by scope, the records the source still has: chunk rows and embeddings, sync records, change-event text, graph episodes, facts, fact vectors and verbatim nodes, and at its own scope entities nothing links to and facts whose episodes are gone. Counts only; refused unless the caller can read every scope it names; 120 reads a minute per org. Not counted: entity summaries a disconnect clears and briefs it withdraws, since neither names the source |

Connected GitHub sources also re-sync on their own every 30 minutes
(`lib/inngest/source-resync.ts`), so a change at the source arrives without a call to `/sync`.
Each sync reads what changed since the last one and keeps everything older. An item leaves
memory only when GitHub shows it is gone: a README section at the next sync, an issue,
pull request or commit when the sync's deletion check reaches it (20 stored items per sync,
in turn), and every item of a kind the token can no longer read at once. Other source types
re-sync only when this route or a reconnect asks.

Source types handled by the connect route include GitHub, Google Drive, website, Slack,
Figma and PostHog. Each has credential/configuration requirements; route support does not
mean every provider is configured or independently production-verified.

### Conflicting writes

Two writes to the same fact — the same `name` in the same scope — by different writers are
a conflict when they were in flight together: neither was stored more than one second before
the server received the other. A write is received when its request arrives, before its
embedding is computed, so a slow embedding does not turn two writes sent at the same moment
into an ordinary later update. The version the server stored first wins and stays current;
every later version another writer stored in flight with it is recorded as superseded by it with a `supersedes` edge in the dependency graph, and announced on the change
feed as a `supersede` event attributed to the winner's writer, so the losing writer sees it on
its next call. Nothing is deleted: both versions stay readable at
`GET /api/memory/versions/:id`, which reports `status: "current" | "superseded" | "retired"`,
`supersededById` and `supersedesIds`.

Two writes from the same writer — one agent, or one person — never conflict: an agent that
records several facts about one entity at once keeps all of them current. A version whose
writer was not recorded matches no writer, so such versions still conflict with each other. A
`memory_ingest` whose version has already lost when it is stored replies that it was stored and
superseded, naming the winner, instead of "Stored and readable now". Nor do two writes conflict
when one writer had already been served the other's version through an MCP read: the later
one was written knowing the earlier (mcp/README.md, "Writing without `baseVersion`").

A rule write (`kind` with `supersedes`) that loses the same race is still refused — a rule
can be replaced once — but its version is now stored, marked with the winner, and named in
the refusal, so the id the writer is given resolves. Conflict resolution runs on the
request-path write that announces a fact; an ingest announced by the queued job instead
records no winner.

An agent never replaces a rule a person recorded, or confirmed at
`POST /api/memory/conventions/:id/confirm`. Naming one in `supersedes` still stores the agent's
rule, beside the person's and replacing nothing: a decision is then served as a lead next to the
person's settled one, a convention in force next to it, tagged as agent-recorded. The reply
names both. Each refusal leaves one `memory.write` deny row. The service lets only that person
or an owner or admin of the org (their live membership role) replace such a rule and refuses any
other person, though no route lets a person supersede a rule today. Retiring a rule is not
covered.

A rule's text is also stored as a fact, so fact reads serve it too: `memory_query`,
`POST /api/memory/query`, Ask and an agent run's memory read. On each, a fact whose stored chunk
copies a rule in force (an excerpt of it, or a graph fact extracted from it, included) carries
`rule: { ruleId, kind, by, settled }`, by the same rule the task-start block uses, and a copy of
a person's rule is credited to that person by their current name. A copy has the rule's text,
scope and subject. Within one subject (scope and name, case-folded), when the page holds a copy
of a person's rule, that copy comes first and every other stored fact on that subject follows, in
the places that subject's facts already held; one that copies no settled rule is marked
`contradicts: { ruleId, kind }`, with `byPerson: true` when a person wrote it by hand (not a connector's). A graph fact joins a subject only through a copy it was extracted
from. Other facts keep the read's order. `memory_query` lines, Ask's
model context and the agent read say it in words: `[settled decision <id>, a person's]`,
`[lead to verify: decision <id>, not confirmed by a person]`, `[lead to verify: differs from
settled decision <id>]` for any fact there a person did not write, or `[on the subject of settled decision
<id>; recorded by <name>, <date>]` for a person's own. Ask's Retrieved context panel does not show it yet, and the graph reads
(`memory_entity`, `GET /api/memory/entities/:id`, `/api/memory/graph`) do not apply it.

Current memory search uses graph and vector backends, subject to account settings. Relational
records and files are not a completed four-store read path. Fact correction is not an atomic
search replacement: the old fact is removed before the new ingest finishes. Source retirement
can fail and has had historical provenance/in-flight-sync gaps; check the disconnect response
and verify the affected content. Neither deletion nor revocation erases upstream files,
backups, previously delivered answers or external copies.

### Dependency graph

What rests on a record, and which records in a scope rest on something that has since moved on
(`services/memory/dependencies.ts`). A dependency is a brief's citation of a fact
(`brief_citations`) or a `derivedFrom`/`dependsOn` edge between two records (`fact_edges`). An
edge is read only when the record at each end is placed inside the requested scope: stored there,
or announced there by the change feed. A declared share's `derivedFrom` edge names a scope rather
than a record and is never one. A source
has moved on when a `supersedes` edge points at it from a replacement placed in the scope, or the
change feed recorded it updated, superseded, deleted or revoked after the dependent was built.

Each route takes `?scope=` (default: the org root; a malformed value is a 403 with a deny row and
no read), makes one audited `memory.read` decision on it, and reads only relations recorded inside
it. A retired brief reads as absent, and no id that reads as erased is returned, as a dependent,
a source or a replacement. Responses quote no fact text, only ids.

`relation = { fromId, toId, kind: "cites" | "derivedFrom" | "dependsOn" | "supersedes", scopePath, createdAt }`,
from the dependent or newer record to what it rests on or replaced.

- `GET /api/memory/facts/:id/edges?scope=` returns `{ scope, recordId, outgoing, incoming, truncated }`.
- `GET /api/memory/facts/:id/what-to-change?scope=` returns `{ scope, recordId, items: [{ recordId,
  distance, path: relation[] }], truncated }`: everything that cites or rests on the record,
  directly or through other records, nearest first (ties: newest relation first), at most 200
  items and 8 steps; `truncated` is also true when either bound left a dependent unvisited.
- `GET /api/memory/scopes/stale?scope=&limit=` returns `{ scope, stale, recommend, truncated }`.
  `stale` is `[{ recordId, sourceId, kind, reason }]`, `reason` either `{ kind: "superseded", at,
  byId }`, counted whenever the replacement was recorded (a replacement that reads as erased is
  not counted; `byId` is the newest direct replacement, which may itself have been replaced
  since, so `edges` on it shows what followed), or `{ kind: "changed", at, op }`, counted only after the dependent was built.
  `recommend` holds one entry per stale record, `{ recordId, dependents, staleSources, latest }`,
  ranked by `dependents` (records in the scope resting on it), then by when it went stale, then
  by id; `limit` is an integer from 1 to 20, default 3, anything else a 400.

`truncated` is true when a query hit its bound of 500 rows, newest first, so a list may be
missing older entries (citations and edges are read by separate queries, so a list can hold up to
1,000). A relation with an end that reads as erased is left out before the bound,
so after an erasure each list and its `truncated` read as if the erased relations had never been
recorded. One case can still say `truncated` early: when at least 1,504 of a query's newest 2,004
relations rest on stored copies the read rule judges erased that no erasure has removed yet (while
an erasure runs, or after a restore whose re-apply has not run). The change feed keeps its events
after an erasure, so a `changed` reason with op `supersede` can still come from a replacement that
was since erased; the replacement itself is never named. The MCP tool `memory_stale` returns the `recommend` list as lines.

What these read is what was recorded. A brief whose cited fact changed text in the graph store
without a change event, or whose connected source re-synced an item, is not listed;
`GET /api/briefs/:id/staleness` checks one brief against the memory service and its sources. A
record resting on a version that reads as erased is not listed either: the list never names an
erased version, and the erasure is what removes content naming the person.

## Access, changes and audit

| Method and route | Behavior |
|---|---|
| `GET /api/access/scopes`, `POST /api/access/scopes` | Read/manage the scope tree |
| `DELETE /api/access/scopes/:id` | Remove a scope subject to the handler's checks |
| `GET /api/access/scopes/:id/readers` | Every person and live token that can read one scope, by the same rules as `check()`; admin of the scope only |
| `GET /api/access/grants`, `POST /api/access/grants` | Read/create scope grants |
| `DELETE /api/access/grants/:id` | Revoke a grant |
| `GET /api/access/capabilities`, `POST /api/access/capabilities` | List/issue agent tokens |
| `DELETE /api/access/capabilities/:id` | Revoke a token |
| `POST /api/access/erasure` | Erase one person (`contactId`, `email` or `entityId`) from the org: contacts, their conversations, ledger snapshots, chunks, graph, briefs naming them and change-feed summaries naming them, and every version written in place of one it removes (a correction, an update based on it, an upstream edit), whatever that version's text says, with the briefs that cite it (`replacementsRemoved`); a Drive file named after them goes whole (`announcedVersionsRemoved`). Their emails, full names and the ids of the versions removed go on a suppression list connector syncs and reads check. Requires `access.manage` on the org root. Answers `202 { requestId, status: "running", statusUrl }` once the request is checked and recorded, and a background job erases the person; poll `statusUrl`. 400 and 403 come back at once and record no request (a 403 writes its audited deny row); 503 when the job could not be queued, and nothing was erased. A request whose job has not finished 30 minutes after it was asked for is queued once more, and failed if it is still running 30 minutes after that, so a lost job does not leave it `running`. Send the same request again to complete a failed one. A failed request writes one `person.erasure_failed` audit row with the sentence the requester is told and never the person, and forgets the person as a completed one does. A completed request writes one `person.erased` audit row; `GET /api/audit` returns its per-store counts as `erasureCounts`, never a value it erased |
| `GET /api/access/erasure/:requestId` | How an erasure request stands: `{ requestId, status: "running" }`; `{ status: "done", requestId, contactsRemoved, snapshotsScrubbed, chunksRemoved, briefsRemoved, changeSummariesScrubbed, replacementsRemoved, announcedVersionsRemoved, rulesRedacted, notesRemoved, graph }`, the counts of its `person.erased` row; or `{ requestId, status: "failed", error }`, after which sending the same POST again completes it. Requires `access.manage` on the org root; 404 when this org has no such request. The request keeps the identifier it names only until it is done or failed |
| `GET /api/changes` | Bearer-authenticated, scoped change feed; optional `after`, `limit`, `scope` |
| `GET /api/changes/notice` | Bearer-authenticated short notice for the optional CLI hook |
| `GET /api/audit` | Access audit records the log shows, 50 a page; `access.manage` on the org root. `page`, `decision` (`allow`/`deny`), `scope`, `actorType` with `actorId`, `ids`, `q` (action, target, reason, token id, or the name or email of the person or name of the agent behind the row, or of the person it records as triggering it; at most 100 characters) and `order` (`desc` or `asc`). Returns `{ entries, total, counts, page, pageSize, totalPages }`; every filter, the search included, applies before the page and the counts. A parameter holding a NUL is a 400 |
| `GET /api/audit/actors` | Actor filters for the audit log |
| `GET /api/audit/timeline`, `GET /api/audit/timeline/:changeId` | Timeline and change details |
| `GET /api/audit/timeline/:changeId/prov` | One change's writer, source, readers and replaced versions as a W3C PROV-JSON document; same gates as the change detail. Identifiers are minted under the namespace `https://willder.ai/ns/prov/`, an identifier that does not need to resolve |

Capability issuance accepts `{ agentId, scopePath?, permission, ttlHours? }`. Scope omission
uses the workspace root; permission is `read`, `write` or `admin`. Lifetime defaults to seven
days and is capped at 90 days. An `admin` token ends two hours after issue, by the server's
clock, whatever `ttlHours` asks, and cannot be extended. Only a signed-in person issues a
token; an agent presenting one is refused. The raw token is returned once and its hash is stored.
A replacement token does not revoke an older one. Token/grant management requires the relevant
scope administration rights; see the handlers for exact checks.

The change feed's `after` is an opaque change ID, not an organization sequence number.
Omitting it resumes from the agent's server-held position. Authorization is checked when
reading the feed. A change notice is not proof that an agent noticed it or changed its action.

A change detail's `replacedById` and `replacesIds` (and the same answers in the PROV-JSON
document and `GET /api/memory/versions/:id`) name the versions a version replaced or was
replaced by. A rule records it when another replaces it. A fact records it for a conflict or
a stale write, an update based on a version, a person's correction (`PATCH
/api/memory/facts/:id`, or a brief correction that overrules an agent's fact) and a connector
item edited upstream; a Drive file's new version is named by its first part. A correction or
an edit is recorded only when both versions are stored in one scope: one made at a broader
scope than the fact was stored in, or synced after its source moved scope, names no
replacement, the same answer as a version nothing replaced. A version whose stored text or
announcement names a person erased from the org, or that an erasure removed by id (a copy a
restored backup put back), is never named; after an erasure itself, a version may still be named
by id, its text blanked. A correction's own `supersede` event says what the corrected fact was
filed under (`corrected: <name>`), or for a graph fact its text (`corrected fact: <text>`), never the corrected text, which is the correction's `create`.
Lineage is recorded from the release that added it; earlier corrections and edits name no
replacement.

## Deleting an org

One rule for both ways it starts (`services/memory/org-deletion`): an owner's request here, or
Clerk's `organization.deleted` at `POST /api/webhooks/clerk`. The org is deleted 7 days
after the request. From the request on, the org's agent tokens are revoked and refused,
people may read but not write, and the database refuses writes to the org's content and
access tables. A final export of the whole org is made for its recipients, recorded when each
trigger happens and never widened: the person who asked, while they are still an owner or
admin; once Clerk deletes the org, its owners and admins of that moment instead (live, or
ended no more than 60 s before Clerk's event, whether Clerk's membership events arrive before
or after it; a person with no `users` row, who never signed in, is not one). A membership
change delivered after Clerk's event can take a recipient off, never add one. A
person removed during the window who belongs to no other org keeps their `users` row until
the deletion runs or is cancelled. An owner can cancel until the 7
days are up, unless Clerk has deleted the org; a cancel restores the revoked tokens and
deletes the export. The first run of a scheduled job (every 15 minutes) after the 7 days
clears the database rows, the graph, the raw files and the export, deletes the Clerk
organization (unless Clerk started or joined the deletion; one already gone counts as deleted),
and writes the receipt.

| Method and route | Behavior |
|---|---|
| `GET /api/org-deletion` | The open deletion of the signed-in person's org, or `null`. Owners and admins |
| `POST /api/org-deletion` | Request the deletion. Body `{ confirm }`, the org's name typed exactly. Owners and admins with `access.manage` on the root; 400 on any other confirmation; 202 with the deletion, or 200 with the one already open |
| `GET /api/org-deletion/mine` | The deletions that name the signed-in person as a recipient, newest first, each `{ deletion, links: { deletion, export } }`; `export` is set while they may download it. Needs a Clerk sign-in only, so a recipient finds a deletion after Clerk deleted the org. Everyone else gets `{ deletions: [] }` |
| `GET /api/org-deletion/:id` | The deletion and, once it has run, its receipt: what was removed from each store and when backups age out. For the people it names and the org's current owners and admins; needs a Clerk sign-in only, so it works after the org is gone. 404 for anyone else, as for an unknown id |
| `POST /api/org-deletion/:id/cancel` | Cancel before the 7 days are up. An owner or admin of the org now, or a person the deletion names who still is one; 403 for anyone else who can see it; 409 once the deletion has started or when Clerk has deleted the org |
| `GET /api/org-deletion/:id/export` | Download the final export (JSON Lines, `docs/export-format.md`) while the deletion is pending. Only its recipients: the person who asked while still an owner or admin, or after Clerk deleted the org its owners and admins of that moment; 404 for anyone else and once it is cancelled or has run |

## Agents, runs and briefs

`GET /api/agents` lists the workspace's configured agents; `POST /api/agents` creates a custom
agent. `GET /api/agents/:id` and `PATCH /api/agents/:id` read/update configuration. Creating or
editing an agent needs `access.manage` at the org root (org owners and admins by default), and a
`memoryScope` or `cron.scope` an edit sets must be a scope the editor can read. Reading an
agent's `systemPrompt` and `settings` needs the same authority: every member sees the roster,
and both GET routes leave those two fields out for a caller who cannot manage access. A `cron` sent
with `enabled: false` and an empty scope is stored as a cleared sweep (`null`). Seeded roles
are Handoff, Architecture and QA. Use their dedicated routes; the older `/:id/run` endpoint
is not a general dispatcher for these roles.

A deactivated agent (`PATCH /api/agents/:id` with `active: false`) does no new work: every
route below that starts, follows up, answers or edits a run of it returns 409 and writes
nothing, and a run already under way fails at its next step. Reactivating the agent lets new
runs start; a run stopped by the switch stays failed.

| Method and route | Behavior |
|---|---|
| `POST /api/agents/:id/handoff` | Generate and persist a briefing; requires `scopePath` and `granteeName`; optional `granteeRole`, `context`, `fanOut` |
| `POST /api/agents/:id/architecture` | Generate/persist a plan and surface disputes; requires `scopePath`; optional `title`, `context` |
| `POST /api/agents/:id/qa` | Run a QA review; requires `target.baseUrl`; optional target settings, `focus`, `mode`, `scopePath` |
| `POST /api/agents/:id/plan-interactive` | Start an interactive architecture-planning run |
| `POST /api/agents/:id/run-interactive` | Start an interactive QA run |
| `POST /api/agents/:id/plan-manager`, `POST /api/agents/:id/run-manager` | Manager variants; availability and fan-out depend on configuration |
| `GET /api/agents/:id/runs` | Run history the caller may read, newest first: `limit` (1-100, default 20), `status` (`running`, `completed`, `failed`), `order` (`desc` or `asc`), `q` (campaign, contact or prospect name). Returns `{ runs, total }`; `total` counts only matching runs the caller may read |
| `GET /api/agents/:id/runs/:runId/audit` | Audit records associated with a run |
| `GET /api/runs/:runId`, `GET /api/runs/:runId/stream` | Run state and the run's SSE stream |
| `POST /api/runs/:runId/answer`, `POST /api/runs/:runId/reply`, `POST /api/runs/:runId/edit` | Respond to or edit an interactive run using the relevant handler's schema |
| `GET /api/briefs/:id` | Authenticated, scope-checked brief read; not a public share URL |
| `DELETE /api/briefs/:id` | Org admin (`access.manage` at the org root) removes a brief, withdrawn or not; one visible `record.removed` audit row, with ids only, never the record's name |
| `GET /api/briefs/:id/staleness` | Inspect whether the brief's grounding may be stale, including each cited fact's status (`current`, `changed`, `superseded`, `gone`, `unknown`) |
| `POST /api/briefs/:id/acknowledge`, `POST /api/briefs/:id/correct` | Record acknowledgement or corrections. A correction is refused with 402 at the free plan episode cap before anything is searched or removed. One that overrules an agent's fact removes it first; if the removal fails, the correction is still recorded and the error says so; 503 `{ factRemoved: true }` when the fact was removed but the correction could not be queued |
| `POST /api/briefs/:id/persist` | Persist supported brief content through its authorized workflow |
| `POST /api/briefs/:id/export-doc` | Export through the configured Google Drive integration |
| `DELETE /api/briefs/:id/retirement[?sourceId=]` | Admin (`access.manage` on the brief's scope) waives one moved or disconnected source that withdrew a brief (`sourceId` required when several did); the brief reads again once no source withdraws it; refused when the brief's recorded provenance names that source, or when the retirement was recorded before per-source tracking |

Handoff and Architecture require readable grounding scopes. QA can run without memory; when
an optional valid `scopePath` is supplied, the caller's access is checked before grounding.
QA target options include `allowedHosts`, `openApiUrl` and `authHeader`; mode is `api` or
`browser`. URL/network restrictions still apply. Review generated plans, reports and identified
contradictions rather than treating agent output as a verified fact.

Fact disputes have their own workflow: `GET /api/facts/disputes` and
`POST /api/facts/disputes/:id/resolve`. Their existence is separate from the former outreach
approval inbox.

## Supporting routes and retained earlier workflows

- Accounts and contacts remain available through `GET`/`POST /api/accounts` and
  `/api/contacts`, plus `GET`/`PATCH`/`DELETE` on their `/:id` routes. Enrichment routes and
  `POST /api/contacts/from-research` also remain. These are supporting business records.
  Creating, editing or deleting an account needs `memory.write` at the org root, as creating a
  contact does.
- `POST /api/agents/:id/prospect` retains prospect research. `POST /api/agents/:id/run`
  retains copy generation for a required `contactId` and streams SSE progress/results.
  These earlier outbound handlers are not the main shared-memory onboarding workflow.
- Integration connections use `GET /api/integrations`,
  `POST /api/integrations/:id/connect`, `GET /api/integrations/:id/callback` and
  `DELETE /api/integrations/:id`; inspect provider-specific handlers for their auth contracts.
  `GET /api/integrations?provider=&page=` (any member) answers one provider's connected
  accounts 10 a page, searched (`q`: address, workspace name or account id) and ordered
  (`sort`: `created`, `account`; `order`), with `attempts`: the newest pending, errored and
  disconnected row, never a token.
- Billing uses `GET /api/billing`, `POST /api/billing/checkout` and
  `POST /api/billing/portal`. `GET /api/billing/usage` lists accepted-artifact usage 25 a
  page in the scopes the caller may read: `q` (scope path or artifact type), `type`, `sort`
  (`date` or `credits`), `order` and `page`; it returns `{ rows, total, readable, page,
  pageSize }`, and `overage` is null for a caller whose grants do not cover the org root.
- Workspace settings include `/api/settings/memory-chat`, `/api/settings/members`,
  `/api/settings/aliases` and `/api/settings/org-roles`. Their handlers define available methods.
  `GET /api/settings/members` lists the org's live members to any member: `q` (name or
  email), `role`, `sort` (`name`, `role` or `joined`), `order` and, for pages of 25, `page`;
  it returns `{ members, total, memberCount }`, counting live memberships of the org only.
- Provider webhooks currently include `POST /api/webhooks/clerk`,
  `POST /api/webhooks/stripe` and `POST /api/webhooks/github-secret-scanning`, each with
  its own verification flow. `/api/inngest` serves the job SDK.

The old campaign/draft approval API, `/api/me`, `/api/org`, generic
`/api/settings` and `/api/users`, `/api/webhooks/mailbox`, git-push `/api/webhooks/github`,
and `/api/briefs/:id/diagram-link` are absent from the current route tree. Historical design
notes mentioning them are not current endpoint documentation. Draft/campaign MCP tools are
also absent from `mcp/tools.ts`.
