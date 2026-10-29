// memory_note: post or release a working note, one line about what this agent is doing
// right now (services/memory/working-notes.ts). Other agents in the scope see it on
// their next tool call and at the start of their next task.
//
// The one rule: a claim on a task another agent has already claimed is stored and the
// reply names the earlier claim. That is detection and notification only; the reply
// never says the overlap was resolved, because nothing resolved it.
//
// A post is a write its scope's agents are shown, so it falls under the derived-write rule
// (mcp/derived-write.ts): an agent id that was ever shown a scope outside the target's subtree cannot
// post there. A note has no way to declare a share, so that post is refused. A release
// removes the caller's own note and carries no content, so it is not checked. A claim's
// reply shows other agents' earlier claims, from any scope the caller may read, so their
// scopes join the caller's session as any read does.
//
// A claim may also name `touches`, the files its agent edits; the Claude Code hook sends them
// from the agent's Edit and Write calls (cli/hooks/willder-touches.mjs). The reply then names
// other agents' live claims that share one of the files the post added, worded like a
// collision: detected and notified, never resolved (services/memory/claim-overlap.ts).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolveCallerScopePath } from "@/services/access";
import { MAX_TOUCHES, sharedList } from "@/services/memory/claim-overlap";
import {
  NOTE_BODY_MAX_CHARS,
  NOTE_DEFAULT_MINUTES,
  NOTE_MAX_MINUTES,
  WORKING_NOTE_KINDS,
  InvalidWorkingNoteError,
  noteTime,
  postWorkingNote,
  releaseWorkingNote,
  type ClaimOverlap,
  type PostedWorkingNote,
  type WorkingNoteView,
} from "@/services/memory/working-notes";
import { authorizeUndeclaredWrite } from "../derived-write";
import { recordServedScopes, toolError, type ToolContext } from "./tool-context";

