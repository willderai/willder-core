/**
 * The list queries of the Settings page's org roles and entity aliases, shared by
 * their routes (GET /api/settings/org-roles?page=, GET /api/settings/aliases?page=)
 * and their panels, so the two cannot offer different orders or filter values; and
 * the refusal their save and remove routes answer with.
 */
import type { AccessListQuery, AccessListSpec } from "./access-lists";

/** Rows on one page of either table. */
export const SETTINGS_PAGE_SIZE = 25;

/** Org roles search by title, person or alias, and order by title or person. */
export const ORG_ROLE_LIST_SPEC = {
  sorts: ["role", "person"],
  defaultOrder: "asc",
  filters: {},
} as const satisfies AccessListSpec;

/** The entity types an alias can name. */
export const ALIAS_ENTITY_TYPES = ["user", "account", "contact", "org"] as const;

/** Aliases search by canonical name, type or alias, filter by type, and order by name, type or date added. */
export const ALIAS_LIST_SPEC = {
  sorts: ["name", "type", "created"],
  defaultOrder: "asc",
  filters: { type: ALIAS_ENTITY_TYPES },
} as const satisfies AccessListSpec;

export type AliasListQuery = AccessListQuery<typeof ALIAS_LIST_SPEC>;

/**
 * What a refused save or remove answers, the text the panel shows after "Could not
 * remove …". The same for every refused caller (a member, an admin with no grant at
 * the org root, an admin who may only read it), and decided before any row is looked
 * up, so it names what the change needs and nothing about the org.
 */
export const WRITE_REFUSED = {
  roles: "only an admin with write access to the organization can change roles",
  aliases: "only an admin with write access to the organization can change aliases",
} as const;
