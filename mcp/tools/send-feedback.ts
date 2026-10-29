// send_feedback: lets a user report a bug, ask for something, or say what works, from
// inside their AI client. The one rule: it reaches the people who run this server and
// nobody else. It is not a memory tool: it reads and writes no memory, so it carries no
// change or task-start notices.
//
// Because it reads no memory it never reaches check(), the per-call gate every memory
// tool passes through. So it re-resolves its token on every call instead: a stdio
// session resolves the token once at start (mcp/server.ts), and without this a token
// revoked, expired or switched off with its agent mid-session could keep writing here.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  FEEDBACK_CONTEXT_MAX,
  FEEDBACK_HOURLY_LIMIT,
  FEEDBACK_KINDS,
  FEEDBACK_MESSAGE_MAX,
  submitProductFeedback,
} from "@/services/feedback/product-feedback";
import { resolveCapability } from "@/services/access";
import { toolError, type ToolContext } from "./tool-context";

/** Why a call is refused when its token stopped being live after the session began. */
export const TOKEN_NO_LONGER_LIVE =
  "this session's capability token is no longer live (revoked, expired, or its agent was deactivated). Reconnect with a live token.";

export function registerSendFeedback(server: McpServer, { ctx, cap }: ToolContext): void {
  server.registerTool(
    "send_feedback",
    {
      title: "Send feedback to the Willder team",
      description:
        "Send a bug report, a feature request, or praise to the people who run this Willder server. Use it when the user asks to report a problem or request something, or agrees when you offer. Private: it is never posted publicly or shown to other workspaces. Include what the user was trying to do in `context` when you know it. Never include secrets or tokens.",
      inputSchema: {
        kind: z.enum(FEEDBACK_KINDS).describe("bug, request, praise or other."),
        message: z
          .string()
          .trim()
          .min(1)
          .max(FEEDBACK_MESSAGE_MAX)
          .describe("The feedback, in the user's words where possible."),
        context: z
          .string()
          .trim()
          .max(FEEDBACK_CONTEXT_MAX)
          .optional()
          .describe("What the user was trying to do when this came up."),
      },
    },
    async ({ kind, message, context }) => {
      try {
        if (ctx.actor.type !== "agent" || !(await resolveCapability(ctx.actor, ctx.origin))) {
          return {
            content: [{ type: "text" as const, text: `Not sent: ${TOKEN_NO_LONGER_LIVE}` }],
            isError: true,
          };
        }
        const result = await submitProductFeedback({ orgId: cap.orgId, agentId: cap.agentId, kind, message, context });
        if (!result.stored) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Not sent: this agent already sent ${FEEDBACK_HOURLY_LIMIT} items in the last hour. Try again later.`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Sent privately to the Willder team. Reference: ${result.id}` }],
        };
      } catch (e) {
        return toolError(e);
      }
    },
  );
}
