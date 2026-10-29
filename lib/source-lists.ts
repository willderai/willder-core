/**
 * The list queries of the Integrations page's sources (GET /api/sources?page=), shared
 * by the route and the Knowledge sources and Connectors panels, so the two cannot offer
 * different orders, filters or type names.
 */
import type { AccessListQuery, AccessListSpec } from "./access-lists";

/** Source cards on one page. */
export const SOURCE_PAGE_SIZE = 10;

export const SOURCE_TYPES = ["gdrive", "website", "slack", "figma", "posthog", "github"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** The types the Connectors panel lists: the ones connected by pasting a token or signing in. */
export const CONNECTOR_SOURCE_TYPES = ["slack", "figma", "posthog", "github"] as const satisfies readonly SourceType[];

/** What a type is called on screen; a search matches these names too. */
export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  gdrive: "Google Drive",
  website: "Website",
  slack: "Slack",
  figma: "Figma",
  posthog: "PostHog",
  github: "GitHub",
};

export const SOURCE_STATUSES = ["active", "syncing", "error", "disconnected"] as const;

/**
 * Sources search by name, destination scope or type name, filter by type, status and
 * kind (`connector` keeps the Connectors panel's types), and order by date connected,
 * name or destination scope.
 */
export const SOURCE_LIST_SPEC = {
  sorts: ["created", "name", "scope"],
  defaultOrder: "desc",
  filters: { type: SOURCE_TYPES, status: SOURCE_STATUSES, kind: ["connector"] },
} as const satisfies AccessListSpec;

export type SourceListQuery = AccessListQuery<typeof SOURCE_LIST_SPEC>;

/** The types whose on-screen name contains `search`, case-insensitively. */
export function typesNamed(search: string): SourceType[] {
  const needle = search.toLowerCase();
  return SOURCE_TYPES.filter((type) => SOURCE_TYPE_LABEL[type].toLowerCase().includes(needle));
}
