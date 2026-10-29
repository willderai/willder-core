/**
 * The list query of one provider's connected accounts on the Integrations page
 * (GET /api/integrations?provider=&page=), shared by the route, the mailbox cards and
 * the Slack workspace card, so they cannot offer different orders.
 */
import type { AccessListQuery, AccessListSpec } from "./access-lists";

/** Accounts on one page of a provider's card. */
export const ACCOUNT_PAGE_SIZE = 10;

export const INTEGRATION_PROVIDERS = ["gmail", "outlook", "slack", "figma"] as const;
export type IntegrationProviderName = (typeof INTEGRATION_PROVIDERS)[number];

/**
 * Connected accounts search by the name they show (the mailbox address, the Slack
 * workspace, or the provider's account id) and order by date connected or that name.
 */
export const ACCOUNT_LIST_SPEC = {
  sorts: ["created", "account"],
  defaultOrder: "desc",
  filters: {},
} as const satisfies AccessListSpec;

export type AccountListQuery = AccessListQuery<typeof ACCOUNT_LIST_SPEC>;
