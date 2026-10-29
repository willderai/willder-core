// contact_search / contact_read / contact_upsert: the smallest contact surface
// an agent capability token can hold. The one rule: all enforcement (tenant
// isolation, capability scope, suppression preservation, revision
// preconditions, idempotency) lives in services/contacts/agent-contacts.ts —
// these handlers only format what it returns.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchContacts, getContact, upsertContact } from "@/services/contacts/agent-contacts";
import { CONTACT_TYPES } from "@/lib/contact-types";
import { orgRootPath } from "@/services/access";
import { recordServedScopes, toolError, type ToolContext } from "./tool-context";

/** Contacts are org-wide records, read only with read on the org root, so a contact
 * served counts as content from the org root for the derived-write rule. */
const CONTACTS_SCOPE = orgRootPath;

export function registerContactSearch(server: McpServer, { ctx, cap, notifyingRead: notifying }: ToolContext): void {
  server.registerTool(
    "contact_search",
    {
      title: "Search contacts",
      description:
        "Search this org's contacts by name/email substring. Requires a capability token with memory.read permission covering the org root.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Substring to match against contact name/email. Omit to list recent contacts."),
        limit: z.number().int().positive().max(50).optional().describe("Max contacts to return (default 10)"),
      },
    },
    notifying(async ({ query, limit }) => {
      try {
        const contacts = await searchContacts(ctx, { query, limit });
        if (!contacts.length) return { content: [{ type: "text" as const, text: "No contacts found." }] };
        await recordServedScopes(cap, [CONTACTS_SCOPE(ctx.orgId)]);
        const lines = contacts.map(
          (c) =>
            `[${c.id}] ${c.name}${c.email ? ` <${c.email}>` : ""} · ${c.type} · rev ${c.revision}${c.suppressed ? " · SUPPRESSED" : ""}`,
        );
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}

export function registerContactRead(server: McpServer, { ctx, cap, notifyingRead: notifying }: ToolContext): void {
  server.registerTool(
    "contact_read",
    {
      title: "Read a contact",
      description:
        "Fetch a single contact by id. Requires a capability token with memory.read permission covering the org root.",
      inputSchema: {
        contactId: z.string().describe("The contact's id"),
      },
    },
    notifying(async ({ contactId }) => {
      try {
        const contact = await getContact(ctx, contactId);
        if (!contact) return { content: [{ type: "text" as const, text: "Contact not found." }] };
        await recordServedScopes(cap, [CONTACTS_SCOPE(ctx.orgId)]);
        const text = [
          `${contact.name}${contact.email ? ` <${contact.email}>` : ""}`,
          contact.title ? `Title: ${contact.title}` : null,
          `Type: ${contact.type}`,
          `Revision: ${contact.revision}`,
          contact.suppressed ? "SUPPRESSED — do not contact." : null,
        ]
          .filter(Boolean)
          .join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}

export function registerContactUpsert(server: McpServer, { ctx, notifying }: ToolContext): void {
  server.registerTool(
    "contact_upsert",
    {
      title: "Create or update a contact",
      description:
        "Create a new contact or update an existing one (by contactId or by matching email). Requires a capability token with memory.write permission covering the org root. Updating an existing contact requires baseRevision (its current revision, from contact_search/contact_read) — a stale value is rejected rather than silently overwritten. idempotencyKey makes a retry of the exact same call safe (no duplicate contact, no double-applied update). A suppressed contact's suppression can never be changed through this tool.",
      inputSchema: {
        idempotencyKey: z
          .string()
          .min(1)
          .describe("A caller-generated key unique to this logical write; reusing it retries safely."),
        contactId: z.string().optional().describe("Update this exact contact. Omit to match/create by email."),
        baseRevision: z
          .number()
          .int()
          .optional()
          .describe("Required when updating an existing contact — its current revision. Omit when creating."),
        name: z.string().optional().describe("Required when creating a new contact."),
        email: z.string().optional(),
        title: z.string().optional(),
        type: z
          .enum(CONTACT_TYPES)
          .optional()
          .describe(`One of ${CONTACT_TYPES.join(", ")} (default: prospect).`),
        description: z.string().optional(),
      },
    },
    notifying(async ({ idempotencyKey, contactId, baseRevision, name, email, title, type, description }) => {
      try {
        const result = await upsertContact(ctx, {
          idempotencyKey,
          contactId,
          baseRevision,
          name,
          email,
          title,
          type,
          description,
        });
        const c = result.contact;
        return {
          content: [
            {
              type: "text" as const,
              text: `${result.action}: [${c.id}] ${c.name}${c.email ? ` <${c.email}>` : ""} · rev ${c.revision}${c.suppressed ? " · SUPPRESSED" : ""}`,
            },
          ],
        };
      } catch (e) {
        return toolError(e);
      }
    }),
  );
}
