// The hosted MCP URL, the request examples and the tool reference the docs and the README
// tests share.
//
// The one rule this file enforces: every example reads the token from
// WILLDER_TOKEN; none inlines one.
/** The hosted MCP endpoint every example targets. */
export const MCP_URL = "https://willder.ai/api/mcp";

/**
 * Asks for the token without echoing it and exports it as WILLDER_TOKEN. Written for any
 * POSIX shell: `read -p` means something else in zsh, the macOS default.
 */
export const LOAD_TOKEN_COMMAND =
  "printf 'Willder token: '\nstty -echo; read -r WILLDER_TOKEN; stty echo\nprintf '\\n'\nexport WILLDER_TOKEN";

/**
 * Connects Claude Code in one command. The double quotes let the shell put the token in, so
 * Claude Code keeps it in its own settings (~/.claude.json), never in the project.
 */
export const CLAUDE_MCP_ADD_COMMAND = `claude mcp add --transport http willder ${MCP_URL} \\\n  --header "Authorization: Bearer $WILLDER_TOKEN" \\\n  --header "X-Willder-Tools: coding"`;

/**
 * A project `.mcp.json` that names the variable, not the token: Claude Code reads it at connect
 * time. X-Willder-Tools: coding lists the four tools a coding agent calls (mcp/tool-set.ts).
 */
export const CLAUDE_MCP_JSON = {
  mcpServers: {
    willder: {
      type: "http",
      url: MCP_URL,
      headers: { Authorization: "Bearer ${WILLDER_TOKEN}", "X-Willder-Tools": "coding" },
    },
  },
};

/**
 * The same `.mcp.json` with the optional X-Willder-Task header, exactly the entry `willder
 * init` writes. `:-` sends an empty header, which the server reads as no task, when
 * WILLDER_TASK is unset.
 */
export const CLAUDE_MCP_JSON_WITH_TASK = {
  mcpServers: {
    willder: {
      ...CLAUDE_MCP_JSON.mcpServers.willder,
      headers: { ...CLAUDE_MCP_JSON.mcpServers.willder.headers, "X-Willder-Task": "${WILLDER_TASK:-}" },
    },
  },
};

/** Names the task for one terminal before Claude Code starts: the header and the hook both read it. */
export const NAME_TASK_COMMAND = "export WILLDER_TASK=PROJ-142\nclaude";

/**
 * The hook files `willder init` copies into a project, which the site also serves at
 * /hooks/<file> (app/hooks/[file]/route.ts) so a project can install them without this
 * repository. willder-changes.mjs is the hook; it imports the others, directly or through each other.
 */
export const PUBLISHED_HOOK_FILES = [
  "willder-changes.mjs",
  "willder-capture.mjs",
  "willder-handoff.mjs",
  "willder-redact.mjs",
  "willder-test-commands.mjs",
  "willder-touches.mjs",
  "willder-transcript.mjs",
] as const;

/** Printed by {@link HOOK_INSTALL_COMMAND} only when every file downloaded. */
export const HOOK_INSTALLED_LINE = "Willder hook installed.";

/**
 * Downloads the hook files into the project's .claude/hooks. One `&&` chain, so the first
 * failed download stops it and the success line never prints; it never exits the reader's shell.
 */
export const HOOK_INSTALL_COMMAND = [
  "mkdir -p .claude/hooks &&",
  ...PUBLISHED_HOOK_FILES.map((file) => `curl -fsSL -o .claude/hooks/${file} https://willder.ai/hooks/${file} &&`),
  `echo "${HOOK_INSTALLED_LINE}"`,
].join("\n");

const hookEntry = [
  { hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/willder-changes.mjs"', timeout: 5 }] },
];

/**
 * The hooks block `willder init` writes into .claude/settings.json, capture off. SessionStart runs
 * the hook only when Claude Code compacts the context or the person types /clear, to tell the
 * block at once.
 */
export const CLAUDE_HOOK_SETTINGS = {
  hooks: {
    UserPromptSubmit: hookEntry,
    PostToolUse: hookEntry,
    SessionStart: [{ matcher: "compact|clear", ...hookEntry[0] }],
  },
};

/** The JSON-RPC body of a `tools/list` call. */
export const LIST_REQUEST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
/** The JSON-RPC body of a `memory_query` tool call. */
export const QUERY_REQUEST = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "memory_query", arguments: { query: "What is the agreed launch date for Project Atlas?", limit: 5 } },
};