export function registerMemoryNote(server: McpServer, { ctx, cap, notifyingAlongside, taskOf }: ToolContext): void {
  server.registerTool(
    "memory_note",
    {
      title: "Say what you are working on now",
      description: `Post a short-lived working note so other agents in your scope see, on their next tool call, what you are doing right now: a 'claim' (I am doing this), an 'intent' (about to try this), a 'status' or a 'question'. A note expires after ${NOTE_DEFAULT_MINUTES} minutes unless you set expiresInMinutes (at most ${NOTE_MAX_MINUTES}); posting the same kind on the same task again renews it, and action 'release' ends it when you are done. A claim on a task another agent has a live claim on is still stored, and the reply names that earlier claim so you can decide whether to go ahead. Notes are not facts: keep anything worth remembering with memory_ingest. Refused with derived_write: when this agent id was ever shown a scope outside the note's scope (the record never expires, and a note cannot declare a share). Requires a capability token with memory.write permission.`,
      inputSchema: {
        kind: z.enum(WORKING_NOTE_KINDS).describe("claim, intent, status or question."),
        task: z
          .string()
          .optional()
          .describe(
            "What the note is about, e.g. 'the ingest retry fix'. Two claims collide on the same task. Defaults to the task this session names in _meta[\"willder/task\"].",
          ),
        body: z
          .string()
          .optional()
          .describe(
            `One line, at most ${NOTE_BODY_MAX_CHARS} characters. Required to post, except a claim that carries touches; ignored on release.`,
          ),
        expiresInMinutes: z
          .number()
          .int()
          .optional()
          .describe(`How long the note stays live, 1 to ${NOTE_MAX_MINUTES} minutes. Default ${NOTE_DEFAULT_MINUTES}.`),
        action: z
          .enum(["post", "release"])
          .optional()
          .describe(
            "post (the default) creates or renews your note; release ends your live note of this kind on this task.",
          ),
        scopePath: z.string().optional().describe("ltree scope to post in. Defaults to your token's scope."),
        touches: z
          .array(z.string())
          .max(MAX_TOUCHES)
          .optional()
          .describe(
            `For a claim: the files you are editing, as "file:<repo>/<path>", at most ${MAX_TOUCHES}. With a body they replace the claim's earlier list; without one they are added to it. Paths only. Another agent's live claim on other work that edits one of them is named in the reply. Recorded only where the org has claim overlap on.`,
          ),
      },
    },
    // Alongside: the post is the caller's own change, so its notice read need not delay it.
    notifyingAlongside(async ({ kind, task, body, expiresInMinutes, action, scopePath, touches }, extra) => {
      try {
        const named = task ?? taskOf(extra);
        if (named === undefined || named.trim() === "") {
          throw new InvalidWorkingNoteError(
            'name what the note is about: pass task, or name the session\'s task in _meta["willder/task"].',
          );
        }
        // A write: a malformed caller-supplied scope is refused, never widened to the
        // token's own scope (resolveCallerScopePath, as memory_ingest uses it).
        const target = await resolveCallerScopePath(ctx, scopePath, cap, {
          onInvalid: "refuse",
          action: "memory.write",
        });

        if (action === "release") {
          const released = await releaseWorkingNote(ctx, { scopePath: target, task: named, kind });
          const text = released
            ? `Released ${released.kind} ${released.id} on "${released.task}".`
            : `You have no live ${kind} on "${named}" in ${target}; nothing was released.`;
          return { content: [{ type: "text" as const, text }] };
        }

        if (body === undefined && !(kind === "claim" && touches !== undefined)) {
          throw new InvalidWorkingNoteError("a post needs a body: one line saying what you are doing.");
        }
        await authorizeUndeclaredWrite(ctx, cap, target, "working note");
        const posted = await postWorkingNote(ctx, {
          scopePath: target,
          task: named,
          kind,
          body,
          expiresInMinutes,
          touches,
        });
        await recordServedScopes(
          cap,
          [...posted.earlierClaims, ...posted.overlaps.map((o) => o.claim)].map((claim) => claim.scopePath),
        );
        return { content: [{ type: "text" as const, text: postedReply(posted) }] };
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}

/** How the reply's overlap section starts; the Claude Code hook forwards the reply from it on. */
const OVERLAP_HEADING_START = "Overlapping files detected with";

/** Most overlapping claims a reply lists; the count covers them all. */
const MAX_OVERLAPS_LISTED = 5;

/** The reply to a post: what is now live, then any earlier claim on the same task, then any claim sharing files. */
function postedReply({ note, renewed, earlierClaims, touches, overlaps }: PostedWorkingNote): string {
  const lines = [
    `${renewed ? "Renewed" : "Posted"} ${note.kind} ${note.id} on "${note.task}" in ${note.scopePath}, live until ${noteTime(note.expiresAt)}. Post it again to renew it; release it when you are done.`,
  ];
  if (earlierClaims.length > 0) {
    const count = earlierClaims.length;
    lines.push(
      "",
      `Detected ${count} earlier live claim${count === 1 ? "" : "s"} on this task by ${count === 1 ? "another agent" : "other agents"}. ${count === 1 ? "Both claims are" : `All ${count + 1} claims are`} stored; nothing was resolved. Check with ${count === 1 ? "it" : "them"} before duplicating the work:`,
      ...earlierClaims.map(formatEarlierClaim),
    );
  }
  if (touches?.recorded === false) lines.push("", "Touches were not recorded: claim overlap is off for this org.");
  if (touches?.recorded && touches.refused > 0) {
    const one = touches.refused === 1;
    lines.push(
      "",
      `${touches.refused} of the touches ${one ? "was" : "were"} not recorded: ${one ? "it is" : "they are"} not "file:<repo>/<path>" from the repository root.`,
    );
  }
  if (touches?.recorded && touches.withheld > 0) {
    const one = touches.withheld === 1;
    lines.push(
      "",
      `${touches.withheld} of the touches ${one ? "was" : "were"} not recorded: ${one ? "it" : "they"} may hold a secret or an email address.`,
    );
  }
  if (overlaps.length > 0) {
    const count = overlaps.length;
    lines.push(
      "",
      `${OVERLAP_HEADING_START} ${count} other live claim${count === 1 ? "" : "s"} on other work. Each claim is stored; nothing was resolved. Check with ${count === 1 ? "it" : "them"} before changing the same files:`,
      ...overlaps.slice(0, MAX_OVERLAPS_LISTED).map(formatOverlap),
      ...(count > MAX_OVERLAPS_LISTED
        ? [`- and ${count - MAX_OVERLAPS_LISTED} more claims not listed; each was told of this overlap.`]
        : []),
    );
  }
  return lines.join("\n");
}

function formatOverlap({ claim, shared }: ClaimOverlap): string {
  const minutes = Math.max(0, Math.round((Date.now() - claim.createdAt.getTime()) / 60_000));
  return `- ${claim.agentId}'s claim ${claim.id} on "${claim.task}", claimed ${minutes} min ago (live until ${noteTime(claim.expiresAt)}): ${shared.length} shared file${shared.length === 1 ? "" : "s"}: ${sharedList(shared)}`;
}

function formatEarlierClaim(claim: WorkingNoteView): string {
  return `- ${claim.agentId} claimed it at ${noteTime(claim.createdAt)} (note ${claim.id}, live until ${noteTime(claim.expiresAt)}): ${claim.body}`;
}