/** A curl command posting `body` to the MCP endpoint, with the token read from the environment. */
export function curlExample(body: object) {
  return `curl '${MCP_URL}' \\\n  -H "Authorization: Bearer $WILLDER_TOKEN" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  --data '${JSON.stringify(body)}'`;
}

type Field = { name: string; required?: boolean; detail: string };
type ToolDoc = {
  name: string;
  purpose: string;
  permission: "read" | "write";
  fields: Field[];
  example: Record<string, unknown>;
  result: string;
};
const scope: Field = {
  name: "scopePath",
  detail: "Optional string. Copy an existing scope path from Access. Defaults to the token scope.",
};
const ifRevision: Field = {
  name: "ifRevision",
  detail:
    "Optional string. The revision from your last identical call. If the answer is unchanged you get a short receipt instead of the answer again.",
};
const limit = (count: number): Field => ({
  name: "limit",
  detail: `Optional integer from 1 to 50. Defaults to ${count}.`,
});

// Deliberately independent of DB/runtime imports. Contract tests compare this
// public reference and its examples with the real registered tool schemas.
export const TOOL_DOCS: ToolDoc[] = [
  {
    name: "memory_query",
    purpose: "Find facts relevant to a question.",
    permission: "read",
    fields: [
      { name: "query", required: true, detail: "String. A focused question in plain language." },
      limit(10),
      scope,
      ifRevision,
    ],
    example: QUERY_REQUEST.params.arguments,
    result:
      "Text bullets, one line per fact, each naming the connected source or actor it came from (‘— uncited’ when the fact carries neither) and, when available, its validity date, then a ‘revision:’ line. An empty result says ‘No facts found.’ When the question names a specific value (a number of three or more digits, quoted text, or a name of two or more capitalized words) that no memory you can read holds, a fixed ‘Note: no memory you can read holds…’ line follows the facts; it never repeats the value, and the result's _meta ‘willder/unheldValues’ lists those values by their position in the question. Sending that revision back as ifRevision returns ‘Unchanged since revision …’ instead of the same answer. A bullet that answers from one stored version ends with ‘· version <id>’: pass that id as memory_ingest's baseVersion to update the fact. A bullet a connected source synced from one item names it with ‘· item <id>’, before any version: the id that item's change notices name. This tool returns no graph fact UUIDs.",
  },
  {
    name: "memory_entity",
    purpose: "Read a known entity and its facts.",
    permission: "read",
    fields: [
      {
        name: "entityId",
        required: true,
        detail: "String. The ID of an existing entity you are authorized to access.",
      },
      scope,
      ifRevision,
    ],
    example: { entityId: "replace_with_entity_id" },
    result:
      "Text with the entity name, type, optional summary and facts, then a ‘revision:’ line, or ‘Entity not found.’ Sending that revision back as ifRevision returns ‘Unchanged since revision …’ instead of the same answer. The tool does not search for IDs by name.",
  },
  {
    name: "memory_version",
    purpose: "Read one stored version of a fact or rule by id.",
    permission: "read",
    fields: [
      {
        name: "versionId",
        required: true,
        detail: "Nonempty string after trimming. The version's id, as a change notice reported it.",
      },
    ],
    example: { versionId: "replace_with_version_id" },
    result:
      "Text naming the version, whether it is current, superseded or retired, the scope it lives in, who wrote it and when, the version that superseded it and the versions it superseded, then its own text. ‘Version not found.’ when this org has no such version or it lives in a scope you cannot read; the two answers are deliberately alike.",
  },
  {
    name: "memory_changes",
    purpose: "List memory changes other agents and people made since you last looked.",
    permission: "read",
    fields: [{ name: "limit", detail: "Optional integer, 1 to 50. Max changes to return (default 20)." }, scope],
    example: {},
    result:
      "One line per change, oldest first: what happened, the record, who did it, and a short summary of the record's title. ‘No changes.’ when nothing is new. Only changes inside your token's scope are listed; changes elsewhere are not counted or hinted at. There is no cursor to pass: the server holds your position and advances it before it answers, so calls you make one after another never return the same change twice. The ‘more changes waiting’ line appears only when a change you may read really does exist past this page.",
  },
  {
    name: "memory_note",
    purpose: "Tell other agents in your scope what you are working on right now.",
    permission: "write",
    fields: [
      {
        name: "kind",
        required: true,
        detail: "One of: claim (I am doing this), intent (about to try this), status, question.",
      },
      {
        name: "task",
        detail:
          'Optional string, at most 512 characters. What the note is about. Two claims on the same task, compared without regard to case, collide. Defaults to the task the session names in _meta["willder/task"]; a post that names neither is refused.',
      },
      {
        name: "body",
        detail:
          "Optional string, at most 280 characters. One line saying what you are doing. Required to post, except a claim that carries touches; ignored on release.",
      },
      {
        name: "expiresInMinutes",
        detail:
          "Optional integer, 1 to 240. How long the note stays live (default 30). Posting the same kind on the same task again renews it from now.",
      },
      {
        name: "action",
        detail: "Optional. ‘post’ (the default) or ‘release’, which ends your live note of this kind on this task.",
      },
      {
        name: "touches",
        detail:
          'Optional, a claim only: the files you are editing, as "file:<repo>/<path>", at most 64. Sent with a body they replace the claim\'s earlier list; sent without one, as the hook sends them, they are added to it. A touch that is not a file node is left out and counted. Paths only. Recorded only where the org has claim overlap turned on. The Claude Code hook sends them for you when WILLDER_CLAIM_TOUCHES=on.',
      },
      scope,
    ],
    example: {
      kind: "claim",
      task: "the ingest retry fix",
      body: "Reproducing the duplicate write before changing anything.",
      expiresInMinutes: 60,
    },
    result:
      '‘Posted claim <id> on "<task>" in <scope>, live until <time>.’, or ‘Renewed …’ for a note you already had live. When another agent already holds a live claim on the same task in a scope you can read, the reply adds ‘Detected 1 earlier live claim on this task…’ and names that agent, when it claimed, until when and its line. Both claims are kept; nothing decides between them. A claim with touches that shares a file with another agent\'s live claim on other work adds ‘Overlapping files detected with 1 other live claim…’, naming that claim and the shared files, and that agent hears of it on its next tool call when its own scope covers both claims (one in a sibling scope is not told); again nothing decides between them. After the org turns claim overlap off, overlaps already recorded keep showing until the claim that made them ends. Other agents see your note on their next tool call and at the start of their next session, until it expires or you release it. A note is not a fact: memory_query never returns it.',
  },
  {
    name: "memory_ingest",
    purpose: "Add a note to your scope's memory.",
    permission: "write",
    fields: [
      { name: "content", required: true, detail: "Nonempty string. The note or observation to store." },
      { name: "name", required: true, detail: "Nonempty string. A name for the subject of the note." },
      scope,
      {
        name: "kind",
        detail:
          "Optional. ‘convention’ (how your org does something) or ‘decision’ (a choice later work must follow). Records the note as a rule of the scope, served at the start of every session there. A decision an agent records is a proposal until a person confirms it from the link in the reply. Omit for an ordinary note.",
      },
      {
        name: "supersedes",
        detail:
          "Optional string, with kind. The id of the rule this one replaces; the old rule stops being served. A rule can be replaced once, by someone who can write its scope. Naming a rule already replaced is refused and nothing is stored; memory_version on that id names the version that replaced it.",
      },
      {
        name: "baseVersion",
        detail:
          "Optional string, without kind. The id of the version of this fact (same name, same scope) you read and are replacing, from memory_query's ‘· version’, memory_version or a change notice. The write replaces that version, unless it copies a rule a person recorded or confirmed: an agent's write is then kept beside it, and the reply says so. When someone else replaced it since, the write is refused with ‘stale_version:’ naming the current version: read it, then write again with that id. A base that is not a version of this fact is refused with ‘unknown_version:’. Omit to add a version that replaces nothing: it is still refused with ‘stale_version:’ when the fact has a version you were never served, stored after the newest one you read or wrote and more than a second before this write; read that version, then write again. A version stored within that second is a concurrent write: the conflict rule settles it, and a losing write is stored and told which version won.",
      },
      {
        name: "role",
        detail:
          "Optional, without kind. What this note is to the task your session names: ‘cause’ (why the task exists or what went wrong), ‘constraint’ (a limit the work must stay inside), ‘decision’ (a choice later work must follow), ‘rejected’ (an option considered and turned down) or ‘progress’ (what was done or where the work stands). The next session of the same task is served its cause, constraint, decision and rejected notes first, then notes with no role, then progress; within each, those most relevant to what the session is doing first, the newest first among equals. Set it whenever you know it. Sent with kind, the write is refused and nothing is stored.",
      },
      {
        name: "occurredAt",
        detail:
          "Optional string. When the content happened, if not now: an ISO-8601 date (2026-03-11, read as midnight UTC) or date-time with an offset (2026-03-11T15:10:00Z). memory_query shows this date on the note's bullet and, between versions of one note (same name, same scope), serves the newest first. A value without an offset, a day the calendar does not have, or a time more than five minutes ahead of the server's clock is refused with ‘invalid_input:’ and nothing is stored; a date is never recorded later than when the note is stored. It dates and orders the note only: graph extraction keeps the server's clock. When the same text is already stored, nothing is written; if its date differs from the one this write would have had, the reply names the version and the date that stands. Omit it and the note is dated by when it was stored.",
      },
      {
        name: "intentionalShareFrom",
        detail:
          "Optional list of up to 20 scope paths. The scopes whose content this write shares on purpose. Willder records which scopes each agent's session was shown content from; a write into a scope after the session read a scope outside it (a sibling, or a parent) is refused with ‘derived_write:’, nothing is stored, and the refusal names the scopes to declare. Send them here to share anyway: the note is stored, a ‘Shared content from a restricted scope’ row is written to the source scope's audit log, the note is marked ‘shared from a restricted scope’ for readers who cannot read the source (readers who can see its name), and the source scope's readers are told on their change feed. A declared scope covers what the session read inside it. Naming a scope the session did not read, whether or not it exists or you may read it, or one inside the target, is refused. A session is your agent's run of memory calls across all its connections and tokens; it ends after 30 minutes with no memory read or write.",
      },
      {
        name: "idempotencyKey",
        detail:
          "Optional string, 1 to 255 characters. A key you generate, unique to this write. Retrying the identical call with the same key writes nothing and returns the first call's reply; the same key with any argument changed is refused; a retry while the first call is still writing is refused with ‘still in progress’, so retry again shortly. Keys belong to your agent in your org and do not expire.",
      },
    ],
    example: {
      name: "Project Atlas",
      content: "Example only: the team agreed to launch Project Atlas on 15 October 2026.",
      idempotencyKey: "replace_with_idempotency_key",
    },
    result:
      "‘Stored. Queued for ingest — will appear in memory shortly.’ This confirms queue acceptance. It does not confirm that extraction finished or that the note is searchable. To retry a call whose reply you lost, send it again with the same idempotencyKey. When the note is readable at once, the reply says so and ends with ‘Version: <id>’, the id a later update passes as baseVersion. With kind, the reply starts with the new rule's id, which is what a later supersedes names.",
  },
  {
    name: "fact_link_source",
    purpose: "Associate a known fact with a code source.",
    permission: "write",
    fields: [
      { name: "graphitiFactUuid", required: true, detail: "Nonempty string after trimming. An existing fact UUID." },
      { name: "sourceType", required: true, detail: "One of: pr, commit, file." },
      { name: "sourceRef", required: true, detail: "Nonempty string after trimming. The source reference." },
      {
        name: "recordedRevision",
        detail: "Optional string, nonempty after trimming. The revision recorded with the source.",
      },
      scope,
    ],
    example: {
      graphitiFactUuid: "replace_with_fact_uuid",
      sourceType: "file",
      sourceRef: "docs/launch.md",
      recordedRevision: "replace_with_commit_sha",
    },
    result:
      "Text confirming the link. This records provenance for staleness checks; it does not synchronize the source or edit the fact. You need a known fact UUID: memory_query and memory_entity do not currently return one. Refused with derived_write: when this session read a scope outside the link's scope; a link cannot declare a share.",
  },
  {
    name: "get_my_brief",
    purpose: "Read a generated brief.",
    permission: "read",
    fields: [{ name: "briefId", detail: "Optional string. The ID of an existing brief." }, scope],
    example: {},
    result:
      "Markdown containing the title, scope, summary and sections, with a recipient or Google Doc link when present. Without briefId, returns the latest brief at the selected scope, or ‘No brief found for this scope.’ With an ID, access is checked against the brief’s own scope.",
  },
  {
    name: "memory_stale",
    purpose:
      "What to refresh next: records whose cited or source fact has been replaced, or changed after they were built.",
    permission: "read",
    fields: [scope, { name: "limit", detail: "Optional integer, 1 to 20. Max records to return (default 3)." }],
    example: {},
    result:
      "One line per record, most depended-on first: the record ID, the fact it cites or rests on, whether that fact was replaced (and by what) or updated, superseded, deleted or revoked, when, and how many records rest on it. ‘Nothing stale in <scope>.’ when there is none. A last line says so when a query reached its 500-row bound and older records were not checked. Only what was recorded is read: a brief whose cited fact changed text without a recorded change, or whose connected source re-synced, is not listed; GET /api/briefs/:id/staleness checks one brief fully.",
  },
  // contact_search/contact_read/contact_upsert are all scoped to the token's
  // org root — see services/contacts/agent-contacts.ts's file header for why
  // contacts have no narrower per-row scope to check against.
  {
    name: "contact_search",
    purpose: "Search this org's contacts by name or email substring.",
    permission: "read",
    fields: [
      {
        name: "query",
        detail: "Optional string. Substring to match against contact name/email. Omit to list recent contacts.",
      },
      limit(10),
    ],
    example: { query: "replace_with_search_text" },
    result:
      "Text rows containing contact ID, name, email, type and revision, flagged SUPPRESSED when set, or ‘No contacts found.’",
  },
  {
    name: "contact_read",
    purpose: "Fetch a single contact by id.",
    permission: "read",
    fields: [{ name: "contactId", required: true, detail: "String. The contact's id." }],
    example: { contactId: "replace_with_contact_id" },
    result:
      "Text with the contact's name, title, type, revision, and a SUPPRESSED warning when set, or ‘Contact not found.’",
  },
  {
    name: "contact_upsert",
    purpose: "Create a new contact or update an existing one.",
    permission: "write",
    fields: [
      {
        name: "idempotencyKey",
        required: true,
        detail: "Nonempty string. A caller-generated key unique to this logical write; reusing it retries safely.",
      },
      { name: "contactId", detail: "Optional string. Update this exact contact. Omit to match/create by email." },
      {
        name: "baseRevision",
        detail:
          "Optional integer. Required when updating an existing contact — its current revision, from contact_search/contact_read. Omit when creating.",
      },
      { name: "name", detail: "Optional string. Required when creating a new contact." },
      { name: "email", detail: "Optional string." },
      { name: "title", detail: "Optional string." },
      {
        name: "type",
        detail:
          "Optional. One of prospect, customer, investor, partner, advisor, vendor, team, other (default: prospect).",
      },
      { name: "description", detail: "Optional string." },
    ],
    example: {
      idempotencyKey: "replace_with_idempotency_key",
      name: "Jane Prospect",
      email: "jane@example.com",
      type: "prospect",
    },
    result:
      "Text confirming ‘created’ or ‘updated’ with the contact's id, name and new revision. A suppressed contact's suppression can never be changed through this tool. A stale baseRevision is rejected rather than silently overwritten.",
  },
  {
    name: "send_feedback",
    purpose: "Send a bug report, a request or praise privately to the people who run this server.",
    permission: "read",
    fields: [
      { name: "kind", required: true, detail: "One of bug, request, praise, other." },
      {
        name: "message",
        required: true,
        detail: "Nonempty string, at most 4,000 characters. The feedback, in the user's words where possible.",
      },
      {
        name: "context",
        detail: "Optional string, at most 2,000 characters. What the user was trying to do when this came up.",
      },
    ],
    example: {
      kind: "bug",
      message: "memory_query returned nothing for a fact I wrote a minute ago.",
      context: "Checking that a write from one agent reaches another.",
    },
    result:
      "Text confirming it was sent, with a reference id. It reads and writes no memory and is never shown to another workspace. An agent that already sent 20 items in the last hour is refused until the hour passes.",
  },
];
